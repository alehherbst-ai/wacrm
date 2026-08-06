-- ============================================================
-- 043_invite_ignores_empty_pipeline.sql
--
-- Fixes an invitation that gets refused because the invitee looked
-- around.
--
-- The problem
--   `redeem_invitation` (migration 019) refuses to move a caller into
--   the inviting account when their own personal account holds any
--   domain data. That guard is right: joining deletes the personal
--   account, and nobody should lose contacts or deals by clicking
--   "accept".
--
--   But `pipelines` was on that list, and a pipeline is the one thing
--   in this app that appears WITHOUT anyone creating it: the Pipelines
--   screen seeds a default "Sales Pipeline" on first visit (see
--   src/app/(dashboard)/pipelines/page.tsx). So the sequence
--
--     sign up  →  sign in  →  click "Pipelines"  →  accept the invite
--
--   ended at "Your account already contains data; sign up with a
--   different email to join this one." The invitee was forced to
--   create a second email address because they opened a menu. Nothing
--   about their account was worth protecting — the pipeline was empty
--   and they had never touched it.
--
-- The fix
--   A funnel counts as data when it holds DEALS, not when it merely
--   exists. Swapping the `pipelines` probe for a `deals` probe (joined
--   through pipelines, so a deal counts regardless of whether its own
--   nullable `account_id` was backfilled) keeps every case the guard
--   was written for and drops the one it was never meant to catch.
--
--   Trade-off, stated plainly: someone who hand-builds a pipeline with
--   custom stages, adds no deals to it, and then joins another account
--   loses that pipeline. They were abandoning the account it lived in
--   either way, and it contained no work. That is a far better outcome
--   than blocking every invited teammate who clicked the wrong menu
--   first.
--
--   The empty pipeline and its stages disappear with the personal
--   account at the end of the function — `pipelines.account_id` is
--   ON DELETE CASCADE (migration 017) and `pipeline_stages.pipeline_id`
--   cascades from the pipeline (migration 001). No explicit cleanup
--   needed.
--
-- Everything else about the function is unchanged: same signature,
-- same lock, same ownership check, same SQLSTATEs, same return value.
--
-- Idempotent — CREATE OR REPLACE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it holds work
  -- they would lose — contacts, conversations, deals, broadcasts,
  -- automations, flows, templates, tags, custom fields, notes, a
  -- connected WhatsApp number.
  --
  -- Funnels are probed through their DEALS rather than directly: an
  -- empty pipeline is created for every account by simply opening the
  -- Pipelines screen, so treating its existence as "data" refused
  -- invitations to people who had done nothing but look (see the
  -- header of this migration).
  --
  -- If a future screen starts creating rows on first view the same
  -- way, add it to this exemption rather than to the list — the guard
  -- is about protecting WORK, not about detecting activity.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals d
      JOIN pipelines p ON p.id = d.pipeline_id
      WHERE p.account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. It holds no work by the
  -- checks above; an untouched default pipeline (and its stages) may
  -- still be attached, and goes with it via ON DELETE CASCADE.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
