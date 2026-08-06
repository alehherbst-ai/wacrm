-- ============================================================
-- 044_operators_multi_number.sql — Etapa 1 de operadores
--
-- Dá a cada operador o próprio número de WhatsApp e faz cada um
-- enxergar apenas as conversas que chegam nele.
--
-- O que esta migration faz
--   1. `whatsapp_config.operator_user_id` — de quem é o número.
--      NULL = "número da casa", o comportamento de hoje.
--   2. Troca `UNIQUE(account_id)` por dois índices parciais: um
--      número por operador, e no máximo um número da casa.
--   3. `profiles.inbox_scope` — 'all' (vê tudo) ou 'own' (só o
--      próprio número). Default 'all'.
--   4. Preenche `conversations.whatsapp_config_id` onde estiver
--      vazio e troca a chave única de (conta, contato) para
--      (conta, contato, número).
--   5. `can_access_conversation()` — o helper de RLS que soma
--      "é membro da conta?" com "esta conversa é do seu número?".
--   6. Reescreve as policies de `conversations`, `messages` e
--      `message_reactions` para usar o helper.
--
-- NADA MUDA ATÉ ALGUÉM AGIR. Todo mundo nasce com escopo 'all', o
-- número já conectado vira número da casa (operator_user_id NULL), e
-- `can_access_conversation` com escopo 'all' devolve exatamente o que
-- `is_account_member` devolvia. A conta só passa a se comportar
-- diferente quando o gestor atribuir um número a alguém e mudar o
-- escopo dessa pessoa.
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
-- Enquanto NENHUM segundo número tiver sido conectado, esta migration
-- é 100% reversível. Rode:
--
--   -- 1. Policies de volta ao membership puro
--   DROP POLICY IF EXISTS conversations_select ON conversations;
--   DROP POLICY IF EXISTS conversations_insert ON conversations;
--   DROP POLICY IF EXISTS conversations_update ON conversations;
--   DROP POLICY IF EXISTS conversations_delete ON conversations;
--   CREATE POLICY conversations_select ON conversations FOR SELECT
--     USING (is_account_member(account_id));
--   CREATE POLICY conversations_insert ON conversations FOR INSERT
--     WITH CHECK (is_account_member(account_id, 'agent'));
--   CREATE POLICY conversations_update ON conversations FOR UPDATE
--     USING (is_account_member(account_id, 'agent'));
--   CREATE POLICY conversations_delete ON conversations FOR DELETE
--     USING (is_account_member(account_id, 'agent'));
--
--   DROP POLICY IF EXISTS messages_select ON messages;
--   DROP POLICY IF EXISTS messages_modify ON messages;
--   CREATE POLICY messages_select ON messages FOR SELECT USING (
--     EXISTS (SELECT 1 FROM conversations c
--             WHERE c.id = messages.conversation_id
--               AND is_account_member(c.account_id)));
--   CREATE POLICY messages_modify ON messages FOR ALL USING (
--     EXISTS (SELECT 1 FROM conversations c
--             WHERE c.id = messages.conversation_id
--               AND is_account_member(c.account_id, 'agent')));
--
--   DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
--   DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
--   CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
--     EXISTS (SELECT 1 FROM conversations c
--             WHERE c.id = message_reactions.conversation_id
--               AND is_account_member(c.account_id)));
--   CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
--     EXISTS (SELECT 1 FROM conversations c
--             WHERE c.id = message_reactions.conversation_id
--               AND is_account_member(c.account_id, 'agent')));
--
--   -- 2. Chave da conversa de volta a (conta, contato)
--   DROP INDEX IF EXISTS idx_conversations_account_contact_number;
--   CREATE UNIQUE INDEX idx_conversations_account_contact
--     ON conversations (account_id, contact_id);
--
--   -- 3. Unicidade do número de volta a um por conta
--   DROP INDEX IF EXISTS idx_whatsapp_config_operator;
--   DROP INDEX IF EXISTS idx_whatsapp_config_house;
--   ALTER TABLE whatsapp_config
--     ADD CONSTRAINT whatsapp_config_account_id_key UNIQUE (account_id);
--
--   -- 4. Conectar número volta a ser exclusividade de admin
--   DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
--   DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
--   DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;
--   CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT
--     WITH CHECK (is_account_member(account_id, 'admin'));
--   CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE
--     USING (is_account_member(account_id, 'admin'));
--   CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE
--     USING (is_account_member(account_id, 'admin'));
--
--   -- 5. Gatilho de colunas de privilégio sem o inbox_scope
--   --    (copie o corpo da migration 034 de volta), e:
--   DROP FUNCTION IF EXISTS set_member_inbox_scope(UUID, TEXT);
--
--   -- 6. Colunas (opcional — guardá-las não atrapalha nada)
--   ALTER TABLE whatsapp_config DROP COLUMN IF EXISTS operator_user_id;
--   ALTER TABLE profiles DROP COLUMN IF EXISTS inbox_scope;
--   DROP FUNCTION IF EXISTS can_access_conversation(UUID, UUID, account_role_enum);
--
-- DEPOIS QUE UM SEGUNDO NÚMERO FOR CONECTADO isto deixa de ser
-- desfazer e passa a ser decidir: o passo 2 e o passo 3 vão falhar
-- enquanto existirem duas conversas com o mesmo contato ou dois
-- números na mesma conta. Reverter aí exige escolher qual conversa
-- sobrevive e para onde vão as mensagens da outra — o que é
-- migração de dados, não rollback. É o ponto de não-retorno desta
-- etapa, e ele só é cruzado por uma ação explícita do gestor.
-- ------------------------------------------------------------
--
-- Idempotente — colunas com IF NOT EXISTS, índices e policies
-- derrubados antes de recriar.
-- ============================================================

