/**
 * Imports WhatsApp profile pictures onto `contacts.avatar_url`.
 *
 * The provider hands back a signed `pps.whatsapp.net` link that expires
 * in about ten days, so the bytes are copied into the `contact-avatars`
 * bucket (migration 039) and the durable Supabase URL is what gets
 * stored. Hot-linking would look correct on the day it was written and
 * turn every avatar into a broken image the following week.
 *
 * Sibling of `inbound-media.ts`, which does the same copy-and-own dance
 * for message attachments. Kept separate: attachments are immutable and
 * accumulate per message, whereas an avatar is a single current object
 * per contact that gets overwritten when the picture changes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const CONTACT_AVATARS_BUCKET = 'contact-avatars';

/** Mirrors the bucket's `file_size_limit` (migration 039). */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * How long a stored avatar is trusted before we ask the provider again.
 *
 * Without a refresh the very first picture would be frozen forever, so
 * a contact who changes their photo keeps showing the old one for the
 * life of the CRM. A week is the cheap middle: one extra `/chat/details`
 * call per contact per week, against a picture that is at most a week
 * stale.
 */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Extensions for the MIME types the bucket accepts. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Should this contact's picture be fetched right now?
 *
 * Gates on `avatar_synced_at` rather than `avatar_url` because the two
 * answer different questions: a contact who hides their picture under
 * WhatsApp's privacy settings will never have a URL, and keying off the
 * URL would re-ask the provider on every message they ever send.
 */
export function shouldSyncAvatar(
  contact: { avatar_synced_at?: string | null },
  now: number = Date.now()
): boolean {
  if (!contact.avatar_synced_at) return true;
  const syncedAt = new Date(contact.avatar_synced_at).getTime();
  // An unparseable timestamp is treated as never-synced rather than
  // as `NaN < now` (which is false, and would wedge the contact into
  // never refreshing again).
  if (Number.isNaN(syncedAt)) return true;
  return now - syncedAt > STALE_AFTER_MS;
}

export interface SyncContactAvatarArgs {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  /**
   * Resolves the provider's (short-lived) picture URL, or null when the
   * contact has none. Supplied by the webhook route — the only place
   * holding the instance token this lookup needs.
   */
  resolveSourceUrl: () => Promise<string | null>;
}

/**
 * Fetch, store, and record a contact's profile picture.
 *
 * Never throws: an avatar is decoration, and a provider hiccup must not
 * take down the message that triggered it. `avatar_synced_at` is
 * stamped on every attempt — including failures and contacts with no
 * picture — so one bad contact cannot turn into a per-message retry
 * loop against the provider.
 */
export async function syncContactAvatar(
  args: SyncContactAvatarArgs
): Promise<void> {
  const { db, accountId, contactId, resolveSourceUrl } = args;

  let avatarUrl: string | null = null;
  try {
    const sourceUrl = await resolveSourceUrl();
    if (sourceUrl) {
      avatarUrl = await copyToStorage(db, accountId, contactId, sourceUrl);
    }
  } catch (err) {
    console.warn(
      '[contact-avatar] could not import picture for',
      contactId,
      err instanceof Error ? err.message : err
    );
  }

  // Only overwrite `avatar_url` on success. A failed refresh should
  // leave the picture we already have rather than blanking it.
  const patch: Record<string, unknown> = {
    avatar_synced_at: new Date().toISOString(),
  };
  if (avatarUrl) patch.avatar_url = avatarUrl;

  const { error } = await db.from('contacts').update(patch).eq('id', contactId);
  if (error) {
    console.warn('[contact-avatar] could not record sync:', error.message);
  }
}

/**
 * Download the picture and put it in the bucket, returning its public
 * URL. Throws on any failure — the caller logs and moves on.
 */
async function copyToStorage(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  sourceUrl: string
): Promise<string> {
  // Bounded for the same reason as the lookup that produced this URL:
  // the copy runs inline with inbound message processing.
  const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`source fetch returned ${res.status}`);
  }

  // The response's own content-type is authoritative; the provider does
  // not declare one for these, and the bucket validates against the
  // exact string we pass.
  const contentType = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
  const extension = EXTENSION_BY_TYPE[contentType];
  if (!extension) {
    throw new Error(`unsupported picture type ${contentType || '(none)'}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`picture is ${buffer.byteLength} bytes, over the bucket limit`);
  }

  // Deterministic path, overwritten in place: a timestamped name would
  // leave the previous picture orphaned in the bucket on every weekly
  // refresh, with nothing left pointing at it to clean up.
  const path = `account-${accountId}/contact-${contactId}.${extension}`;
  const { error } = await db.storage
    .from(CONTACT_AVATARS_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(error.message);

  const {
    data: { publicUrl },
  } = db.storage.from(CONTACT_AVATARS_BUCKET).getPublicUrl(path);

  // Overwriting a fixed path means the URL never changes, so browsers
  // (and the Supabase CDN) would keep serving the old picture after a
  // refresh. The version stamp busts that without orphaning objects.
  return `${publicUrl}?v=${Date.now()}`;
}
