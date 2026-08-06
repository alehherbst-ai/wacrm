/**
 * Provider-agnostic tail of inbound message processing.
 *
 * Both webhook endpoints (Meta's `/api/whatsapp/webhook` and UAZAPI's
 * `/api/whatsapp/uazapi/webhook/[connectionId]/[secret]`) parse their
 * own wire format into a `NormalizedInboundMessage`, then hand off to
 * `processInboundMessage` here — find/create contact + conversation,
 * insert the message, dispatch to flows/automations/AI-reply/outbound
 * webhooks. This used to live entirely inside the Meta webhook route
 * (`processMessage`); extracted so a second provider doesn't have to
 * duplicate ~300 lines of fan-out logic.
 */

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { shouldSyncAvatar, syncContactAvatar } from '@/lib/whatsapp/contact-avatar';

export interface NormalizedInboundMessage {
  /** Provider's own id for this message (Meta's wamid / UAZAPI's messageid). */
  providerMessageId: string;
  /** Sender's phone number — already normalized (digits, no provider suffix). */
  senderPhone: string;
  senderName: string;
  /** When the message was sent, per the provider. */
  timestamp: Date;
  contentType:
    | 'text'
    | 'image'
    | 'document'
    | 'audio'
    | 'video'
    | 'location'
    | 'interactive';
  contentText: string | null;
  mediaUrl: string | null;
  interactiveReplyId: string | null;
  /** Provider id of the message this one is replying to, if any. */
  replyToProviderId: string | null;
  /**
   * Set only for reaction events. When present, every other
   * content-shaped field above is ignored — reactions never create a
   * `messages` row, they upsert `message_reactions`.
   */
  reaction: { targetProviderId: string; emoji: string } | null;
  /**
   * True when this message came from a WhatsApp group rather than a
   * 1:1 chat. Meta's Cloud API has no group concept — its normalizer
   * always sets this false. UAZAPI-backed sessions do have real
   * groups; when true, `senderPhone`/`senderName` identify the GROUP
   * (so every member's messages land in one conversation), and
   * `senderDisplayName` identifies which member sent this particular
   * message.
   */
  isGroup: boolean;
  /** Which group participant sent this message. Null outside groups. */
  senderDisplayName: string | null;
  /**
   * True when WE sent this message — from the WhatsApp app on the phone,
   * from WhatsApp Web, or from any other device sharing the connected
   * number. The counterparty is still `senderPhone` (identity always
   * comes from `chatid`, never from who typed), so contact and
   * conversation resolve exactly as they do for an inbound message; only
   * the direction differs.
   *
   * These used to be dropped at the webhook door alongside our own API
   * sends, which is why a thread answered from the phone showed the
   * customer's half of the conversation and none of ours. They are now
   * recorded as `sender_type='agent'` so the CRM holds the whole
   * exchange regardless of which device it was typed on.
   *
   * Our OWN API sends are a different case and stay excluded upstream
   * (`wasSentByApi`) — `send-message.ts` already persisted those.
   */
  fromMe: boolean;
}

export interface InboundPipelineContext {
  accountId: string;
  /** Sender-of-record for inserts that need a NOT NULL user_id FK — the admin who saved the WhatsApp connection. */
  configOwnerUserId: string;
  /** Which whatsapp_config row received this — stamped onto the conversation so outbound replies stay on the same channel. */
  whatsappConfigId: string;
  /**
   * Best-effort group-name lookup, called ONLY when a brand-new group
   * contact needs to be created (never on every message) — the
   * provider-specific webhook route supplies this (it's the only
   * place with the instance token the lookup call needs). Returning
   * null (or throwing) falls back to a generic name; never blocks
   * message processing.
   */
  resolveGroupName?: () => Promise<string | null>;
  /**
   * Best-effort WhatsApp profile-picture lookup for the sender, called
   * only when the contact has no recently-synced picture (see
   * `shouldSyncAvatar`) — never on every message. Like
   * `resolveGroupName`, the provider-specific route supplies it because
   * that's where the instance token lives. Returning null means "no
   * picture", which is a normal outcome for contacts who hide theirs.
   */
  resolveProfilePictureUrl?: () => Promise<string | null>;
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
]);