-- ============================================================
-- 1. DE QUEM É O NÚMERO
--
-- NULL é significativo e é o default: um número sem dono é o número
-- da casa, visível para quem tem escopo 'all'. É assim que a conexão
-- que já existe atravessa esta migration sem ninguém perder acesso.
--
-- ON DELETE SET NULL, não CASCADE: remover uma pessoa da equipe não
-- pode apagar a conexão de WhatsApp junto (levando conversas e
-- histórico atrás). O número volta a ser da casa e o gestor reatribui.
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS operator_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN whatsapp_config.operator_user_id IS
  'Operador dono deste número. NULL = número da casa, visível para quem tem inbox_scope = all.';

-- ============================================================
-- 2. UNICIDADE: UM NÚMERO POR OPERADOR
--
-- `UNIQUE(account_id)` (migration 017) é o que impedia o modelo
-- inteiro. Sai, e entram dois índices parciais:
--   - um número por operador;
--   - no máximo um número da casa por conta, para que "o número da
--     conta" continue sendo uma pergunta com resposta única no
--     caminho de compatibilidade do código.
-- ============================================================
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

DROP INDEX IF EXISTS idx_whatsapp_config_operator;
CREATE UNIQUE INDEX idx_whatsapp_config_operator
  ON whatsapp_config (account_id, operator_user_id)
  WHERE operator_user_id IS NOT NULL;

DROP INDEX IF EXISTS idx_whatsapp_config_house;
CREATE UNIQUE INDEX idx_whatsapp_config_house
  ON whatsapp_config (account_id)
  WHERE operator_user_id IS NULL;

-- ============================================================
-- 3. ESCOPO DA CAIXA DE ENTRADA
--
-- Ortogonal ao cargo (`account_role`), de propósito: cargo é o que
-- a pessoa PODE FAZER, escopo é o que ela PODE VER. Um gerente que
-- também atende é 'admin' + 'own'; um supervisor é 'agent' + 'all'.
-- Sem isso, cada combinação viraria um cargo novo.
--
-- Default 'all' para que ninguém perca acesso ao aplicar a migration.
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS inbox_scope TEXT NOT NULL DEFAULT 'all';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_inbox_scope_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_inbox_scope_check
      CHECK (inbox_scope IN ('all', 'own'));
  END IF;
END $$;

COMMENT ON COLUMN profiles.inbox_scope IS
  'all = vê todas as conversas da conta; own = só as que chegam no número deste operador.';

