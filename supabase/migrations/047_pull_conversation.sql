-- ============================================================
-- 047_pull_conversation.sql — puxar uma conversa para si
--
-- A etapa 2 só sabia EMPURRAR: `transfer_conversation` entrega a
-- conversa a outra pessoa, e quem entrega precisa ser quem atende.
-- Faltava o movimento contrário — eu vejo uma conversa que está com
-- outro operador (ou no número da casa, que não é de ninguém) e a
-- trago para mim.
--
-- Empurrar e puxar não são a mesma operação com o argumento trocado,
-- e é por isso que este arquivo existe em vez de um parâmetro novo:
--
--   - EMPURRAR exige poder ESCREVER na conversa. Você só passa
--     adiante o que é seu; um observador não distribui o trabalho
--     alheio.
--   - PUXAR exige poder LER a conversa. É o que separa "assumir algo
--     que eu enxergo" de "mexer no que não me diz respeito": um
--     operador de escopo 'own' não enxerga a conversa de um colega,
--     então não tem como puxá-la; um gestor de escopo 'all' enxerga a
--     conta inteira e pode assumir qualquer atendimento — que é
--     exatamente o caso de uso pedido.
--
-- `transfer_conversation` também RECUSA explicitamente ter você como
-- destino ('That conversation is already yours'), então ela não podia
-- ser reaproveitada nem chamando com o próprio id.
--
-- O que esta migration faz
--   1. Extrai a mecânica comum das duas operações para
--      `handover_conversation_core()`. As duas passam a compartilhar
--      UMA implementação de "criar/reaproveitar o destino, fundir a
--      cadeia, marcar a origem como entregue, pausar o fluxo".
--   2. `transfer_conversation` passa a chamar o core. As validações e
--      a ORDEM delas continuam idênticas — os SQLSTATEs que a rota
--      HTTP traduz não mudam.
--   3. `pull_conversation()` — o RPC novo.
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
--   DROP FUNCTION IF EXISTS public.pull_conversation(UUID);
--   -- e recrie transfer_conversation com o corpo da migration 045
--   -- (o arquivo 045 traz a versão anterior por inteiro), depois:
--   DROP FUNCTION IF EXISTS public.handover_conversation_core(conversations, UUID, UUID, UUID);
--
-- Reverter é seguro em qualquer momento: nenhuma coluna muda, nenhuma
-- linha é movida. As conversas criadas por um "puxar" continuam
-- existindo, cada uma no seu número, exatamente como as criadas por
-- uma transferência — que é o estado correto de qualquer forma.
-- ------------------------------------------------------------
--
-- Idempotente.
-- ============================================================

-- ============================================================
-- 1. A MECÂNICA, UMA VEZ SÓ
--
-- Recebe a conversa de origem já lida e o número de destino já
-- resolvido: quem chama é que decide SE pode, e com base em qual
-- regra. Este corpo só executa a passagem.
--
-- Não faz autorização nenhuma de propósito. É `SECURITY DEFINER` e
-- fica sem EXECUTE para PUBLIC justamente por isso — só os dois RPCs
-- acima dela podem chamá-la, e cada um traz a própria regra.
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
      transfer_chain_id, inherited_from_conversation_id, status
    ) VALUES (
      p_source.account_id, p_to_user_id, p_source.contact_id, p_target_config,
      v_chain, p_source.id, 'open'
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

-- ============================================================
-- 2. EMPURRAR — mesmas regras e mesma ordem da 045
--
-- Só o corpo mudou de lugar. As validações, os textos e os SQLSTATEs
-- continuam idênticos, na mesma sequência, porque a rota HTTP e a
-- tela já dependem deles.
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_conversation(
  p_conversation_id UUID,
  p_to_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_source conversations%ROWTYPE;
  v_is_group BOOLEAN;
  v_target_config UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_source FROM conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '22023';
  END IF;

  -- Escrita, não leitura: um observador enxerga a conversa e ainda
  -- assim não pode passá-la adiante.
  IF NOT can_access_conversation(
       v_source.account_id, v_source.whatsapp_config_id, 'agent') THEN
    RAISE EXCEPTION 'You cannot transfer a conversation you do not handle'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(is_group, FALSE) INTO v_is_group
  FROM contacts WHERE id = v_source.contact_id;

  IF v_is_group THEN
    RAISE EXCEPTION 'Group conversations cannot be transferred'
      USING ERRCODE = '22023';
  END IF;

  IF p_to_user_id = v_caller THEN
    RAISE EXCEPTION 'That conversation is already yours' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = p_to_user_id AND account_id = v_source.account_id
  ) THEN
    RAISE EXCEPTION 'That person is not in your account' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_target_config
  FROM whatsapp_config
  WHERE account_id = v_source.account_id
    AND operator_user_id = p_to_user_id
    AND provider = 'uazapi';

  IF v_target_config IS NULL THEN
    RAISE EXCEPTION 'That person has no WhatsApp number connected yet'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_config = v_source.whatsapp_config_id THEN
    RAISE EXCEPTION 'That conversation already lives on that number'
      USING ERRCODE = '22023';
  END IF;

  RETURN handover_conversation_core(
    v_source, p_to_user_id, v_target_config, v_caller);
END;
$$;

ALTER FUNCTION public.transfer_conversation(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_conversation(UUID, UUID) TO authenticated;

-- ============================================================
-- 3. PUXAR
--
-- Autorização por LEITURA, e é a diferença que define a operação:
-- você assume o que já enxerga. `can_read_conversation` com 'agent'
-- soma as três formas de enxergar (escopo 'all', a conversa é do seu
-- número, ou algum elo da cadeia é) ao cargo mínimo para escrever.
--
-- Consequência que vale ter em mente: um operador de escopo 'own' não
-- enxerga a conversa de um colega e portanto não consegue puxá-la —
-- puxar não é uma porta lateral para fora do escopo. Quem puxa
-- livremente é quem já via tudo de qualquer forma.
--
-- Grupos ficam de fora pelo mesmo motivo da transferência: um grupo
-- mora num número específico e quem puxa não é membro dele, então a
-- conversa criada nunca receberia nem entregaria nada.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pull_conversation(
  p_conversation_id UUID
) RETURNS UUID  -- a conversa no seu número
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_source conversations%ROWTYPE;
  v_is_group BOOLEAN;
  v_my_config UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_source FROM conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '22023';
  END IF;

  IF NOT can_read_conversation(
       v_source.account_id, v_source.whatsapp_config_id,
       v_source.transfer_chain_id, 'agent') THEN
    RAISE EXCEPTION 'You cannot pull a conversation you cannot see'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(is_group, FALSE) INTO v_is_group
  FROM contacts WHERE id = v_source.contact_id;

  IF v_is_group THEN
    RAISE EXCEPTION 'Group conversations cannot be pulled'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_my_config
  FROM whatsapp_config
  WHERE account_id = v_source.account_id
    AND operator_user_id = v_caller
    AND provider = 'uazapi';

  IF v_my_config IS NULL THEN
    RAISE EXCEPTION 'You have no WhatsApp number connected yet'
      USING ERRCODE = '22023';
  END IF;

  IF v_my_config = v_source.whatsapp_config_id THEN
    RAISE EXCEPTION 'That conversation is already yours' USING ERRCODE = '22023';
  END IF;

  RETURN handover_conversation_core(
    v_source, v_caller, v_my_config, v_caller);
END;
$$;

ALTER FUNCTION public.pull_conversation(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pull_conversation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pull_conversation(UUID) TO authenticated;
