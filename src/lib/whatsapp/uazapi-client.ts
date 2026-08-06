/**
 * Resolves an account's UAZAPI connection into a ready-to-use sender.
 *
 * Replaces the former `providers/` abstraction. That layer existed to
 * answer "Meta or UAZAPI?" for every outbound message; with UAZAPI as
 * the only provider there is nothing to choose, so the indirection —
 * a provider interface, capability flags, per-provider implementations
 * and a resolver that had to consider the conversation's own channel —
 * collapses into this one lookup.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import {
  sendText,
  sendMedia,
  sendMenu,
  sendReaction,
  type UazapiMediaKind,
} from '@/lib/whatsapp/uazapi-api';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

export class WhatsAppNotConfiguredError extends Error {
  constructor(
    message = 'WhatsApp not connected. Connect a number in Settings → WhatsApp first.'
  ) {
    super(message);
    this.name = 'WhatsAppNotConfiguredError';
  }
}

// The row shape is the `whatsapp_config` table; callers that need a
// specific column read it off `.config` directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WhatsappConfigRow = any;

export interface SendResult {
  /** UAZAPI's own id for the sent message. */
  messageId: string;
}

export interface UazapiSender {
  sendText(args: { to: string; text: string; replyToId?: string }): Promise<SendResult>;
  sendMedia(args: {
    to: string;
    kind: UazapiMediaKind;
    link: string;
    caption?: string;
    filename?: string;
    replyToId?: string;
  }): Promise<SendResult>;
  sendInteractive(args: {
    to: string;
    payload: InteractiveMessagePayload;
    replyToId?: string;
  }): Promise<SendResult>;
  sendReaction(args: {
    to: string;
    targetMessageId: string;
    emoji: string;
  }): Promise<SendResult>;
}

export interface ResolvedConnection {
  config: WhatsappConfigRow;
  send: UazapiSender;
}

/**
 * Load an account's default WhatsApp connection and bind a sender.
 *
 * "Default" means the house number — the connection with no operator
 * assigned — falling back to the oldest one when every number belongs
 * to somebody. Since migration 044 an account can hold several numbers
 * (one per operator), so this answers "which number does the ACCOUNT
 * speak with", which is only the right question when no conversation
 * is in play: starting a thread from a typed number, validating a
 * contact, a settings-level probe.
 *
 * Anything replying inside a conversation must use
 * `resolveConnectionForConversation` instead — a reply has to leave
 * from the number the customer wrote to.
 *
 * Throws `WhatsAppNotConfiguredError` when the account has not
 * connected a number yet — callers map that onto their own error shape
 * (a 400 for API routes, a thrown step failure for the engines).
 */
export async function resolveConnection(
  db: SupabaseClient,
  accountId: string
): Promise<ResolvedConnection> {
  const { data: rows, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    // House number first, then oldest. `nullsFirst` is what makes the
    // unassigned connection win; without an explicit order this picked
    // an arbitrary row once an account had more than one.
    .order('operator_user_id', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(1);

  if (error || !rows || rows.length === 0) {
    throw new WhatsAppNotConfiguredError();
  }

  return bindConnection(db, rows[0]);
}

/**
 * Load the connection a specific conversation belongs to.
 *
 * This is the one that matters for replies. Each conversation records
 * which connection delivered it (`whatsapp_config_id`, migration 037,
 * kept current by the inbound pipeline), and a reply that left from a
 * different number would reach the customer as a message from a
 * stranger — in a chat they never opened.
 *
 * Falls back to the account default only when the conversation has no
 * connection recorded, which is the case for threads created before
 * migration 037 and for rows the 044 backfill could not resolve.
 */
export async function resolveConnectionForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<ResolvedConnection> {
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (convError) {
    console.error(
      '[uazapi-client] conversation lookup failed, using the account default:',
      convError.message
    );
    return resolveConnection(db, accountId);
  }

  const configId = conversation?.whatsapp_config_id as string | null | undefined;
  if (!configId) return resolveConnection(db, accountId);

  const { data: rows, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', configId)
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .limit(1);

  // A connection that was deleted while its conversations survived
  // leaves a dangling id. Better to answer from the account default
  // than to refuse to reply at all.
  if (error || !rows || rows.length === 0) {
    return resolveConnection(db, accountId);
  }

  return bindConnection(db, rows[0]);
}

function bindConnection(
  db: SupabaseClient,
  config: WhatsappConfigRow
): ResolvedConnection {
  const instanceToken = decryptAndMaybeUpgrade(
    db,
    config.id,
    'uazapi_instance_token',
    config.uazapi_instance_token
  );

  return { config, send: createSender(instanceToken) };
}

function createSender(instanceToken: string): UazapiSender {
  return {
    async sendText({ to, text, replyToId }) {
      const r = await sendText({ instanceToken, to, text, replyId: replyToId });
      return { messageId: r.messageId };
    },

    async sendMedia({ to, kind, link, caption, filename, replyToId }) {
      const r = await sendMedia({
        instanceToken,
        to,
        kind,
        file: link,
        caption,
        filename,
        replyId: replyToId,
      });
      return { messageId: r.messageId };
    },

    async sendInteractive({ to, payload, replyToId }) {
      // The payload's `header` has no UAZAPI equivalent — its menus
      // carry body + footer only. Fold it into the body so the text the
      // author wrote still reaches the customer instead of being
      // silently dropped.
      const text = payload.header ? `*${payload.header}*\n\n${payload.body}` : payload.body;

      const r =
        payload.kind === 'buttons'
          ? await sendMenu({
              instanceToken,
              to,
              kind: 'buttons',
              text,
              footerText: payload.footer,
              buttons: payload.buttons,
              replyId: replyToId,
            })
          : await sendMenu({
              instanceToken,
              to,
              kind: 'list',
              text,
              footerText: payload.footer,
              listButton: payload.button_label,
              sections: payload.sections,
              replyId: replyToId,
            });
      return { messageId: r.messageId };
    },

    async sendReaction({ to, targetMessageId, emoji }) {
      const r = await sendReaction({ instanceToken, to, targetMessageId, emoji });
      return { messageId: r.messageId };
    },
  };
}

/**
 * Decrypt a token column and, if it's still in the legacy CBC format,
 * fire-and-forget an upgrade to GCM. Idempotent; a failure here only
 * means the next read repeats the work.
 */
function decryptAndMaybeUpgrade(
  db: SupabaseClient,
  rowId: string,
  column: string,
  encrypted: string
): string {
  const value = decrypt(encrypted);
  if (isLegacyFormat(encrypted)) {
    void db
      .from('whatsapp_config')
      .update({ [column]: encrypt(value) })
      .eq('id', rowId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            `[uazapi-client] ${column} GCM upgrade failed for ${rowId}:`,
            error.message
          );
        }
      });
  }
  return value;
}
