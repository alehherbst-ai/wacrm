-- ============================================================
-- 049_conversation_responsible.sql — quem responde por esta conversa
--
-- Acaba com o "número da casa" como resposta à pergunta "de quem é
-- este atendimento".
--
-- Até aqui, a responsabilidade era deduzida do número: a conversa vive
-- numa linha, a linha tem um operador, logo o operador é o dono
-- (migração 044). Funciona enquanto toda linha tem dono. A linha
-- compartilhada — a que a conta já tinha antes de cada operador ganhar
-- a sua — não tem, e a interface não tinha o que dizer além de "número
-- da casa", que nomeia um telefone quando a pergunta era sobre uma
-- pessoa.
--
-- A regra passa a ser: responsável é quem falou primeiro com aquele
-- cliente. `conversations.responsible_user_id` guarda isso, e um
-- gatilho o carimba na primeira mensagem de agente.
--
-- Design notes
--
--   * Coluna própria, não uma dedução do número. As duas coisas são
--     diferentes e só coincidem por acidente: o número diz de onde a
--     resposta SAI (restrição do WhatsApp, não escolha nossa), o
--     responsável diz de quem é o atendimento. Numa linha
--     compartilhada as duas divergem, e era exatamente aí que a
--     interface não tinha o que dizer.
--
--   * O gatilho só preenche o vazio (`IS NULL`). Responsabilidade se
--     estabelece uma vez; a segunda mensagem, de quem quer que seja,
--     não rouba o atendimento. Trocar de responsável é transferir, que
--     é explícito e já existe.
--
--   * Depende de `messages.sender_id`, que até esta altura NUNCA era
--     preenchido no caminho de envio — o insert simplesmente omitia a
--     coluna. O commit que acompanha esta migration passa a gravá-lo.
--     Sem isso o gatilho existiria e nunca dispararia.
--
--   * Uma transferência atribui na hora, sem esperar a primeira
--     mensagem: entregar a conversa a alguém JÁ é dizer de quem ela é.
--     Esperar deixaria o destinatário sem responsável nenhum na janela
--     entre receber e responder — que é justamente quando alguém olha
--     a lista para saber com quem está.
--
--   * NADA em RLS muda. Responsabilidade é fluxo de trabalho, não
--     fronteira de acesso: quem enxerga o quê continua decidido por
--     `inbox_scope` e pelo número. Um operador de escopo 'own' não
--     enxerga a linha compartilhada e portanto nunca responde nela,
--     então não existe o caso de alguém ser responsável por algo que
--     não pode ver.
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
--   DROP TRIGGER IF EXISTS on_message_claims_conversation ON messages;
--   DROP FUNCTION IF EXISTS public.claim_conversation_on_first_reply();
--   ALTER TABLE conversations DROP COLUMN IF EXISTS responsible_user_id;
--   -- e recrie handover_conversation_core com o corpo da 047.
--
-- Reverter é seguro: nenhuma linha muda de lugar, nenhuma policy é
-- tocada. A interface volta a deduzir dono pelo número.
-- ------------------------------------------------------------
--
-- Idempotente.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS responsible_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN conversations.responsible_user_id IS
  'Quem responde por este atendimento. Carimbado na primeira mensagem '
  'de agente, ou na transferência. Distinto de whatsapp_config_id, que '
  'diz de qual número a resposta sai.';

-- Serve o filtro "atendidas por" da caixa de entrada.
CREATE INDEX IF NOT EXISTS idx_conversations_responsible
  ON conversations(account_id, responsible_user_id)
  WHERE responsible_user_id IS NOT NULL;

-- ============================================================
-- BACKFILL
--
-- Para conversas que vivem numa linha COM operador, o operador é o
-- responsável — é o que a interface já mostrava, agora escrito na
-- linha em vez de deduzido a cada render.
--
-- Conversas na linha compartilhada ficam NULL de propósito. Não há
-- registro de quem as atendeu (`messages.sender_id` sempre foi nulo),
-- e inventar um responsável a partir de `conversations.user_id` — que
-- é o admin que salvou a conexão, não quem atendeu — colocaria o nome
-- errado numa tela cuja função é dizer de quem é a conversa. Elas
-- aparecem como "sem responsável" até alguém responder.
-- ============================================================
UPDATE conversations c
   SET responsible_user_id = w.operator_user_id
  FROM whatsapp_config w
 WHERE w.id = c.whatsapp_config_id
   AND w.operator_user_id IS NOT NULL
   AND c.responsible_user_id IS NULL;

