-- ============================================================
-- 038_group_chats.sql — WhatsApp group chat support.
--
-- Why this exists:
--   Nothing in the schema distinguished a WhatsApp group from an
--   individual contact. Every inbound message was attributed to
--   whichever phone number the provider reported as the "sender" —
--   for a group message (UAZAPI/Baileys-backed sessions do deliver
--   real groups, unlike Meta's Cloud API) that's the individual
--   member who posted, not the group itself. Result: every person
--   who wrote in a group became a separate contact + conversation,
--   fragmenting a single group thread into N fake 1:1 chats.
--
-- What this migration does:
--   1. contacts.is_group — a group is stored as a contact row like
--      any other (same UNIQUE(account_id, phone_normalized) index
--      already dedupes it for free — the group's JID digits go in
--      `phone`, same field a person's number would use). The flag
--      exists so the app can (a) route group lookups through an
--      EXACT phone match instead of the fuzzy last-8-digit dedupe
--      used for real phone numbers — a WhatsApp group id has no
--      "trunk prefix" ambiguity to tolerate, and fuzzy-matching an
--      18-20 digit synthetic id risks false-positive collisions —
--      and (b) render a group icon instead of a phone-shaped avatar.
--   2. messages.sender_display_name — which group participant sent
--      THIS message. Null for 1:1 conversations (the contact's own
--      name already answers that) and for outbound messages.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_display_name TEXT;

-- Fast path for the group find-or-create's exact lookup
-- (account_id, phone_normalized, is_group) — the general-purpose
-- idx_contacts_account_phone_normalized index (migration 022) already
-- covers (account_id, phone_normalized); this one narrows further so
-- the group-only query plan doesn't need to filter is_group in a
-- second pass over a potentially large per-account contact set.
CREATE INDEX IF NOT EXISTS idx_contacts_account_group_phone
  ON contacts(account_id, phone_normalized)
  WHERE is_group = true;
