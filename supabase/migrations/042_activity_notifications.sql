-- ============================================================
-- 042_activity_notifications.sql
--
-- Turns the single "it's due" alert from migration 041 into the three
-- moments that actually matter for a task:
--
--   1. `activity_assigned`   — someone gave you work.
--   2. `activity_due_today`  — it's on today's list.
--   3. `activity_overdue`    — the deadline passed and it's still open.
--
-- Why three columns' worth of bookkeeping instead of one flag: these
-- fire at different times and each must fire at most once. A single
-- `notified_at` cannot express "told them it's due today, haven't yet
-- told them it's late".
--
-- Timezone
--
--   "Today" is a property of the READER, not the server. The heads-up
--   has to arrive when the agent's day starts, and a Brazilian
--   agent's midnight is 03:00 UTC. So the sweep takes the caller's own
--   day boundaries as arguments rather than deriving them from
--   `NOW()`, which would send the notice three hours late (or early,
--   depending which way you're off UTC).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Per-stage bookkeeping
-- ============================================================
-- `notified_at` from 041 becomes the due-today marker; renaming keeps
-- whatever it already recorded instead of dropping and re-alerting.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'activities'
      AND column_name = 'notified_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'activities'
      AND column_name = 'notified_due_at'
  ) THEN
    ALTER TABLE public.activities RENAME COLUMN notified_at TO notified_due_at;
  END IF;
END $$;

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS notified_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_overdue_at TIMESTAMPTZ;

COMMENT ON COLUMN public.activities.notified_due_at IS
  'When the "due today" heads-up was raised. Also stamped when an overdue alert fires, so a task discovered late does not get both bells at once.';
COMMENT ON COLUMN public.activities.notified_overdue_at IS
  'When the "overdue" alert was raised. NULL = the deadline has not passed, or nobody has been told yet.';

-- The sweep scans open work that still owes at least one alert.
DROP INDEX IF EXISTS idx_activities_pending_notify;
CREATE INDEX IF NOT EXISTS idx_activities_pending_notify
  ON activities(due_at)
  WHERE completed_at IS NULL
    AND (notified_due_at IS NULL OR notified_overdue_at IS NULL);

-- ============================================================
-- 2. Notification types
-- ============================================================
-- `activity_due` is kept in the list purely so re-running this on a
-- database that already emitted one can't fail the constraint; nothing
-- writes it any more.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'activity_due',
    'activity_assigned',
    'activity_due_today',
    'activity_overdue'
  ));

-- ============================================================
-- 3. Assignment notification
--
-- Mirrors `notify_conversation_assigned` (migration 027), including
-- the self-assignment skip: "remind me" is the common case, and being
-- told about work you just gave yourself is noise.
-- ============================================================
CREATE OR REPLACE FUNCTION notify_activity_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_to IS NULL
       OR NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
      RETURN NEW;
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_to THEN
    RETURN NEW;
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, contact_id, activity_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_to,
    'activity_assigned',
    NEW.contact_id,
    NEW.id,
    auth.uid(),
    NEW.title,
    COALESCE(
      (SELECT COALESCE(NULLIF(c.name, ''), c.phone)
       FROM contacts c WHERE c.id = NEW.contact_id),
      ''
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block saving the activity.
  RAISE WARNING 'Failed to create activity assignment notification for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_activity_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_activity_assigned ON activities;
CREATE TRIGGER on_activity_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON activities
  FOR EACH ROW EXECUTE FUNCTION notify_activity_assigned();

-- ============================================================
-- 4. Due-today + overdue sweep
--
-- Replaces the single-alert version from 041. Takes the caller's local
-- day boundaries (see the timezone note at the top).
--
-- Overdue is evaluated FIRST and stamps the due-today marker as it
-- goes: a task due at 09:00 that nobody saw until 14:00 should ring
-- once, as late — not twice, as "due today" plus "overdue".
--
-- SECURITY DEFINER to write `notifications` (no client INSERT policy
-- by design, migration 027), with membership checked explicitly since
-- definer rights bypass RLS.
-- ============================================================
DROP FUNCTION IF EXISTS notify_due_activities();

CREATE OR REPLACE FUNCTION notify_due_activities(
  p_day_start TIMESTAMPTZ,
  p_day_end TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_overdue INTEGER := 0;
  v_today INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;

  -- Guard against a caller passing nonsense that would make the
  -- "today" window match everything.
  IF p_day_start IS NULL OR p_day_end IS NULL OR p_day_end <= p_day_start THEN
    RAISE EXCEPTION 'invalid day window';
  END IF;

  -- ---- overdue ----------------------------------------------
  WITH late AS (
    SELECT a.id, a.account_id, a.assigned_to, a.contact_id, a.title
    FROM activities a
    WHERE a.completed_at IS NULL
      AND a.notified_overdue_at IS NULL
      AND a.assigned_to IS NOT NULL
      AND a.due_at < NOW()
      AND is_account_member(a.account_id)
    FOR UPDATE
  ), ins AS (
    INSERT INTO notifications (
      account_id, user_id, type, contact_id, activity_id,
      actor_user_id, title, body
    )
    SELECT
      l.account_id, l.assigned_to, 'activity_overdue', l.contact_id, l.id,
      NULL, l.title,
      COALESCE(
        (SELECT COALESCE(NULLIF(c.name, ''), c.phone)
         FROM contacts c WHERE c.id = l.contact_id),
        ''
      )
    FROM late l
    RETURNING activity_id
  )
  UPDATE activities
  -- The due-today marker is stamped too: that heads-up is moot once
  -- the thing is already late.
  SET notified_overdue_at = NOW(),
      notified_due_at = COALESCE(notified_due_at, NOW())
  WHERE id IN (SELECT activity_id FROM ins);

  GET DIAGNOSTICS v_overdue = ROW_COUNT;

  -- ---- due today --------------------------------------------
  WITH soon AS (
    SELECT a.id, a.account_id, a.assigned_to, a.contact_id, a.title
    FROM activities a
    WHERE a.completed_at IS NULL
      AND a.notified_due_at IS NULL
      AND a.assigned_to IS NOT NULL
      AND a.due_at >= p_day_start
      AND a.due_at < p_day_end
      AND is_account_member(a.account_id)
    FOR UPDATE
  ), ins AS (
    INSERT INTO notifications (
      account_id, user_id, type, contact_id, activity_id,
      actor_user_id, title, body
    )
    SELECT
      s.account_id, s.assigned_to, 'activity_due_today', s.contact_id, s.id,
      NULL, s.title,
      COALESCE(
        (SELECT COALESCE(NULLIF(c.name, ''), c.phone)
         FROM contacts c WHERE c.id = s.contact_id),
        ''
      )
    FROM soon s
    RETURNING activity_id
  )
  UPDATE activities
  SET notified_due_at = NOW()
  WHERE id IN (SELECT activity_id FROM ins);

  GET DIAGNOSTICS v_today = ROW_COUNT;

  RETURN v_overdue + v_today;
END;
$$;

ALTER FUNCTION notify_due_activities(TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION notify_due_activities(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
