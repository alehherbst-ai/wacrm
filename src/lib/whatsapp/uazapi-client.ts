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
 * Load the account's WhatsApp connection and bind a sender to it.
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
    .limit(1);

  if (error || !rows || rows.length === 0) {
    throw new WhatsAppNotConfiguredError();
  }

  const config = rows[0];
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
