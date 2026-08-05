-- ============================================================
-- 041_activities.sql
--
-- Scheduled follow-up work ("atividades"): a titled task with a
-- deadline, usually hanging off a contact, surfaced in a calendar and
-- a Kanban board and announced through the existing notifications bell
-- when its moment arrives.
--
-- Design notes
--
--   * `due_at` is TIMESTAMPTZ, not DATE. "Call back Tuesday at 3pm" is
--     the normal case; a date-only column would force every activity to
--     the same position within a day and make the day/week calendar
--     views meaningless. Callers that only care about the day simply
--     ignore the time.
--
--   * The Kanban buckets (overdue / today / tomorrow / next 3 days /
--     later) are NOT stored. They are derived from `due_at` against the
--     viewer's own clock, because "today" depends on the reader's
--     timezone and would otherwise be wrong for anyone outside the
--     account's default. Storing the bucket would also mean rewriting
--     every row at midnight.
--
--   * `contact_id` is nullable. Activities are created from a contact
--     today, but a standalone reminder is a natural next step and
--     nothing here needs to change to allow it. ON DELETE CASCADE:
--     a follow-up for a deleted contact has nothing left to follow up.
--
--   * `assigned_to` is who must DO the work and who gets notified;
--     `user_id` is who created it. They differ as soon as an account
--     has more than one agent.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Creator.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Who owes the work. Defaults to the creator at insert time in the
  -- app; SET NULL rather than CASCADE so removing a teammate orphans
  -- the task instead of silently deleting outstanding work.
  assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  -- Set once the due-date notification has been raised, so the sweep
  -- below is idempotent and a task can't spam the bell every time
  -- someone opens the app.
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The calendar and board both read "this account's activities ordered
-- by deadline"; the partial index serves the sweep, which only ever
-- looks at unfinished, un-notified work.
CREATE INDEX IF NOT EXISTS idx_activities_account_due
  ON activities(account_id, due_at);
CREATE INDEX IF NOT EXISTS idx_activities_contact
  ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_pending_notify
  ON activities(due_at)
  WHERE completed_at IS NULL AND notified_at IS NULL;

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;

-- Same shape as deals/contacts (migration 017): members read, agents
-- and above write.
DROP POLICY IF EXISTS activities_select ON activities;
DROP POLICY IF EXISTS activities_insert ON activities;
DROP POLICY IF EXISTS activities_update ON activities;
DROP POLICY IF EXISTS activities_delete ON activities;
CREATE POLICY activities_select ON activities FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY activities_insert ON activities FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY activities_update ON activities FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY activities_delete ON activities FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Keep `updated_at` honest without every caller remembering to set it.
CREATE OR REPLACE FUNCTION touch_activities_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_activities_updated ON activities;
CREATE TRIGGER on_activities_updated
  BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION touch_activities_updated_at();

-- ============================================================
-- Notifications — new type
-- ============================================================
-- The CHECK from migration 027 only allowed 'conversation_assigned'.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'activity_due'));

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS activity_id UUID REFERENCES activities(id) ON DELETE CASCADE;

-- ============================================================
-- Due-date sweep
--
-- This app has no scheduled job runner, so instead of a cron the sweep
-- is an idempotent RPC the client calls when it loads. That is not a
-- compromise for this feature: a notification exists to be seen, and
-- the moments someone has the CRM open are exactly the moments it can
-- be seen. Anything already due gets its notification the first time
-- anyone in the account looks.
--
-- SECURITY DEFINER so it can write `notifications` (which has no client
-- INSERT policy, by design — see migration 027) — but it only ever
-- touches accounts the CALLER belongs to, enforced explicitly below
-- rather than inherited from RLS, since definer rights bypass RLS.
-- ============================================================
CREATE OR REPLACE FUNCTION notify_due_activities()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;

  WITH due AS (
    SELECT a.*
    FROM activities a
    WHERE a.completed_at IS NULL
      AND a.notified_at IS NULL
      AND a.due_at <= NOW()
      -- Definer rights bypass RLS, so membership is checked here.
      AND is_account_member(a.account_id)
      -- Nobody to tell.
      AND a.assigned_to IS NOT NULL
    FOR UPDATE
  ), inserted AS (
    INSERT INTO notifications (
      account_id, user_id, type, contact_id, activity_id,
      actor_user_id, title, body
    )
    SELECT
      d.account_id,
      d.assigned_to,
      'activity_due',
      d.contact_id,
      d.id,
      NULL,
      d.title,
      COALESCE(
        (SELECT COALESCE(NULLIF(c.name, ''), c.phone)
         FROM contacts c WHERE c.id = d.contact_id),
        ''
      )
    FROM due d
    RETURNING activity_id
  )
  UPDATE activities
  SET notified_at = NOW()
  WHERE id IN (SELECT activity_id FROM inserted);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION notify_due_activities() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION notify_due_activities() TO authenticated;

-- Realtime, so a teammate creating a task shows up on an open board
-- without a refresh (the app already subscribes per-table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'activities'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE activities;
  END IF;
END $$;