export async function processInboundMessage(
  message: NormalizedInboundMessage,
  context: InboundPipelineContext
): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    whatsappConfigId,
    resolveGroupName,
    resolveProfilePictureUrl,
  } = context;

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    message.senderPhone,
    // A message WE sent carries OUR push name, not the counterparty's —
    // feeding it in would rename the contact to the account's own name
    // (and, for a brand-new contact, file them under it). The empty
    // string means "no name information here": the existing name is
    // left alone and a new contact falls back to the phone number.
    message.fromMe ? '' : message.senderName,
    message.isGroup,
    resolveGroupName
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  // Import the WhatsApp profile picture BEFORE the message lands. The
  // inbox re-reads the conversation (contact embedded) when realtime
  // announces the new message, so syncing first is what makes the photo
  // appear along with that first message instead of on the next reload.
  // Both provider calls are timeout-bounded and the whole thing
  // swallows its own errors, so it can neither stall nor drop a message.
  if (resolveProfilePictureUrl && shouldSyncAvatar(contactRecord)) {
    await syncContactAvatar({
      db: supabaseAdmin(),
      accountId,
      contactId: contactRecord.id,
      resolveSourceUrl: resolveProfilePictureUrl,
    });
  }

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    whatsappConfigId
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    });
  }

  // Keep the conversation pinned to whichever connection most recently
  // delivered an inbound message — a reply should go out on the same
  // channel the customer just used, not wherever the thread started.
  if (conversation.whatsapp_config_id !== whatsappConfigId) {
    await supabaseAdmin()
      .from('conversations')
      .update({ whatsapp_config_id: whatsappConfigId })
      .eq('id', conversation.id);
  }

  if (message.reaction) {
    await handleReaction(
      message.reaction,
      conversation.id,
      message.fromMe ? configOwnerUserId : contactRecord.id,
      message.fromMe ? 'agent' : 'customer'
    );
    return;
  }

  // One provider message must never become two rows. Deliveries repeat
  // for reasons outside our control — UAZAPI retries anything that
  // didn't 200 in time, and a connection configured before
  // `excludeMessages: ['wasSentByApi']` existed still echoes our own
  // sends back as ordinary `fromMe` traffic. Both used to be invisible
  // because every `fromMe` message was discarded; now that they're
  // recorded, the id check is what keeps the thread honest.
  if (await messageAlreadyStored(message.providerMessageId, conversation.id)) {
    return;
  }

  let replyToInternalId: string | null = null;
  if (message.replyToProviderId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      message.replyToProviderId,
      conversation.id
    );
    if (!replyToInternalId) {
      console.warn(
        '[inbound-pipeline] reply context parent not found:',
        message.replyToProviderId
      );
    }
  }

  const contentType = ALLOWED_CONTENT_TYPES.has(message.contentType)
    ? message.contentType
    : 'text';

  // Something we sent from the phone / WhatsApp Web. Record it and stop:
  // everything below this point answers "how should we react to what the
  // customer just said", and none of it applies to our own words. Firing
  // flows, automations or the AI auto-reply here would have the CRM
  // replying to itself.
  if (message.fromMe) {
    await recordOwnDeviceMessage({
      accountId,
      conversation,
      contactId: contactRecord.id,
      contentType,
      message,
      replyToInternalId,
    });
    return;
  }

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: message.contentText,
    media_url: message.mediaUrl,
    message_id: message.providerMessageId,
    status: 'delivered',
    created_at: message.timestamp.toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: message.interactiveReplyId,
    sender_display_name: message.isGroup ? message.senderDisplayName : null,
  });

  if (msgError) {
    console.error('[inbound-pipeline] error inserting message:', msgError);
    return;
  }

  // Group threads preview like WhatsApp itself does — "Author: text" —
  // since the conversation title is the group, not the actual sender.
  const bodyPreview = message.contentText || `[${message.contentType}]`;
  const lastMessageText =
    message.isGroup && message.senderDisplayName
      ? `${message.senderDisplayName}: ${bodyPreview}`
      : bodyPreview;

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      // A new inbound message un-archives the thread (migration 040):
      // "clear inbox" hides conversations, it doesn't end them, so the
      // contact writing again brings the thread back with its history.
      // Unconditional because writing NULL over NULL costs nothing and
      // keeps this a single statement.
      archived_at: null,
      // …and hands it back to whoever owns this number (migration 045).
      // A transferred thread goes read-only for its old operator, but
      // the customer still has that number and may well write to it
      // again — about something else entirely. When they do, they have
      // chosen who they want to talk to, and the thread reopens for
      // that person. Whoever received the transfer keeps seeing these
      // messages: they are in the same chain.
      handed_over_at: null,
    })
    .eq('id', conversation.id);

  if (convError) {
    console.error('[inbound-pipeline] error updating conversation:', convError);
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // Flow runner dispatch — see the equivalent comment in the (now
  // Meta-only) webhook route for why content-level automation triggers
  // are suppressed when the runner consumed the message.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: message.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: message.interactiveReplyId,
          reply_title: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        }
      : {
          kind: 'text',
          text: message.contentText ?? '',
          meta_message_id: message.providerMessageId,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  const inboundText = message.contentText ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    if (message.interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: message.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  if (!flowConsumed && !message.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    });
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.providerMessageId,
    content_type: contentType,
    text: message.contentText,
  });
}

