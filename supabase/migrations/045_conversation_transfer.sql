-- ============================================================
-- 045_conversation_transfer.sql — Etapa 2 de operadores
--
-- Passa uma conversa de um operador para outro sem perder o
-- histórico, e sem duplicar uma linha sequer.
--
-- O modelo
--   Transferir NÃO copia mensagens. A conversa de destino (que vive no
--   número do operador que recebe) guarda uma REFERÊNCIA à de origem,
--   e as duas passam a compartilhar um `transfer_chain_id`. Quem
--   participa da cadeia lê tudo; a tela desenha uma divisória em cada
--   passagem.
--
--   Copiar teria três defeitos que a referência não tem: uma cópia não
--   carrega o id que o WhatsApp deu à mensagem, então responder a uma
--   mensagem herdada quebraria; tudo passaria a contar em dobro em não
--   lidas e relatórios; e a cópia envelheceria na hora, porque o
--   cliente continua com o número antigo e pode escrever nele de novo.
--   Com referência, esse "escrever de novo" aparece sozinho para quem
--   recebeu a transferência.
--
-- O que esta migration faz
--   1. Colunas de cadeia e de transferência em `conversations`.
--   2. `transfer_chain_id` preenchido com o próprio id — toda conversa
--      existente vira uma cadeia de um elo só.
--   3. `can_read_conversation()` — leitura passa a alcançar a cadeia
--      inteira. A ESCRITA continua em `can_access_conversation`, sem
--      cadeia: é isso que faz "um dono ativo, os demais observam".
--   4. `transfer_conversation()` — o RPC que faz a passagem inteira
--      numa transação só.
--
-- NADA MUDA ATÉ ALGUÉM TRANSFERIR. Cada conversa nasce como cadeia de
-- si mesma, e uma cadeia de um elo devolve exatamente o que a regra
-- anterior devolvia.
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
--   -- Leitura volta a ignorar a cadeia
--   DROP POLICY IF EXISTS conversations_select ON conversations;
--   CREATE POLICY conversations_select ON conversations FOR SELECT
--     USING (can_access_conversation(account_id, whatsapp_config_id));
--   DROP POLICY IF EXISTS messages_select ON messages;
--   CREATE POLICY messages_select ON messages FOR SELECT USING (
--     EXISTS (SELECT 1 FROM conversations c
--             WHERE c.id = messages.conversation_id
--               AND can_access_conversation(c.account_id, c.whatsapp_config_id)));
--   DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
--   CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
--     EXISTS (SELECT 1 FROM conversations c
--             WHERE c.id = message_reactions.conversation_id
--               AND can_access_conversation(c.account_id, c.whatsapp_config_id)));
--
--   DROP FUNCTION IF EXISTS transfer_conversation(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS can_read_conversation(UUID, UUID, UUID, account_role_enum);
--
--   -- Colunas: guardá-las não atrapalha nada, e apagá-las descarta o
--   -- registro de quem passou o quê para quem.
--   ALTER TABLE conversations
--     DROP COLUMN IF EXISTS transfer_chain_id,
--     DROP COLUMN IF EXISTS inherited_from_conversation_id,
--     DROP COLUMN IF EXISTS transferred_to_conversation_id,
--     DROP COLUMN IF EXISTS transferred_at,
--     DROP COLUMN IF EXISTS transferred_by_user_id,
--     DROP COLUMN IF EXISTS handed_over_at;
--
-- Reverter é seguro em qualquer momento: nenhuma mensagem foi movida
-- ou copiada, então desfazer só apaga os ponteiros. As conversas
-- criadas por uma transferência continuam existindo, cada uma no seu
-- número, com as mensagens que de fato passaram por ela — que é o
-- estado correto de qualquer forma.
-- ------------------------------------------------------------
--
-- Idempotente.
-- ============================================================

-- ============================================================
-- 1. AS COLUNAS
-- ============================================================
ALTER TABLE conversations
  -- Todo mundo da cadeia compartilha este valor. Existe para que a
  -- pergunta "esta conversa é parente de alguma minha?" seja UMA
  -- comparação indexável, e não uma recursão por linha avaliada — o
  -- que uma policy de RLS não pode se dar ao luxo de fazer.
  ADD COLUMN IF NOT EXISTS transfer_chain_id UUID,
  -- O elo anterior. É o que a tela usa para desenhar a divisória.
  ADD COLUMN IF NOT EXISTS inherited_from_conversation_id UUID
    REFERENCES conversations(id) ON DELETE SET NULL,
  -- O elo seguinte, na origem. Permite mostrar "transferida para o
  -- Bruno" sem varrer a tabela procurando quem aponta para cá.
  ADD COLUMN IF NOT EXISTS transferred_to_conversation_id UUID
    REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transferred_by_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Estado, não histórico: marcado ao transferir, LIMPO quando o
  -- cliente escreve de novo neste número. Enquanto estiver marcado, o
  -- dono do número está observando, não atendendo. `transferred_at`
  -- fica para sempre; este vai e volta.
  ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.transfer_chain_id IS
  'Todas as conversas de uma mesma cadeia de transferência compartilham este id. Quem atende qualquer elo lê a cadeia inteira.';
COMMENT ON COLUMN conversations.handed_over_at IS
  'Marcado ao transferir, limpo quando o cliente escreve neste número de novo. Marcado = o dono observa; nulo = o dono atende.';

-- Toda conversa existente é uma cadeia de um elo só.
UPDATE conversations SET transfer_chain_id = id WHERE transfer_chain_id IS NULL;

-- O índice que sustenta a checagem de observador na RLS.
CREATE INDEX IF NOT EXISTS idx_conversations_chain
  ON conversations (transfer_chain_id);

-- ============================================================
-- 2. LEITURA ALCANÇA A CADEIA; ESCRITA NÃO
--
-- É aqui que mora a regra "um dono ativo por vez, os demais
-- observam", e ela é imposta pelo banco, não pela tela:
--
--   - LER   → `can_read_conversation`, que aceita também "existe
--             outra conversa nesta mesma cadeia que é do meu número".
--             É o que faz o Bruno enxergar o histórico da Ana, e o que
--             faz as mensagens novas dela aparecerem sozinhas no bloco
--             herdado dele.
--   - ESCREVER → `can_access_conversation` (migration 044), sem
--             cadeia. Observar não dá direito de responder por um
--             número que não é seu — e responder por ele seria
--             literalmente impossível do lado do WhatsApp.
--
-- O `min_role` continua valendo por cima das duas.
-- ============================================================
CREATE OR REPLACE FUNCTION can_read_conversation(
  target_account_id UUID,
  target_config_id UUID,
  target_chain_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
      AND (
        p.inbox_scope = 'all'
        -- A conversa é do meu número.
        OR EXISTS (
          SELECT 1 FROM whatsapp_config w
          WHERE w.id = target_config_id
            AND w.account_id = target_account_id
            AND w.operator_user_id = p.user_id
        )
        -- Ou algum elo da mesma cadeia é — eu participei desta
        -- história, mesmo que este trecho não seja meu.
        OR (
          target_chain_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM conversations c2
            JOIN whatsapp_config w2 ON w2.id = c2.whatsapp_config_id
            WHERE c2.transfer_chain_id = target_chain_id
              AND c2.account_id = target_account_id
              AND w2.operator_user_id = p.user_id
          )
        )
      )
  );