-- ============================================================
-- 4. A CHAVE DA CONVERSA
--
-- Hoje: uma conversa por (conta, contato) — o mesmo cliente sempre
-- cai na mesma conversa, venha de qual número vier. Com vários
-- números isso faria as mensagens do número do Bruno aterrissarem na
-- conversa da Ana, e o escopo não teria como separar nada.
--
-- Passa a ser (conta, contato, número). O backfill roda ANTES da
-- troca do índice: toda conversa sem número apontado recebe o número
-- da conta (que hoje é sempre um só), de modo que a chave nova não
-- afrouxa nada para os dados que já existem.
-- ============================================================
-- Subquery com ORDER BY em vez de um join: hoje há no máximo uma
-- conexão por conta, mas a restrição que garantia isso acabou de ser
-- derrubada logo acima. Um join deixaria a escolha ao acaso se algum
-- dia rodasse com duas; assim o número da casa ganha, e o resultado é
-- o mesmo em qualquer reexecução.
UPDATE conversations c
SET whatsapp_config_id = (
  SELECT w.id
  FROM whatsapp_config w
  WHERE w.account_id = c.account_id
  ORDER BY (w.operator_user_id IS NOT NULL), w.created_at
  LIMIT 1
)
WHERE c.whatsapp_config_id IS NULL
  AND EXISTS (
    SELECT 1 FROM whatsapp_config w2 WHERE w2.account_id = c.account_id
  );

-- COALESCE em vez de `NULLS NOT DISTINCT` (que exige PG 15+): duas
-- conversas do mesmo contato com número NULL precisam colidir, e num
-- índice único comum dois NULLs são considerados distintos — o que
-- reabriria a duplicação que a migration 036 fechou.
DROP INDEX IF EXISTS idx_conversations_account_contact;
DROP INDEX IF EXISTS idx_conversations_account_contact_number;
CREATE UNIQUE INDEX idx_conversations_account_contact_number
  ON conversations (
    account_id,
    contact_id,
    COALESCE(whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ============================================================
-- 5. O HELPER DE VISIBILIDADE
--
-- Soma as duas perguntas numa só: "você é membro desta conta com
-- cargo suficiente?" E "esta conversa é do seu número?".
--
-- SECURITY DEFINER pelo mesmo motivo de `is_account_member`: o corpo
-- lê `profiles` e `whatsapp_config`, e sem isso a avaliação da policy
-- recairia sobre a RLS dessas tabelas recursivamente.
--
-- Escopo 'all' devolve exatamente o que `is_account_member` devolvia
-- — é o que garante que aplicar esta migration não muda nada até
-- alguém ser colocado em 'own'.
--
-- Conversa sem número (`target_config_id` NULL) fica invisível para
-- quem tem escopo 'own', e é o certo: uma conversa que não chegou por
-- número nenhum não pode pertencer a um operador.
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_conversation(
  target_account_id UUID,
  target_config_id UUID,
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
        OR EXISTS (
          SELECT 1
          FROM whatsapp_config w
          WHERE w.id = target_config_id
            AND w.account_id = target_account_id
            AND w.operator_user_id = p.user_id
        )
      )
  );
$$;

ALTER FUNCTION can_access_conversation(UUID, UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_conversation(UUID, UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 6. POLICIES
--
-- O webhook de entrada e os motores usam a service role, que ignora
-- RLS por definição — nada aqui afeta o recebimento de mensagens.
-- Isto governa o que o NAVEGADOR de cada pessoa consegue ler e
-- escrever.
--
-- Efeito colateral desejado: "Limpar caixa" faz um UPDATE em massa
-- sobre `conversations` sem filtro de dono, apoiado só na RLS. Com a
-- policy de UPDATE escopada, um operador passa a arquivar apenas as
-- próprias conversas — sem essa mudança, ele limparia a caixa dos
-- colegas.
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_access_conversation(account_id, whatsapp_config_id));
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (can_access_conversation(account_id, whatsapp_config_id, 'agent'));
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (can_access_conversation(account_id, whatsapp_config_id, 'agent'));
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (can_access_conversation(account_id, whatsapp_config_id, 'agent'));

DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;

CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_conversation(c.account_id, c.whatsapp_config_id)
  )
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, 'agent')
  )
);

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;

CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = message_reactions.conversation_id
      AND can_access_conversation(c.account_id, c.whatsapp_config_id)
  )
);
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = message_reactions.conversation_id
      AND can_access_conversation(c.account_id, c.whatsapp_config_id, 'agent')
  )
);

