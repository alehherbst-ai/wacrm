-- ============================================================
-- 046_operators_fix_unique_and_chain.sql — correções das etapas 1 e 2
--
-- Duas coisas que só apareceram ao rodar 044 e 045 contra um banco de
-- verdade. Nenhuma delas dava erro ao aplicar: as duas só se manifestam
-- quando alguém tenta USAR o modelo de operadores.
--
-- ------------------------------------------------------------
-- 1. A CONSTRAINT QUE A 044 NÃO DERRUBOU (impedia o modelo inteiro)
--
-- A 044 derruba `whatsapp_config_account_id_key` — a UNIQUE(account_id)
-- criada pela migration 017. Só que a migration 037 já tinha trocado
-- essa constraint por `whatsapp_config_account_id_provider_key`, uma
-- UNIQUE(account_id, provider). O DROP da 044 portanto não encontrou
-- nada para derrubar (é um DROP ... IF EXISTS, então passou calado), e
-- a constraint que de fato bloqueia o modelo continuou de pé.
--
-- Efeito: conectar um SEGUNDO número uazapi na mesma conta falhava com
-- 23505. Como a conta só tinha um número conectado, nada disso aparecia
-- na interface — a 044 parecia aplicada e correta. O erro só surgiria
-- no dia em que o primeiro operador fosse parear o próprio celular,
-- que é exatamente o propósito da etapa 1.
--
-- A unicidade continua garantida pelos dois índices parciais da 044:
--   - idx_whatsapp_config_operator → um número por operador;
--   - idx_whatsapp_config_house    → no máximo um número da casa.
-- Os dois juntos são mais estritos, por conta, do que a constraint que
-- sai aqui: ela permitia um número 'meta' E um 'uazapi' soltos na mesma
-- conta sem dono; os índices só permitem um número da casa, seja qual
-- for o provedor.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_provider_key;

-- ------------------------------------------------------------
-- 2. TODA CONVERSA NASCE COMO CADEIA DE SI MESMA
--
-- A 045 diz, e depende de, "toda conversa existente vira uma cadeia de
-- um elo só" — mas garante isso com um UPDATE único, executado no
-- momento em que a migration roda. A coluna ficou sem DEFAULT e sem
-- gatilho, então toda conversa criada DEPOIS nascia com
-- `transfer_chain_id` NULL, e o invariante se quebrava sozinho já na
-- primeira mensagem nova.
--
-- Consequência prática: o bloco de histórico herdado
-- (`message-thread.tsx`) desiste quando a cadeia é NULL, e o ramo de
-- cadeia de `can_read_conversation` é pulado — quem recebeu uma
-- transferência deixaria de enxergar elos cujo id de cadeia nunca foi
-- preenchido.
--
-- O gatilho é BEFORE INSERT porque `NEW.id` já vem preenchido pelo
-- DEFAULT da coluna nesse ponto, o que permite apontar a cadeia para a
-- própria linha antes de ela existir. Um DEFAULT na coluna não daria
-- conta: uma expressão de DEFAULT não enxerga as outras colunas da
-- linha, então não há como escrever "o meu próprio id" ali.
--
-- COALESCE, e não atribuição direta: `transfer_conversation` insere a
-- conversa de destino já com a cadeia da origem, e o gatilho não pode
-- sobrescrever isso.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_conversation_chain_default()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.transfer_chain_id := COALESCE(NEW.transfer_chain_id, NEW.id);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.set_conversation_chain_default() OWNER TO postgres;

DROP TRIGGER IF EXISTS set_conversation_chain_default ON public.conversations;
CREATE TRIGGER set_conversation_chain_default
  BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_conversation_chain_default();

-- Recolhe o que já tiver nascido sem cadeia entre a 045 e esta.
UPDATE conversations SET transfer_chain_id = id WHERE transfer_chain_id IS NULL;

-- ------------------------------------------------------------
-- COMO REVERTER
--
--   DROP TRIGGER IF EXISTS set_conversation_chain_default ON public.conversations;
--   DROP FUNCTION IF EXISTS public.set_conversation_chain_default();
--   ALTER TABLE whatsapp_config
--     ADD CONSTRAINT whatsapp_config_account_id_provider_key
--     UNIQUE (account_id, provider);
--
-- O ADD da constraint só passa enquanto houver no máximo um número por
-- (conta, provedor) — ou seja, antes de o segundo operador parear o
-- celular dele. Depois disso, reverter este arquivo exige escolher qual
-- número sobrevive, o que é migração de dados e não rollback. É o mesmo
-- ponto de não-retorno que a 044 já descreve.
--
-- Reverter o gatilho é seguro em qualquer momento: as cadeias já
-- gravadas continuam válidas, e uma conversa com cadeia NULL volta a
-- ser tratada como cadeia de um elo só pelo COALESCE que
-- `transfer_conversation` já faz.
--
-- Idempotente.
-- ============================================================
