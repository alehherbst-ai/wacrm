-- ============================================================
-- 052_lock_down_security_definer.sql — fechar as funções internas
--
-- No Supabase, toda função nova em `public` nasce com EXECUTE
-- concedido DIRETAMENTE a `anon` e `authenticated`. Um grant direto
-- NÃO é alcançado por `REVOKE ... FROM PUBLIC` — que é o que quase
-- todas as migrations deste repo fizeram (018, 019, 022, 025, 030,
-- 032, 036, 043, 044, 047, 049…). Só a 007, a 012 e a 050 revogam do
-- trio correto.
--
-- Resultado: dezenas de funções SECURITY DEFINER — que por definição
-- IGNORAM RLS — ficaram chamáveis por qualquer usuário autenticado.
--
-- O caso mais sério é `handover_conversation_core` (047): recebe um
-- registro `conversations` COMPOSTO, montado pelo chamador, e ESCREVE
-- a partir dele — cria e altera conversas, pausa flow_runs. Nada nela
-- valida que o registro recebido corresponde a uma linha real, porque
-- ela foi escrita para ser chamada só por `transfer_conversation` e
-- `pull_conversation`, que validam antes. Exposta diretamente, é
-- escrita entre inquilinos.
--
-- ============================================================
-- COMO ESTA MIGRATION DECIDE
--
-- Por allowlist, não por lista de alvos. Enumerar as funções a fechar
-- deixaria de fora qualquer uma que eu não tenha visto, e a próxima
-- função nova nasceria aberta de novo. Aqui o padrão se inverte:
-- fecha-se tudo que é SECURITY DEFINER em `public`, exceto o que o
-- aplicativo comprovadamente chama.
--
-- A allowlist saiu de `grep -r "\.rpc("` no código — são as funções
-- que o cliente ou uma rota da API invocam pelo PostgREST. Todas elas
-- checam `auth.uid()` internamente; é isso que as torna seguras de
-- expor, não o fato de estarem nesta lista.
--
-- FICAM DE FORA DO FECHAMENTO, e por motivos diferentes:
--
--   * As RPCs do aplicativo (allowlist abaixo). Fechá-las quebraria a
--     transferência, os convites, o painel de membros e a busca por
--     tags no mesmo instante.
--
--   * `peek_invitation` precisa de `anon`: quem abre um link de
--     convite ainda não fez login. `redeem_invitation` fica junto por
--     precaução — quebrar o fluxo de convite às vésperas do
--     lançamento custa mais do que o risco que ela representa, e ela
--     valida o token por hash.
--
--   * Os três helpers de RLS (`is_account_member`,
--     `can_access_conversation`, `can_read_conversation`). Duas razões:
--     eles só respondem sobre o PRÓPRIO chamador ("eu sou membro
--     desta conta?"), então expostos não vazam nada de terceiros; e
--     são avaliados dentro de policies, onde a interação entre
--     privilégio de EXECUTE e avaliação de política merece ser
--     verificada num banco antes de mexer. Errar aí derruba o RLS da
--     aplicação inteira.
--
-- Funções de gatilho não precisam de EXECUTE do chamador: o privilégio
-- é checado na criação do gatilho, não a cada disparo. E uma função
-- SECURITY DEFINER roda como o dono, então `transfer_conversation`
-- continua podendo chamar `handover_conversation_core` mesmo depois
-- desta migration. `service_role` também não é tocado — o webhook de
-- entrada e os motores dependem dele.
--
-- ------------------------------------------------------------
-- COMO REVERTER
--
--   GRANT EXECUTE ON FUNCTION public.<nome>(<args>) TO authenticated;
--
-- Uma por uma, e só a que se quiser reabrir. Não há reversão em massa
-- de propósito: reabrir tudo restauraria a exposição que esta
-- migration existe para fechar.
-- ------------------------------------------------------------
--
-- Idempotente.
-- ============================================================

DO $$
DECLARE
  v_fn RECORD;
  v_closed INTEGER := 0;
  v_kept INTEGER := 0;

  -- Chamadas pelo cliente ou por uma rota da API sob a sessão do
  -- usuário. Origem: grep por `.rpc(` no código.
  v_app_rpc TEXT[] := ARRAY[
    'filter_contacts_by_tags',
    'increment_automation_execution_count',
    'increment_flow_execution_count',
    'match_ai_knowledge_fts',
    'match_ai_knowledge_semantic',
    'notify_due_activities',
    'peek_invitation',
    'pull_conversation',
    'record_webhook_failure',
    'redeem_invitation',
    'remove_account_member',
    'set_member_inbox_scope',
    'set_member_role',
    'touch_presence',
    'transfer_account_ownership',
    'transfer_conversation'
  ];

  -- Avaliados dentro de policies. Verificar num banco antes de mexer.
  v_rls_helpers TEXT[] := ARRAY[
    'is_account_member',
    'can_access_conversation',
    'can_read_conversation'
  ];
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure AS signature, p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef          -- só SECURITY DEFINER
    ORDER BY p.proname
  LOOP
    IF v_fn.name = ANY(v_app_rpc) OR v_fn.name = ANY(v_rls_helpers) THEN
      v_kept := v_kept + 1;
      CONTINUE;
    END IF;

    -- Os três juntos: PUBLIC não alcança o grant direto, e o grant
    -- direto é o que o Supabase cria.
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      v_fn.signature);
    v_closed := v_closed + 1;
  END LOOP;

  RAISE NOTICE '052: % função(ões) fechada(s), % mantida(s) abertas por desenho.',
    v_closed, v_kept;
END $$;

-- ============================================================
-- VERIFICAÇÃO
--
-- Falha alto e claro se `handover_conversation_core` — a razão de esta
-- migration existir — continuar alcançável. Melhor abortar do que
-- reportar sucesso sobre uma porta que ficou aberta.
-- ============================================================
DO $$
DECLARE
  v_open INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_open
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'handover_conversation_core'
    AND (
      has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
    );

  IF v_open > 0 THEN
    RAISE EXCEPTION
      '052 falhou: handover_conversation_core continua executável por anon/authenticated.';
  END IF;

  RAISE NOTICE '052: handover_conversation_core fechada. OK.';
END $$;
