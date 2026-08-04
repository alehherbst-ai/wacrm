import { NextResponse, after } from 'next/server';
import crypto from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { getGroupInfo, downloadMessageMedia } from '@/lib/whatsapp/uazapi-api';
import { persistInboundMedia } from '@/lib/whatsapp/inbound-media';
import {
  processInboundMessage,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound-pipeline';

// UAZAPI has no per-request signature (unlike Meta's x-hub-signature-256)
// — instead a random secret is embedded in the callback URL itself
// (generated at connect time, see uazapi/connect/route.ts), scoped to
// one whatsapp_config row via [connectionId]. See the plan's "webhook
// auth" decision.
export const maxDuration = 60;

let _adminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * UAZAPI's Message schema (confirmed fields, per the account's
 * uazapi-openapi-spec.yaml — the spec documents REST request/response
 * shapes but not a concrete webhook delivery envelope example, so the
 * top-level wrapping below is a best-effort inference; verify against
 * a real delivery and adjust before relying on this in production).
 */
interface UazapiMessage {
  messageid?: string;
  chatid?: string;
  sender?: string;
  senderName?: string;
  fromMe?: boolean;
  messageType?: string;
  messageTimestamp?: number;
  text?: string;
  quoted?: string;
  reaction?: string;
  buttonOrListid?: string;
  /**
   * Present on messages UAZAPI has already materialised a file for.
   * Inbound deliveries generally arrive WITHOUT it — the bytes are
   * still encrypted on WhatsApp's CDN — which is what
   * `downloadMessageMedia` exists to resolve.
   */
  fileURL?: string;
  /** Suggested file name, documents only. */
  docName?: string;
  wasSentByApi?: boolean;
  /** True for messages posted in a WhatsApp group rather than a 1:1 chat. */
  isGroup?: boolean;
}

interface UazapiWebhookBody {
  event?: string;
  message?: UazapiMessage;
  messages?: UazapiMessage[];
}

type NormalizedContentType = NormalizedInboundMessage['contentType'];

/**
 * Map UAZAPI's `messageType` onto our `content_type`.
 *
 * UAZAPI reports WhatsApp's raw protocol names — PascalCase with a
 * `Message` suffix (`ImageMessage`, `AudioMessage`, `Conversation`,
 * `ExtendedTextMessage`). An earlier version compared those against
 * lowercase bare words (`image`, `audio`), so nothing ever matched:
 * every inbound photo and voice note was filed as plain text with no
 * media URL, which is why they never appeared in the thread.
 *
 * Normalising (lowercase, drop the `message` suffix) accepts both that
 * shape and a bare `image`/`audio`, so a provider change in either
 * direction keeps working.
 */
function mapContentType(rawType: string | undefined): NormalizedContentType {
  const key = (rawType ?? '').toLowerCase().replace(/message$/, '');
  switch (key) {
    case 'image':
    // Stickers are images as far as rendering and storage go.
    case 'sticker':
      return 'image';
    case 'video':
    // Push-to-video (round video note).
    case 'ptv':
      return 'video';
    case 'audio':
    // Push-to-talk (voice note).
    case 'ptt':
      return 'audio';
    case 'document':
      return 'document';
    case 'location':
      return 'location';
    default:
      return 'text';
  }
}

const MEDIA_CONTENT_TYPES = new Set<NormalizedContentType>([
  'image',
  'video',
  'document',
  'audio',
]);

function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  const [local] = jid.split('@');
  if (!local) return null;
  return normalizePhone(local);
}

/**
 * A group message's `chatid` is the group's own JID (e.g.
 * `120363123456789012@g.us`). `isGroup` is the primary signal; the
 * `@g.us` suffix check is a defensive fallback in case a delivery
 * omits it.
 */
function isGroupMessage(msg: UazapiMessage): boolean {
  return msg.isGroup === true || Boolean(msg.chatid?.endsWith('@g.us'));
}