-- ============================================================
-- O GATILHO — primeira mensagem de agente reivindica a conversa
--
-- AFTER INSERT: a mensagem já está gravada quando isto roda, então uma
-- falha aqui não desfaz o envio. `sender_type = 'bot'` fica de fora de
-- propósito — uma resposta automática não é alguém assumindo o
-- atendimento, e deixar a IA reivindicar a conversa faria o cliente
-- ficar "com" um robô.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_conversation_on_first_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type <> 'agent' OR NEW.sender_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE conversations
     SET responsible_user_id = NEW.sender_id
   WHERE id = NEW.conversation_id
     AND responsible_user_id IS NULL;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.claim_conversation_on_first_reply() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_message_claims_conversation ON messages;
CREATE TRIGGER on_message_claims_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.claim_conversation_on_first_reply();

-- ============================================================
-- TRANSFERÊNCIA ATRIBUI NA HORA
--
-- Mesmo corpo da 047, com uma linha a mais: o elo de destino nasce
-- com responsável. Recriada por inteiro porque CREATE OR REPLACE
-- exige o corpo completo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handover_conversation_core(
  p_source conversations,
  p_to_user_id UUID,
  p_target_config UUID,
  p_caller UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dest_id UUID;
  v_dest_chain UUID;
  v_chain UUID;
BEGIN
  v_chain := COALESCE(p_source.transfer_chain_id, p_source.id);

  SELECT id, transfer_chain_id INTO v_dest_id, v_dest_chain
  FROM conversations
  WHERE account_id = p_source.account_id
    AND contact_id = p_source.contact_id
    AND whatsapp_config_id = p_target_config;

  IF v_dest_id IS NULL THEN
    INSERT INTO conversations (
      account_id, user_id, contact_id, whatsapp_config_id,
      transfer_chain_id, inherited_from_conversation_id, status,
      responsible_user_id
    ) VALUES (
      p_source.account_id, p_to_user_id, p_source.contact_id, p_target_config,
      v_chain, p_source.id, 'open',
      p_to_user_id
    )
    RETURNING id INTO v_dest_id;
  ELSE
    -- Funde as duas cadeias, por transfer_chain_id, para que TODOS os
    -- elos da cadeia antiga do destinatário venham junto.
    IF v_dest_chain IS DISTINCT FROM v_chain THEN
      UPDATE conversations
      SET transfer_chain_id = v_chain
      WHERE account_id = p_source.account_id
        AND transfer_chain_id = v_dest_chain;
    END IF;

    UPDATE conversations
    SET inherited_from_conversation_id =
          COALESCE(inherited_from_conversation_id, p_source.id),
        transfer_chain_id = v_chain,
        handed_over_at = NULL,
        archived_at = NULL,
        -- Reaproveitar um elo antigo é receber a conversa igual: quem
        -- recebe responde por ela a partir de agora.
        responsible_user_id = p_to_user_id,
        updated_at = NOW()
    WHERE id = v_dest_id;
  END IF;

  -- A origem passa a observar.
  UPDATE conversations
  SET transferred_to_conversation_id = v_dest_id,
      transferred_at = NOW(),
      transferred_by_user_id = p_caller,
      handed_over_at = NOW(),
      transfer_chain_id = v_chain,
      updated_at = NOW()
  WHERE id = p_source.id;

  -- Um fluxo em andamento perde o sentido: quem conduzia a conversa
  -- não é mais quem responde por ela.
  UPDATE flow_runs
  SET status = 'paused_by_agent',
      ended_at = NOW(),
      end_reason = 'agent_replied'
  WHERE account_id = p_source.account_id
    AND contact_id = p_source.contact_id
    AND status = 'active';

  RETURN v_dest_id;
END;
$$;

ALTER FUNCTION public.handover_conversation_core(conversations, UUID, UUID, UUID)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handover_conversation_core(conversations, UUID, UUID, UUID)
  FROM PUBLIC;
