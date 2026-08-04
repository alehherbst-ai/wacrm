import { NextResponse, after } from 'next/server';
import crypto from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { getGroupInfo } from '@/lib/whatsapp/uazapi-api';
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
  fileURL?: string;
  wasSentByApi?: boolean;
  /** True for messages posted in a WhatsApp group rather than a 1:1 chat. */
  isGroup?: boolean;
}

interface UazapiWebhookBody {
  event?: string;
  message?: UazapiMessage;
  messages?: UazapiMessage[];
}

const MEDIA_TYPES = new Set(['image', 'video', 'document', 'audio']);

function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  const [local] = jid.split('@');
  if (!local) return null;
  return normalizePhone(local);
}

/**
 * A group message's `chatid` is the group's own JID (e.g.
 * `120363123456789012@g.us`); `sender` is the individual member who
 * posted. Routing must key on `chatid` for groups — using `sender`
 * would fragment one group thread into one fake 1:1 chat per member
 * who ever posted in it. `isGroup` is the primary signal; the
 * `@g.us` suffix check is a defensive fallback in case a delivery
 * omits it (the field isn't confirmed against a live payload — see
 * the file-level comment).
 */
function isGroupMessage(msg: UazapiMessage): boolean {
  return msg.isGroup === true || Boolean(msg.chatid?.endsWith('@g.us'));
}

function toNormalizedMessage(msg: UazapiMessage): NormalizedInboundMessage | null {
  const isGroup = isGroupMessage(msg);
  const senderPhone = isGroup
    ? jidToPhone(msg.chatid)
    : jidToPhone(msg.sender) ?? jidToPhone(msg.chatid);
  if (!senderPhone || !msg.messageid) return null;

  const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp) : new Date();
  const senderName = msg.senderName || senderPhone;
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

  const rawType = msg.messageType || 'text';
  const contentType: NormalizedInboundMessage['contentType'] = MEDIA_TYPES.has(rawType)
    ? (rawType as NormalizedInboundMessage['contentType'])
    : rawType === 'location'
      ? 'location'
      : 'text';

  return {
    providerMessageId: msg.messageid,
    senderPhone,
    senderName,
    timestamp,
    contentType,
    contentText: msg.text || null,
    // `fileURL` per the UAZAPI schema is "URL ou referência de arquivo"
    // — if it turns out not to be a stable public URL in practice, this
    // needs a download-and-proxy step mirroring the Meta media route
    // (POST /message/download exists on UAZAPI for that case).
    mediaUrl: MEDIA_TYPES.has(contentType) ? msg.fileURL || null : null,
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