function toNormalizedMessage(msg: UazapiMessage): NormalizedInboundMessage | null {
  const isGroup = isGroupMessage(msg);

  // Identity ALWAYS comes from `chatid`, never from `sender`.
  //
  // `chatid` is the conversation's own JID: the group for a group chat,
  // and the counterparty's phone JID (`5548…@s.whatsapp.net`) for a 1:1.
  // `sender` is *who typed*, and WhatsApp increasingly reports that as a
  // LID (`135622383648774@lid`) — an opaque per-contact identifier, NOT
  // a phone number. Keying 1:1 contacts off `sender` stored those LIDs
  // in `contacts.phone`, and every reply then failed with UAZAPI's
  // "no LID found for <lid>@s.whatsapp.net from server" because we were
  // asking the server to deliver to an id it only accepts under the
  // `@lid` domain.
  //
  // A LID chatid would be equally unusable as a phone, so it's rejected
  // outright rather than silently persisted as a bad number.
  if (msg.chatid?.includes('@lid')) {
    console.warn(
      '[uazapi-webhook] dropping message whose chatid is a LID, not a phone:',
      msg.chatid
    );
    return null;
  }

  const senderPhone = jidToPhone(msg.chatid);
  if (!senderPhone || !msg.messageid) return null;

  const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp) : new Date();
  const senderName = msg.senderName || senderPhone;
  // In a group, `senderName` names the participant who wrote; in a 1:1
  // it names the counterparty, who is already the contact.
  const senderDisplayName = isGroup ? msg.senderName || null : null;

  // A reaction event carries the target message id in `reaction` and
  // the emoji in `text` — everything else is ignored downstream.
  if (msg.reaction) {
    return {
      providerMessageId: msg.messageid,
      senderPhone,
      senderName,
      timestamp,
      contentType: 'text',
      contentText: null,
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
      reaction: { targetProviderId: msg.reaction, emoji: msg.text || '' },
      isGroup,
      senderDisplayName,
    };
  }

  const contentType = mapContentType(msg.messageType);

  return {
    providerMessageId: msg.messageid,
    senderPhone,
    senderName,
    timestamp,
    contentType,
    contentText: msg.text || null,
    // Resolved separately by the caller, which has the instance token
    // needed to fetch the file (see resolveMediaUrl).
    mediaUrl: null,
    interactiveReplyId: msg.buttonOrListid || null,
    replyToProviderId: msg.quoted || null,
    reaction: null,
    isGroup,
    senderDisplayName,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectionId: string; secret: string }> }
) {
  const { connectionId, secret } = await params;

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, user_id, provider, uazapi_webhook_secret, uazapi_instance_token')
    .eq('id', connectionId)
    .eq('provider', 'uazapi')
    .maybeSingle();

  if (configError || !config || !config.uazapi_webhook_secret) {
    // 404, not 401 — don't confirm/deny which connectionIds exist.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let expectedSecret: string;
  try {
    expectedSecret = decrypt(config.uazapi_webhook_secret);
  } catch {
    console.error('[uazapi-webhook] stored secret could not be decrypted for', connectionId);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const provided = Buffer.from(secret);
  const expected = Buffer.from(expectedSecret);
  const matches =
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
  if (!matches) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: UazapiWebhookBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const messages = body.messages ?? (body.message ? [body.message] : []);

  // The top-level envelope (`event` + `message`/`messages`) is a
  // best-effort inference — the UAZAPI spec documents REST request/
  // response shapes but not a concrete webhook delivery example (see
  // the file-level comment). Log unrecognized deliveries so a real
  // payload shape can be captured and this fixed for good, instead of
  // silently dropping every event.
  if (messages.length === 0) {
    console.warn(
      '[uazapi-webhook] delivery had no `message`/`messages` — event:',
      body.event,
      'raw body:',
      JSON.stringify(body).slice(0, 2000)
    );
  }

  after(async () => {
    for (const msg of messages) {
      try {
        // Our own outbound sends land back here as `fromMe`/`wasSentByApi`
        // — skip them, we already persisted them in send-message.ts.
        if (msg.fromMe || msg.wasSentByApi) continue;

        const normalized = toNormalizedMessage(msg);
        if (!normalized) {
          console.warn(
            '[uazapi-webhook] message did not normalize (missing sender/messageid?):',
            JSON.stringify(msg).slice(0, 2000)
          );
          continue;
        }

        // Media arrives as a reference, not a file: the bytes are still
        // encrypted on WhatsApp's CDN until /message/download decrypts
        // and republishes them. Resolve here (the token lives on this
        // route) and copy into Storage so the attachment outlives the
        // provider's retention. Failure downgrades the message to its
        // caption rather than dropping it.
        if (MEDIA_CONTENT_TYPES.has(normalized.contentType)) {
          try {
            const instanceToken = decrypt(config.uazapi_instance_token);
            const file = await downloadMessageMedia({
              instanceToken,
              messageId: normalized.providerMessageId,
            });
            normalized.mediaUrl = await persistInboundMedia({
              db: supabaseAdmin(),
              accountId: config.account_id,
              sourceUrl: file.fileURL,
              mimetype: file.mimetype,
              fileName: msg.docName ?? null,
            });
          } catch (err) {
            console.error(
              '[uazapi-webhook] could not resolve media for',
              normalized.providerMessageId,
              err instanceof Error ? err.message : err
            );
          }
        }

        await processInboundMessage(normalized, {
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          whatsappConfigId: config.id,
          resolveGroupName:
            normalized.isGroup && msg.chatid
              ? async () => {
                  const instanceToken = decrypt(config.uazapi_instance_token);
                  const info = await getGroupInfo({ instanceToken, groupJid: msg.chatid! });
                  return info.name;
                }
              : undefined,
        });
      } catch (error) {
        console.error('[uazapi-webhook] error processing message:', error);
      }
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
