// ============================================================
// Reading a conversation that has changed hands.
//
// A transfer copies nothing (migration 045). The thread the receiving
// operator opens holds only the messages that actually passed through
// their own number; everything said before that lives in the previous
// link and is rendered above a divider, read-only.
//
// So "show me this conversation" means "show me every link in the
// chain, in order". These helpers turn a chain of conversations plus a
// flat list of messages into that ordered, segmented view. Pure — the
// fetching lives in the thread component, the shape decisions live
// here where they can be tested.
// ============================================================

import type { Conversation, Message } from '@/types';

/** One link of the chain, as the thread needs to render it. */
export interface ChainLink {
  conversation: Conversation;
  /** False for every link except the one the operator is answering in. */
  isCurrent: boolean;
  /** Display name of the operator whose number this link lives on. */
  operatorName: string | null;
}

export interface ChainSegment extends ChainLink {
  messages: Message[];
}

/**
 * Order the chain oldest-first.
 *
 * `inherited_from_conversation_id` is the real backbone: it says
 * exactly which link came before which. Following it from the current
 * link backwards is precise even when two links were created in the
 * same second — which `created_at` alone could not settle.
 *
 * Anything the pointers don't reach (a link whose parent was deleted,
 * or the other operator's own earlier thread absorbed when two chains
 * merged) is appended by `created_at`. Those messages are genuinely
 * part of this contact's history; dropping them because a pointer is
 * missing would hide real conversation.
 */
export function orderChain(
  chain: Conversation[],
  currentId: string,
): Conversation[] {
  const byId = new Map(chain.map((c) => [c.id, c]));
  const spine: Conversation[] = [];
  const seen = new Set<string>();

  let cursor = byId.get(currentId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    spine.unshift(cursor);
    const parentId = cursor.inherited_from_conversation_id;
    cursor = parentId ? byId.get(parentId) : undefined;
  }

  const orphans = chain
    .filter((c) => !seen.has(c.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return [...orphans, ...spine];
}

/**
 * Split messages across the ordered chain.
 *
 * Segments with no messages are kept: a link that was handed on before
 * anybody wrote in it is still a step the conversation took, and its
 * divider is what explains the jump from one number to the next.
 */
export function buildSegments(
  orderedChain: Conversation[],
  messages: Message[],
  currentId: string,
  operatorNameFor: (conversation: Conversation) => string | null,
): ChainSegment[] {
  const byConversation = new Map<string, Message[]>();
  for (const message of messages) {
    const bucket = byConversation.get(message.conversation_id);
    if (bucket) bucket.push(message);
    else byConversation.set(message.conversation_id, [message]);
  }

  for (const bucket of byConversation.values()) {
    bucket.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  return orderedChain.map((conversation) => ({
    conversation,
    isCurrent: conversation.id === currentId,
    operatorName: operatorNameFor(conversation),
    messages: byConversation.get(conversation.id) ?? [],
  }));
}

/**
 * May the signed-in operator answer in this thread, or are they only
 * watching it?
 *
 * Two ways to be an observer, and they are different situations:
 *   - the thread lives on somebody else's number — you can read the
 *     chain, but a reply from you would physically leave from a number
 *     that is not yours, which WhatsApp cannot do;
 *   - the thread is yours but you handed it over, and the customer has
 *     not written back to this number since. It reopens by itself the
 *     moment they do.
 *
 * The database enforces the first (the write policies carry no chain
 * clause). The second is a workflow rule, not a security boundary —
 * two operators answering the same customer from two numbers is a mess
 * to explain, not a breach — so it is enforced here, where it can also
 * be explained to the person it stops.
 */
export type ThreadRole =
  | { kind: 'owner' }
  | { kind: 'observer'; reason: 'other-number' | 'handed-over' };

export function threadRole(args: {
  conversation: Conversation;
  /** The connection ids whose operator is the signed-in user. */
  myConnectionIds: Set<string>;
  /** True for a gestor: sees and acts on everything. */
  seesEverything: boolean;
}): ThreadRole {
  const { conversation, myConnectionIds, seesEverything } = args;

  const isMyNumber =
    !!conversation.whatsapp_config_id &&
    myConnectionIds.has(conversation.whatsapp_config_id);

  // A gestor with no number of their own would otherwise be locked out
  // of every composer in the account.
  if (!isMyNumber && !seesEverything) {
    return { kind: 'observer', reason: 'other-number' };
  }

  if (conversation.handed_over_at) {
    return { kind: 'observer', reason: 'handed-over' };
  }

  return { kind: 'owner' };
}
