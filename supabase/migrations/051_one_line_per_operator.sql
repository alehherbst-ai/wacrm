-- ============================================================
-- 051_one_line_per_operator.sql — acaba o número sem dono
--
-- Um número de WhatsApp por pessoa, e nenhum número de ninguém.
--
-- O "número da casa" (`operator_user_id IS NULL`, migração 044) era a
-- causa raiz de tudo que veio antes: uma conversa que chega numa linha
-- sem operador não tem de quem herdar responsável, então a 050 chega
-- ao passo 3 e devolve NULL. Com quatro operadores olhando a caixa,
-- ninguém sabe com quem o cliente queria falar — porque, na verdade,
-- não havia essa informação em lugar nenhum.
--
-- Com uma linha por pessoa, o número em que a mensagem chegou É a
-- resposta, e a 050 nunca passa do passo 1.
--
-- O que esta migration faz
--   1. Adota as linhas órfãs, tentando candidatos em ordem.
--   2. Reatribui as conversas dessas linhas ao novo dono.
--   3. Se sobrou zero órfã, torna `operator_user_id` obrigatório e
--      derruba o índice que permitia a linha sem dono.
--
-- Design notes
--
--   * O passo 3 é CONDICIONAL de propósito. `SET NOT NULL` numa tabela
--     com uma linha órfã restante aborta a migration inteira, e uma
--     migration que falha no meio é pior que uma regra aplicada em
--     duas etapas. Se sobrar órfã, esta migration deixa tudo
--     funcionando e a próxima execução (depois de resolver a órfã na
--     mão) fecha a regra. `DO $$` reporta o que sobrou.
--
--   * A ordem dos candidatos vai do mais defensável ao menos: quem
--     criou a conexão, depois o dono da conta, depois qualquer admin,
--     depois qualquer membro. Cada candidato só serve se ainda não
--     tiver linha própria — o índice único de 044 recusaria a segunda.
--
--   * As conversas seguem junto. Deixar `conversations.responsible_user_id`
--     como estava faria a linha ter dono e as conversas dela não, que é
--     exatamente a incoerência que este trabalho todo veio corrigir.
--     Só as SEM responsável são tocadas: uma conversa já atribuída a
--     alguém é um fato, não uma lacuna.
--
-- Requer 049 e 050.
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
--   ALTER TABLE whatsapp_config ALTER COLUMN operator_user_id DROP NOT NULL;
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_house
--     ON whatsapp_config (account_id) WHERE operator_user_id IS NULL;
--
-- A adoção em si não se desfaz automaticamente: quem virou dono de uma
-- linha continua dono. Para devolvê-la ao estado sem dono, um UPDATE
-- explícito — o que é melhor que um rollback adivinhar de quem era.
-- ------------------------------------------------------------
--
-- Idempotente.
-- ============================================================

-- ============================================================
-- 1. ADOÇÃO DAS LINHAS ÓRFÃS
-- ============================================================
DO $$
DECLARE
  v_row RECORD;
  v_owner UUID;
  v_adopted INTEGER := 0;
  v_orphans INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT id, account_id, user_id
    FROM whatsapp_config
    WHERE operator_user_id IS NULL
    ORDER BY created_at
  LOOP
    v_owner := NULL;

    -- Candidato 1: quem criou a conexão. É quem escaneou o QR code, ou
    -- ao menos quem apertou o botão — a melhor evidência que existe.
    SELECT p.user_id INTO v_owner
    FROM profiles p
    WHERE p.user_id = v_row.user_id
      AND p.account_id = v_row.account_id
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_config w
        WHERE w.account_id = v_row.account_id
          AND w.operator_user_id = p.user_id
      );

    -- Candidatos 2 a 4: dono da conta, depois admin, depois qualquer
    -- membro — sempre o mais antigo, para o resultado não depender da
    -- ordem em que o Postgres devolveu as linhas.
    IF v_owner IS NULL THEN
      SELECT p.user_id INTO v_owner
      FROM profiles p
      WHERE p.account_id = v_row.account_id
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_config w
          WHERE w.account_id = v_row.account_id
            AND w.operator_user_id = p.user_id
        )
      ORDER BY
        CASE p.account_role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'agent' THEN 3
          ELSE 4
        END,
        p.created_at
      LIMIT 1;
    END IF;

    IF v_owner IS NULL THEN
      -- Todo mundo da conta já tem linha. Nada a fazer sem apagar a
      -- conexão ou tirar a de outra pessoa, e nenhuma das duas é
      -- decisão de uma migration.
      v_orphans := v_orphans + 1;
      RAISE WARNING
        'whatsapp_config % ficou sem dono: todos os membros da conta % já têm linha. Resolva à mão.',
        v_row.id, v_row.account_id;
      CONTINUE;
    END IF;

    UPDATE whatsapp_config
       SET operator_user_id = v_owner,
           updated_at = NOW()
     WHERE id = v_row.id;

    -- As conversas que chegaram nessa linha e nunca foram atribuídas
    -- passam a ser de quem agora responde por ela.
    UPDATE conversations
       SET responsible_user_id = v_owner
     WHERE whatsapp_config_id = v_row.id
       AND responsible_user_id IS NULL;

    v_adopted := v_adopted + 1;
  END LOOP;

  RAISE NOTICE '051: % linha(s) adotada(s), % sem dono.', v_adopted, v_orphans;
END $$;

-- ============================================================
-- 2. FECHA A REGRA — só se não sobrou nenhuma órfã
-- ============================================================
DO $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM whatsapp_config
  WHERE operator_user_id IS NULL;

  IF v_remaining = 0 THEN
    ALTER TABLE whatsapp_config
      ALTER COLUMN operator_user_id SET NOT NULL;

    -- Sem linha sem dono, o índice que garantia "no máximo uma delas
    -- por conta" não tem mais o que garantir.
    DROP INDEX IF EXISTS idx_whatsapp_config_house;

    RAISE NOTICE '051: operator_user_id agora é obrigatório.';
  ELSE
    RAISE WARNING
      '051: % linha(s) ainda sem dono — NOT NULL não aplicado. Resolva e rode esta migration de novo.',
      v_remaining;
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.operator_user_id IS
  'De quem é esta linha. Uma por pessoa (índice único), e desde a 051 '
  'nunca nula: o número em que a mensagem chega é o que diz com quem o '
  'cliente queria falar.';