$$;

ALTER FUNCTION can_read_conversation(UUID, UUID, UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_read_conversation(UUID, UUID, UUID, account_role_enum)
  TO authenticated, service_role;

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_read_conversation(account_id, whatsapp_config_id, transfer_chain_id));

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_read_conversation(c.account_id, c.whatsapp_config_id, c.transfer_chain_id)
  )
);

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = message_reactions.conversation_id
      AND can_read_conversation(c.account_id, c.whatsapp_config_id, c.transfer_chain_id)
  )
);

-- As policies de escrita ficam como a 044 as deixou, de propósito.

-- ============================================================
-- 3. A TRANSFERÊNCIA
--
-- Uma transação, porque meio caminho é pior que caminho nenhum: uma
-- conversa marcada como entregue sem destino deixaria o cliente sem
-- ninguém atendendo.
--
-- Regras, e o porquê de cada uma:
--   - Quem transfere precisa poder escrever na conversa. Observador
--     não passa adiante o que não é dele.
--   - O destino precisa ter um número conectado. Sem isso a conversa
--     nova não teria por onde falar, e o cliente ficaria esperando uma
--     resposta que nunca sairia.
--   - Grupos não são transferíveis. Um grupo mora num número
--     específico e o destinatário não é membro dele — a conversa
--     criada nunca receberia nem entregaria nada.
--   - Não transferir para si mesmo, nem para o dono do próprio número.
--
-- Se o destino já tiver conversa com este contato, ela é REAPROVEITADA
-- (o índice único de 044 exige isso) e as duas cadeias são fundidas —
-- o histórico anterior do Bruno com esse cliente também é história
-- desse cliente, e separá-la seria a mesma amnésia que a transferência
-- veio curar.
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_conversation(
  p_conversation_id UUID,
  p_to_user_id UUID
) RETURNS UUID  -- a conversa de destino
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_source conversations%ROWTYPE;
  v_is_group BOOLEAN;
  v_target_config UUID;
  v_dest_id UUID;
  v_dest_chain UUID;
  v_chain UUID;
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

  -- O destinatário precisa ser desta conta e ter um número.
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

  v_chain := COALESCE(v_source.transfer_chain_id, v_source.id);

  -- Conversa de destino: a que já existir para (contato, número do
  -- destinatário), senão uma nova.
  SELECT id, transfer_chain_id INTO v_dest_id, v_dest_chain
  FROM conversations
  WHERE account_id = v_source.account_id
    AND contact_id = v_source.contact_id
    AND whatsapp_config_id = v_target_config;

  IF v_dest_id IS NULL THEN
    INSERT INTO conversations (
      account_id, user_id, contact_id, whatsapp_config_id,
      transfer_chain_id, inherited_from_conversation_id, status
    ) VALUES (
      v_source.account_id, p_to_user_id, v_source.contact_id, v_target_config,
      v_chain, v_source.id, 'open'
    )
    RETURNING id INTO v_dest_id;
  ELSE
    -- Funde as duas cadeias. Feito por transfer_chain_id (e não só na
    -- linha de destino) para que TODOS os elos da cadeia antiga do
    -- destinatário venham junto — deixá-los para trás os tornaria
    -- invisíveis para quem passou a atender.
    IF v_dest_chain IS DISTINCT FROM v_chain THEN
      UPDATE conversations
      SET transfer_chain_id = v_chain
      WHERE account_id = v_source.account_id
        AND transfer_chain_id = v_dest_chain;
    END IF;

    UPDATE conversations
    SET inherited_from_conversation_id =
          COALESCE(inherited_from_conversation_id, v_source.id),
        transfer_chain_id = v_chain,
        -- Recebeu de volta: quem estava observando volta a atender.
        handed_over_at = NULL,
        archived_at = NULL,
        updated_at = NOW()
    WHERE id = v_dest_id;
  END IF;

  -- A origem passa a observar.
  UPDATE conversations
  SET transferred_to_conversation_id = v_dest_id,
      transferred_at = NOW(),
      transferred_by_user_id = v_caller,
      handed_over_at = NOW(),
      transfer_chain_id = v_chain,
      updated_at = NOW()
  WHERE id = p_conversation_id;

  -- Um fluxo em andamento na origem perde o sentido: quem conduzia a
  -- conversa não é mais quem responde por ela.
  UPDATE flow_runs
  SET status = 'paused_by_agent',
      ended_at = NOW(),
      end_reason = 'agent_replied'
  WHERE account_id = v_source.account_id
    AND contact_id = v_source.contact_id
    AND status = 'active';

  RETURN v_dest_id;
END;
$$;

ALTER FUNCTION public.transfer_conversation(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_conversation(UUID, UUID) TO authenticated;
