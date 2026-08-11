-- ============================================================
-- 050_responsible_on_arrival.sql — dono na chegada, não na resposta
--
-- A 049 fez a PRIMEIRA RESPOSTA reivindicar a conversa. Está errado
-- para o problema real: com quatro operadores olhando a caixa, uma
-- mensagem nova que chega marcada como "sem responsável" não diz a
-- ninguém o que fazer com ela. A atribuição precisa existir no momento
-- em que a mensagem chega, não depois que alguém tomou a iniciativa.
--
-- E "primeira pessoa a conversar com aquele CLIENTE" é sobre o
-- cliente, não sobre a conversa. Um cliente conhecido que escreve de
-- novo tem que cair com quem já o atendeu; a 049 o devolvia ao limbo
-- toda vez que uma conversa nova era criada.
--
-- A regra de resolução, em ordem:
--
--   1. O OPERADOR DO NÚMERO em que a mensagem chegou. Se o cliente
--      escreveu para a linha do Bruno, era com o Bruno que ele queria
--      falar — é o sinal mais forte que existe sobre a intenção dele,
--      e vence qualquer histórico. É também o que faz "cada setor com
--      seu número" funcionar de forma determinística.
--
--   2. QUEM JÁ ATENDEU ESTE CLIENTE. Numa linha compartilhada o número
--      não identifica ninguém, então a pergunta vira "quem falou com
--      esta pessoa da primeira vez?". Pega a conversa mais antiga do
--      contato que tenha responsável.
--
--   3. NINGUÉM. Cliente novo escrevendo para uma linha que não é de
--      ninguém. Aqui não há resposta honesta a inventar — a conversa
--      fica sem responsável e a interface diz isso. A saída para este
--      caso é de configuração, não de código: dar um operador à linha.
--
-- Design notes
--
--   * O passo 1 é o mesmo dado que a interface já usava como fallback.
--     A diferença é que agora ele fica GRAVADO na chegada em vez de
--     recalculado a cada render — então transferir, arquivar ou trocar
--     o dono do número depois não reescreve o passado.
--
--   * O gatilho da 049 é substituído, não duplicado: a mesma função
--     passa a tratar mensagem de agente (reivindica para quem escreveu)
--     e de cliente (resolve pela regra acima). Duas funções competindo
--     pela mesma coluna seria uma corrida esperando para acontecer.
--
--   * Nada de round-robin. Distribuir automaticamente entre operadores
--     ociosos é uma decisão de operação com consequências reais
--     (alguém recebe um cliente que não conhece), e não é o que foi
--     pedido — o pedido é que fique CLARO com quem o cliente falava.
--
-- Requer a 049 (a coluna `responsible_user_id` vem de lá).
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
--   DROP TRIGGER IF EXISTS on_conversation_resolve_responsible ON conversations;
--   DROP FUNCTION IF EXISTS public.set_conversation_responsible_on_insert();
--   DROP FUNCTION IF EXISTS public.resolve_conversation_responsible(UUID, UUID, UUID);
--   -- e recrie claim_conversation_on_first_reply com o corpo da 049.
-- ------------------------------------------------------------
--
-- Idempotente.
-- ============================================================

