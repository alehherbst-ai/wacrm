// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp connection,
//   3. sends via UAZAPI (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `SupabaseClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { UazapiMediaKind } from '@/lib/whatsapp/uazapi-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import {
  resolveConnectionForConversation,
  WhatsAppNotConfiguredError,
} from '@/lib/whatsapp/uazapi-client';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  resolveSendTarget,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** UAZAPI's own id for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, interactivePayload } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  // Interactive: validate the full structured payload up front so a bad
  // menu 400s before we hit the network.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // WhatsApp caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    interactivePayload,
  });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  const sendTargets = resolveSendTarget(contact.phone, Boolean(contact.is_group));
  if (sendTargets.length === 0) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400
    );
  }
  const sanitizedPhone = sendTargets[0];

  // The conversation's own connection, not the account's. An account
  // can hold several numbers since migration 044, and a reply has to
  // leave from the number the customer wrote to — otherwise it lands
  // as a message from a stranger, in a chat the customer never opened.
  let connection: Awaited<ReturnType<typeof resolveConnectionForConversation>>;
  try {
    connection = await resolveConnectionForConversation(
      db,
      accountId,
      conversationId
    );
  } catch (err) {
    if (err instanceof WhatsAppNotConfiguredError) {
      throw new SendMessageError('whatsapp_not_configured', err.message, 400);
    }
    throw err;
  }
  const { config, send } = connection;

  // Pin the conversation to this connection if it isn't already, so the
  // thread records which number it belongs to. Best-effort — a failure
  // here shouldn't block the send.
  if (!conversation.whatsapp_config_id) {
    void db
      .from('conversations')
      .update({ whatsapp_config_id: config.id })
      .eq('id', conversationId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] failed to pin conversation to connection:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its provider message id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let replyToId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no provider message id; sending without quote'
      );
    } else {
      replyToId = parent.message_id;
    }
  }

  const attempt = async (phone: string): Promise<string> => {
    if (isMediaKind) {
      const result = await send.sendMedia({
        to: phone,
        kind: messageType as UazapiMediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        replyToId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const result = await send.sendInteractive({
        to: phone,
        payload: interactivePayload!,
        replyToId,
      });
      return result.messageId;
    }
    const result = await send.sendText({
      to: phone,
      text: contentText!,
      replyToId,
    });
    return result.messageId;
  };

  // Send, retrying across phone-number variants if the provider rejects
  // the recipient; persist a working variant back to the contact so the
  // next send goes straight through.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants = sendTargets;
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown UAZAPI error';
    console.error('[send-message] send failed for all variants:', message);
    throw new SendMessageError('provider_error', `UAZAPI error: ${message}`, 502);
  }

  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  const interactiveBody =
    messageType === 'interactive' ? interactivePayload!.body : null;

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: interactiveBody ?? contentText ?? null,
      media_url: mediaUrl || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : contentText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Sending into an archived thread brings it back into the inbox
      // (migration 040) — the agent just made it active again, so it
      // has no business staying hidden from the list.
      archived_at: null,
    })
    .eq('id', conversationId);

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
