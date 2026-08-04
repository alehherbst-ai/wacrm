-- ============================================================
-- 039_contact_avatars.sql
--
-- Imports WhatsApp profile pictures for contacts AND groups the
-- first time they message us, so the inbox shows real faces instead
-- of initials.
--
-- Two pieces:
--
--   1. `contact-avatars` storage bucket. The pictures are NOT hot-
--      linked from WhatsApp: `POST /chat/details` returns a signed
--      `pps.whatsapp.net` URL whose `oe=` parameter is an expiry
--      roughly ten days out (verified against the live instance —
--      `oe=6A7F52A1` decoded to 2026-08-14). Storing that link would
--      show every avatar as a broken image a week later, so the bytes
--      are copied here once and the durable Supabase URL is what
--      lands on `contacts.avatar_url`.
--
--      A dedicated bucket rather than reusing `chat-media` (023):
--      avatars have a different lifecycle (one current object per
--      contact, overwritten on refresh) from message attachments
--      (immutable, kept as long as the thread), and a retention or
--      size policy on one should not drag the other along. Images
--      only, 2 MB — an avatar that large is already absurd.
--
--   2. `contacts.avatar_synced_at`. Tracks that a fetch was ATTEMPTED,
--      which `avatar_url` alone cannot express: a contact with WhatsApp
--      privacy set to hide their picture legitimately has no avatar,
--      and without this column we would re-ask the provider on every
--      single message forever. Stamped on every attempt, successful or
--      not; a NULL means "never tried".
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. contact-avatars storage bucket
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contact-avatars',
  'contact-avatars',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- 2. Storage RLS — account-scoped writes, public reads
--
-- Same predicate shape as chat-media (023) / flow-media (020): the
-- path's first segment is `account-<account_id>`, matched against the
-- caller's own account.
--
-- In practice the writer here is the UAZAPI webhook running under the
-- service role, which bypasses RLS entirely. The policies exist so a
-- future in-app "change contact photo" affordance can write through a
-- user session without needing another migration, and so a stray
-- anon/authenticated client can never write into another account's
-- folder.
--
-- Drop-then-create (Postgres has no CREATE POLICY IF NOT EXISTS).
-- ============================================================
DROP POLICY IF EXISTS "Contact avatars are publicly readable" ON storage.objects;
CREATE POLICY "Contact avatars are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'contact-avatars');

DROP POLICY IF EXISTS "Members can upload contact avatars" ON storage.objects;
CREATE POLICY "Members can upload contact avatars"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'contact-avatars'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update contact avatars" ON storage.objects;
CREATE POLICY "Members can update contact avatars"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'contact-avatars'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete contact avatars" ON storage.objects;
CREATE POLICY "Members can delete contact avatars"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'contact-avatars'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 3. contacts.avatar_synced_at
-- ============================================================
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS avatar_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN public.contacts.avatar_synced_at IS
  'When the WhatsApp profile picture was last FETCHED (not last changed). Stamped even when the contact has no picture, so a contact who hides theirs is not re-queried on every message. NULL = never attempted.';