-- ============================================================
-- 7. QUEM CONECTA UM NÚMERO
--
-- Até aqui conectar era coisa de admin (`whatsapp_config_insert`
-- exigia 'admin'), o que fazia sentido quando havia um número só para
-- a conta inteira. Com um número por operador, exigir um admin para
-- cada pareamento de QR code transforma o gestor em gargalo de uma
-- tarefa que só o dono do celular consegue completar — quem escaneia
-- é quem tem o aparelho na mão.
--
-- Um agente passa a poder criar e manter a PRÓPRIA linha, e só ela: o
-- WITH CHECK amarra `operator_user_id` ao autor. Ele continua sem
-- poder tocar no número da casa nem no de um colega — essas seguem
-- exigindo admin.
-- ============================================================
DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;

CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND operator_user_id = auth.uid()
    )
  );

CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND operator_user_id = auth.uid()
    )
  )
  -- Sem o WITH CHECK, um agente poderia editar a própria linha para
  -- apontar `operator_user_id` a outra pessoa (ou a NULL, virando o
  -- número da casa) e escapar do escopo pela porta dos fundos.
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND operator_user_id = auth.uid()
    )
  );

CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND operator_user_id = auth.uid()
    )
  );

-- ============================================================
-- 8. `inbox_scope` É COLUNA DE PRIVILÉGIO
--
-- Sem isto, o escopo não vale nada: `profiles_update` deixa cada um
-- editar a própria linha, então bastaria
--
--   UPDATE profiles SET inbox_scope = 'all' WHERE user_id = auth.uid();
--
-- direto do navegador para um operador voltar a enxergar a conta
-- inteira. É a mesma auto-promoção que a migration 034 fechou para
-- `account_role` e `account_id`, e a defesa é a mesma: o gatilho
-- recusa a alteração quando quem chama é o papel `authenticated`.
--
-- Os escritores legítimos passam: o RPC abaixo é SECURITY DEFINER
-- (roda como `postgres`) e o backend usa `service_role`.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.inbox_scope IS DISTINCT FROM OLD.inbox_scope)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and inbox_scope cannot be changed directly; use the account member RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

-- ============================================================
-- 9. O RPC QUE DEFINE O ESCOPO
--
-- Mesmo desenho de `set_member_role` (migration 018): SECURITY
-- DEFINER, autorização feita aqui dentro, SQLSTATEs que a rota HTTP
-- já sabe traduzir (42501 → 403, 22023 → 400).
--
-- O dono da conta não pode ser colocado em 'own'. Ele é quem
-- responde pela conta inteira, e um proprietário que não enxerga as
-- próprias conversas é uma armadilha, não uma configuração — para
-- limitar o que ele vê, primeiro transfira a propriedade.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_inbox_scope(
  p_user_id UUID,
  p_scope TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account UUID;
  v_target_account UUID;
  v_target_role account_role_enum;
BEGIN
  IF p_scope NOT IN ('all', 'own') THEN
    RAISE EXCEPTION 'inbox_scope must be all or own' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_caller_account
  FROM profiles WHERE user_id = auth.uid();

  IF v_caller_account IS NULL OR NOT is_account_member(v_caller_account, 'admin') THEN
    RAISE EXCEPTION 'Only admins can change a member''s inbox scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_target_account, v_target_role
  FROM profiles WHERE user_id = p_user_id;

  IF v_target_account IS DISTINCT FROM v_caller_account THEN
    RAISE EXCEPTION 'That member is not in your account' USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'owner' AND p_scope = 'own' THEN
    RAISE EXCEPTION 'The account owner always sees every conversation'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET inbox_scope = p_scope, updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_inbox_scope(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_inbox_scope(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_inbox_scope(UUID, TEXT) TO authenticated;

-- ============================================================
-- 10. ÍNDICE DE APOIO
--
-- `can_access_conversation` faz um lookup por (id, account_id,
-- operator_user_id) a cada linha avaliada quando o escopo é 'own'.
-- O índice do item 2 já cobre (account_id, operator_user_id); este
-- aqui serve o caminho inverso, de conversa para número.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_config
  ON conversations (whatsapp_config_id);
