/**
 * Server-side persistence for media that arrives on a WhatsApp message.
 *
 * Inbound media reaches us as a link on UAZAPI's own file host. Storing
 * that link directly would work today and rot tomorrow: it lives on the
 * provider's disk, outside our retention control, and disappearing takes
 * the conversation history's images and voice notes with it. So the
 * bytes are copied once into the same `chat-media` bucket the outbound
 * composer already uses, and the durable Supabase URL is what gets
 * persisted on the message.
 *
 * Distinct from `src/lib/storage/upload-media.ts`, which uploads a
 * user-selected File from the browser under the caller's own session.
 * This runs in the webhook — no session, no File — so it streams a
 * remote URL through the service-role client instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMediaPath } from '@/lib/storage/upload-media';

export const CHAT_MEDIA_BUCKET = 'chat-media';

/** Mirrors the bucket's `file_size_limit` (migration 023). */
const MAX_BYTES = 16 * 1024 * 1024;

/** Best-effort extension for the storage path, from the reported MIME. */
function extensionFor(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'application/pdf': 'pdf',
  };
  return map[mimetype.split(';')[0].trim()] ?? 'bin';
}

export interface PersistInboundMediaArgs {
  db: SupabaseClient;
  accountId: string;
  /** URL UAZAPI serves the decrypted file from. */
  sourceUrl: string;
  mimetype: string;
  /** Used only to make the stored object name recognisable. */
  fileName?: string | null;
}

/**
 * Copy a remote media file into Storage and return its public URL.
 *
 * Returns the original `sourceUrl` unchanged if anything goes wrong —
 * a rejected MIME type, an oversized file, a Storage hiccup. A message
 * that renders from the provider's link is far better than one that
 * silently loses its attachment, so this never throws.
 */
export async function persistInboundMedia(
  args: PersistInboundMediaArgs
): Promise<string> {
  const { db, accountId, sourceUrl, mimetype, fileName } = args;

  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) {
      console.warn('[inbound-media] source fetch failed:', res.status, sourceUrl);
      return sourceUrl;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      console.warn(
        `[inbound-media] file is ${buffer.byteLength} bytes, over the ${MAX_BYTES} bucket limit — keeping the provider link.`
      );
      return sourceUrl;
    }

    // Trust the response's own content-type over the provider's report
    // when present; the bucket validates against this exact string.
    const contentType = res.headers.get('content-type')?.split(';')[0].trim() || mimetype;
    const name = fileName?.trim() || `media.${extensionFor(contentType)}`;
    const path = buildMediaPath(accountId, name);

    const { error } = await db.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, buffer, { contentType, upsert: false });

    if (error) {
      console.warn('[inbound-media] storage upload failed:', error.message);
      return sourceUrl;
    }

    const {
      data: { publicUrl },
    } = db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
    return publicUrl;
  } catch (err) {
    console.warn(
      '[inbound-media] persist threw, keeping the provider link:',
      err instanceof Error ? err.message : err
    );
    return sourceUrl;
  }
}