/**
 * Persist a message the account sent from outside the CRM — the
 * WhatsApp app on the phone, WhatsApp Web, a second linked device.
 *
 * Stored as `sender_type='agent'` so it renders as ours and reads
 * identically to a message sent from the composer here. Deliberately
 * NOT `bot`: a human wrote it, just not in this window.
 *
 * Two things differ from the inbound path, both because the account is
 * the author:
 *   - `unread_count` is cleared rather than bumped. Answering from the
 *     phone IS reading the thread; leaving the badge up would have the
 *     inbox nagging about conversations that were already handled.
 *   - any active Flow run for the contact is paused, the same signal
 *     `send-message.ts` sends when an agent replies from the CRM. A
 *     human stepping in mid-automation means the automation should
 *     yield, and the device it was typed on doesn't change that.
 */
async function recordOwnDeviceMessage(args: {
  accountId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversation: any;
  contactId: string;
  contentType: string;
  message: NormalizedInboundMessage;
  replyToInternalId: string | null;
}): Promise<void> {
  const { accountId, conversation, contactId, contentType, message, replyToInternalId } =
    args;

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: contentType,
    content_text: message.contentText,
    media_url: message.mediaUrl,
    message_id: message.providerMessageId,
    // The provider only tells us the message exists; delivery/read
    // receipts for it arrive (if at all) as separate status events.
    status: 'sent',
    created_at: message.timestamp.toISOString(),
    reply_to_message_id: replyToInternalId,
  });

  if (msgError) {
    console.error('[inbound-pipeline] error inserting own-device message:', msgError);
    return;
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: message.contentText || `[${message.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: 0,
      updated_at: new Date().toISOString(),
      // Answering an archived thread brings it back into the inbox, the
      // same as sending from the composer does (migration 040).
      archived_at: null,
      // Answering a transferred thread from the phone takes it back
      // (migration 045). Nothing here could have stopped that send, and
      // pretending the operator is still merely observing — while they
      // are visibly in the conversation — would leave the CRM
      // describing something that is not happening.
      handed_over_at: null,
    })
    .eq('id', conversation.id);

  if (convError) {
    console.error(
      '[inbound-pipeline] error updating conversation after own-device message:',
      convError
    );
  }

  const { error: pauseError } = await supabaseAdmin()
    .from('flow_runs')
    .update({
      status: 'paused_by_agent',
      ended_at: new Date().toISOString(),
      end_reason: 'agent_replied',
    })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active');

  if (pauseError) {
    console.error(
      '[inbound-pipeline] pause-on-own-device-send failed:',
      pauseError.message
    );
  }
}

/**
 * Has this provider message already been stored in this conversation?
 *
 * Backed by `idx_messages_message_id` (migration 001). On a read error
 * the answer is "no": dropping a real message to avoid a hypothetical
 * duplicate is the worse trade — a missing message is invisible, a
 * duplicate is merely ugly.
 */
async function messageAlreadyStored(
  providerMessageId: string,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .limit(1);

  if (error) {
    console.error('[inbound-pipeline] duplicate check failed:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const row = recs[0];
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updErr) {
      console.error('[inbound-pipeline] error marking broadcast recipient replied:', updErr);
    }
  } catch (err) {
    console.error('[inbound-pipeline] flagBroadcastReplyIfAny failed:', err);
  }
}

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a reply to a message older than this CRM install).
 */
async function lookupInternalIdByProviderId(
  providerId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[inbound-pipeline] lookupInternalIdByProviderId failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Persist a reaction seen on the wire. Reactions are not new messages —
 * they're per-(target, actor) state, upserted/deleted on
 * `message_reactions`. A missing parent is logged and skipped, not fatal.
 *
 * `actorType` distinguishes the customer reacting from US reacting on
 * the phone; `actorId` is the contact in the first case and the
 * connection's owning user in the second, matching what the inbox
 * writes when someone reacts from the CRM (actor_type='agent',
 * actor_id=<user id>). The unique key is (message, actor_type,
 * actor_id), so the two can coexist on one message — which is exactly
 * what a 👍 from each side is.
 */
async function handleReaction(
  reaction: { targetProviderId: string; emoji: string },
  conversationId: string,
  actorId: string,
  actorType: 'customer' | 'agent'
) {
  const targetInternalId = await lookupInternalIdByProviderId(
    reaction.targetProviderId,
    conversationId
  );
  if (!targetInternalId) {
    console.warn(
      '[inbound-pipeline] reaction target message not found; skipping',
      reaction.targetProviderId
    );
    return;
  }

  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', actorType)
      .eq('actor_id', actorId);
    if (delError) {
      console.error('[inbound-pipeline] reaction delete failed:', delError.message);
    }
    return;
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: actorType,
        actor_id: actorId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    );
  if (upsertError) {
    console.error('[inbound-pipeline] reaction upsert failed:', upsertError.message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

interface ContactOutcome {
  contact: ContactRow;
  wasCreated: boolean;
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
  isGroup = false,
  resolveGroupName?: () => Promise<string | null>
): Promise<ContactOutcome | null> {
  if (isGroup) {
    return findOrCreateGroupContact(accountId, configOwnerUserId, phone, resolveGroupName);
  }

  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone);

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('[inbound-pipeline] error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

/**
 * Group variant of findOrCreateContact — deliberately NOT sharing
 * findExistingContact's fuzzy last-8-digit matching (migration 038's
 * rationale): a WhatsApp group id has no phone-formatting ambiguity to
 * tolerate, and fuzzy-matching an 18-20 digit synthetic id risks
 * merging unrelated groups/contacts that happen to share a suffix.
 * Exact match on `phone_normalized` only.
 *
 * `groupPhone` is the group's id verbatim, which for a legacy group is
 * `<creator>-<createdAt>` and DOES contain a hyphen. `phone_normalized`
 * is a generated digits-only column (migration 022), so the lookup has
 * to compare against the stripped form while `phone` keeps the id whole
 * — that stored value is what replies and picture lookups rebuild the
 * JID from, and a hyphen lost there addresses a group that doesn't
 * exist.
 */
async function findOrCreateGroupContact(
  accountId: string,
  configOwnerUserId: string,
  groupPhone: string,
  resolveGroupName?: () => Promise<string | null>
): Promise<ContactOutcome | null> {
  const groupPhoneDigits = normalizePhone(groupPhone);

  const { data: existing, error: findError } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('phone_normalized', groupPhoneDigits)
    .eq('is_group', true)
    .maybeSingle();

  if (findError) {
    console.error('[inbound-pipeline] error finding group contact:', findError);
    return null;
  }
  if (existing) {
    // Self-heal rows written before the hyphen was preserved: the
    // digits-only key still matches, so the id can be restored in place
    // without disturbing the unique index (phone_normalized is
    // generated from phone and comes out identical either way).
    if (existing.phone !== groupPhone) {
      const { error: repairError } = await supabaseAdmin()
        .from('contacts')
        .update({ phone: groupPhone, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (repairError) {
        console.error('[inbound-pipeline] group id repair failed:', repairError);
      } else {
        existing.phone = groupPhone;
      }
    }
    return { contact: existing, wasCreated: false };
  }

  let groupName: string | null = null;
  if (resolveGroupName) {
    try {
      groupName = await resolveGroupName();
    } catch (err) {
      console.warn(
        '[inbound-pipeline] resolveGroupName failed, using fallback name:',
        err instanceof Error ? err.message : err
      );
    }
  }
  const fallbackName = `Group ${groupPhone.slice(-6)}`;

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: groupPhone,
      is_group: true,
      name: groupName || fallbackName,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .eq('phone_normalized', groupPhoneDigits)
        .eq('is_group', true)
        .maybeSingle();
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('[inbound-pipeline] error creating group contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  whatsappConfigId: string
) {
  // Oldest-first, one row — see the equivalent comment in the pre-
  // extraction webhook route (issue #363) for why `.single()` isn't
  // used here.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('[inbound-pipeline] error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('[inbound-pipeline] error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}
