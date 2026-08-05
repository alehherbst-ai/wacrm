-- ============================================================
-- 040_conversation_archive.sql
--
-- "Limpar caixa" used to only zero `unread_count`, which left every
-- thread sitting in the list. The agent asked for it to actually clear
-- the inbox: threads go away, and come back on their own the moment
-- the contact writes again, with the history intact.
--
-- Implemented as `archived_at` rather than the existing `status`
-- column, for two reasons:
--
--   1. `status` (open/pending/closed) is a WORKFLOW state the agent
--      sets deliberately — "closed" means handled, and the inbox has a
--      filter for it. Archiving is a VIEW state that the next inbound
--      message silently undoes. Overloading `closed` to also mean
--      "hidden" would make a re-opened thread indistinguishable from
--      one the agent closed on purpose, and would corrupt the closed
--      filter into a junk drawer.
--
--   2. Nothing is deleted. The conversation and every message stay
--      exactly where they were; only the inbox stops listing them.
--      Un-archiving is a single column write from the webhook.
--
-- No index: the inbox fetches the account's conversations and filters
-- client-side (see conversation-list.tsx), so nothing queries on this
-- column server-side. Adding one now would cost writes and buy nothing.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.conversations.archived_at IS
  'When the thread was cleared from the inbox view. Hidden from the conversation list while set; cleared automatically by the inbound webhook when the contact sends a new message. NULL = visible. Distinct from status=closed, which is a deliberate workflow state.';