-- ============================================================
-- O RESOLVEDOR
--
-- STABLE e sem efeitos: só responde "de quem deveria ser esta
-- conversa". Quem grava é o gatilho.
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_conversation_responsible(
  p_account_id UUID,
  p_contact_id UUID,
  p_config_id UUID
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator UUID;
  v_previous UUID;
BEGIN
  -- 1. De quem é o número em que a mensagem chegou.
  IF p_config_id IS NOT NULL THEN
    SELECT operator_user_id INTO v_operator
    FROM whatsapp_config
    WHERE id = p_config_id
      AND account_id = p_account_id;

    IF v_operator IS NOT NULL THEN
      RETURN v_operator;
    END IF;
  END IF;

  -- 2. Quem atendeu este contato primeiro. `created_at` e não
  -- `last_message_at`: a pergunta é quem falou com ele da PRIMEIRA
  -- vez, não quem falou por último.
  IF p_contact_id IS NOT NULL THEN
    SELECT responsible_user_id INTO v_previous
    FROM conversations
    WHERE account_id = p_account_id
      AND contact_id = p_contact_id
      AND responsible_user_id IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_previous IS NOT NULL THEN
      RETURN v_previous;
    END IF;
  END IF;

  -- 3. Cliente novo numa linha de ninguém.
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.resolve_conversation_responsible(UUID, UUID, UUID)
  OWNER TO postgres;
-- Os três: revogar só de PUBLIC não basta no Supabase. Toda função nova
-- em `public` nasce com EXECUTE concedido DIRETAMENTE a `anon` e
-- `authenticated`, e um grant direto não é alcançado pelo REVOKE em
-- PUBLIC — a função continuaria chamável pelo cliente. Sendo SECURITY
-- DEFINER, ela ignora RLS: qualquer autenticado poderia perguntar de
-- quem é o contato X da conta Y. É o mesmo trio que a 007 e a 012 já
-- usam.
REVOKE ALL ON FUNCTION public.resolve_conversation_responsible(UUID, UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_conversation_responsible(UUID, UUID, UUID)
  FROM anon;
REVOKE ALL ON FUNCTION public.resolve_conversation_responsible(UUID, UUID, UUID)
  FROM authenticated;

-- Serve o passo 2 do resolvedor.
CREATE INDEX IF NOT EXISTS idx_conversations_contact_responsible
  ON conversations(account_id, contact_id, created_at)
  WHERE responsible_user_id IS NOT NULL;

-- ============================================================
-- NA CRIAÇÃO DA CONVERSA
--
-- É aqui que "chegou uma mensagem de alguém novo" vira uma linha na
-- caixa de entrada. BEFORE INSERT para gravar junto, sem um segundo
-- UPDATE e sem uma janela em que a conversa existe sem dono.
--
-- Só preenche o vazio: a transferência (047/049) já insere o elo de
-- destino com responsável, e sobrescrever isso entregaria a conversa
-- de volta a quem a passou adiante.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_conversation_responsible_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.responsible_user_id IS NULL THEN
    NEW.responsible_user_id := resolve_conversation_responsible(
      NEW.account_id, NEW.contact_id, NEW.whatsapp_config_id);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.set_conversation_responsible_on_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_conversation_resolve_responsible ON conversations;
CREATE TRIGGER on_conversation_resolve_responsible
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_conversation_responsible_on_insert();

-- ============================================================
-- NA MENSAGEM
--
-- Substitui o gatilho da 049. Duas situações que ele cobre e a criação
-- da conversa não:
--
--   * uma conversa que já existia sem responsável (toda a base
--     anterior a estas migrations) recebe mensagem nova;
--   * um agente responde numa conversa sem dono — quem responde
--     assume, que era a regra original e continua valendo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_conversation_on_first_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation conversations%ROWTYPE;
  v_resolved UUID;
BEGIN
  -- 'bot' fica de fora: uma resposta automática não é alguém assumindo
  -- o atendimento, e deixar a IA reivindicar faria o cliente ficar
  -- "com" um robô.
  IF NEW.sender_type NOT IN ('agent', 'customer') THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_conversation
  FROM conversations
  WHERE id = NEW.conversation_id;

  IF NOT FOUND OR v_conversation.responsible_user_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF NEW.sender_type = 'agent' THEN
    -- Quem respondeu assume. Sem sender_id não há quem assumir — e o
    -- caminho de envio só passou a gravá-lo junto com a 049.
    v_resolved := NEW.sender_id;
  ELSE
    v_resolved := resolve_conversation_responsible(
      v_conversation.account_id,
      v_conversation.contact_id,
      v_conversation.whatsapp_config_id);
  END IF;

  IF v_resolved IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE conversations
     SET responsible_user_id = v_resolved
   WHERE id = NEW.conversation_id
     AND responsible_user_id IS NULL;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.claim_conversation_on_first_reply() OWNER TO postgres;

-- O gatilho da 049 já aponta para esta função; recriado por segurança
-- caso a 049 tenha sido aplicada parcialmente.
DROP TRIGGER IF EXISTS on_message_claims_conversation ON messages;
CREATE TRIGGER on_message_claims_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.claim_conversation_on_first_reply();

-- ============================================================
-- BACKFILL — conversas que já existem e estão sem dono
--
-- Roda a mesma regra sobre o passado. Conversas numa linha com
-- operador já foram resolvidas pela 049; o que sobra são as da linha
-- compartilhada, que agora podem herdar de outra conversa do mesmo
-- contato.
--
-- Em duas passadas porque a primeira cria os responsáveis dos quais a
-- segunda herda; uma passada só dependeria da ordem das linhas.
-- ============================================================
UPDATE conversations c
   SET responsible_user_id = w.operator_user_id
  FROM whatsapp_config w
 WHERE w.id = c.whatsapp_config_id
   AND w.operator_user_id IS NOT NULL
   AND c.responsible_user_id IS NULL;

UPDATE conversations c
   SET responsible_user_id = resolve_conversation_responsible(
         c.account_id, c.contact_id, c.whatsapp_config_id)
 WHERE c.responsible_user_id IS NULL;
