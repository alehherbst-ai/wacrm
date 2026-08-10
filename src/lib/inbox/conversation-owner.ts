// ============================================================
// Who owns a conversation.
//
// Since migration 044 a conversation lives on exactly one WhatsApp
// number, and that number belongs to exactly one operator (or to
// nobody — the "house number"). That operator is the owner: the only
// person who can answer, because a reply physically leaves from their
// number and WhatsApp cannot send from someone else's line.
//
// Everybody else on the chain reads it. That asymmetry is enforced by
// RLS, but it was close to invisible in the UI — the only hint was a
// grey sentence at the bottom, and only for observers. This module is
// the single source of truth for the label, so the thread header and
// the conversation list can never disagree about whose conversation
// this is.
//
// Pure on purpose: the fetching lives in the components, the wording
// decision lives here where it can be tested.
// ============================================================

import type { Conversation } from '@/types';

export type OwnerView =
  /** The signed-in operator answers for this conversation. */
  | { kind: 'me' }
  /** Somebody else answers for it; `name` is who to ask. */
  | { kind: 'other'; name: string }
  /** Owned by a named operator, but they handed it over and are waiting. */
  | { kind: 'handedOver' }
  /** Nobody has replied yet, so nobody answers for it — yet. */
  | { kind: 'unassigned' }
  /** On a number whose operator we could not resolve, or on no number. */
  | { kind: 'unknown' };

export interface OwnerLookup {
  /** connection id → the operator who owns that number. */
  operatorByConnection: Map<string, string>;
  /** user id → display name. */
  nameByUserId: Map<string, string>;
  currentUserId: string | null;
}

/**
 * Decide how to label who answers for this conversation.
 *
 * `responsible_user_id` (migration 049) leads, because it answers the
 * question actually being asked. The number the thread lives on says
 * where a reply physically leaves from — a WhatsApp constraint, not a
 * statement about people — and on a line shared by the whole account
 * it names nobody at all. That gap is what used to surface as "Número
 * da casa": a telephone offered as the answer to "who is handling
 * this?".
 *
 * The number stays as the fallback, and on an account where every
 * operator has their own line the two agree anyway. It matters for
 * conversations that predate the column and have not been replied to
 * since.
 *
 * `handedOver` still outranks both. While the hand-over stands, the
 * person answering is at the OTHER end of it, so naming this end would
 * name somebody who is only watching.
 */
export function ownerView(
  conversation: Pick<
    Conversation,
    'whatsapp_config_id' | 'handed_over_at' | 'responsible_user_id'
  >,
  lookup: OwnerLookup,
): OwnerView {
  const { operatorByConnection, nameByUserId, currentUserId } = lookup;

  if (conversation.handed_over_at) return { kind: 'handedOver' };

  const responsible = conversation.responsible_user_id;
  if (responsible) return nameHolder(responsible, currentUserId, nameByUserId);

  const connectionId = conversation.whatsapp_config_id;
  if (!connectionId) return { kind: 'unknown' };

  // A connection we've never heard of is unresolved, not unassigned —
  // claiming nobody owns it would hide a real operator behind a label
  // that invites someone else to take over.
  if (!operatorByConnection.has(connectionId)) return { kind: 'unknown' };

  const ownerId = operatorByConnection.get(connectionId);

  // A known connection with no operator is the account's shared line.
  // Nobody has replied yet, so nobody answers for it yet — which is a
  // fact about the conversation, and an invitation to pick it up.
  if (!ownerId) return { kind: 'unassigned' };

  return nameHolder(ownerId, currentUserId, nameByUserId);
}

/**
 * Who answers for this conversation, as a user id — the same person
 * {@link ownerView} labels, before the labelling.
 *
 * Exists so the sidebar's "attended by" filter and the ownership badge
 * are driven by one resolution instead of two that can drift: picking
 * a teammate in the filter has to select exactly the rows that say
 * that teammate's name.
 *
 * Null for a conversation nobody has claimed, and for one that has
 * been handed over — mid-flight it belongs to the far end, which is a
 * different row.
 */
export function holderUserId(
  conversation: Pick<
    Conversation,
    'whatsapp_config_id' | 'handed_over_at' | 'responsible_user_id'
  >,
  lookup: OwnerLookup,
): string | null {
  if (conversation.handed_over_at) return null;
  if (conversation.responsible_user_id) return conversation.responsible_user_id;

  const connectionId = conversation.whatsapp_config_id;
  if (!connectionId) return null;

  return lookup.operatorByConnection.get(connectionId) || null;
}

/** Turn a user id into the label for whoever holds the conversation. */
function nameHolder(
  userId: string,
  currentUserId: string | null,
  nameByUserId: Map<string, string>,
): OwnerView {
  if (currentUserId && userId === currentUserId) return { kind: 'me' };
  const name = nameByUserId.get(userId);
  return name ? { kind: 'other', name } : { kind: 'unknown' };
}

/**
 * Name the operator a handed-over conversation is now with.
 *
 * Follows `transferred_to_conversation_id` to the next link and reads
 * whose number THAT one lives on. `byId` is whatever set of
 * conversations the caller already holds — the transfer chain in the
 * thread, the loaded list in the sidebar — so this costs no extra
 * fetch and simply returns null when the link isn't among them.
 */
export function handedOverToName(
  conversation: Pick<Conversation, 'transferred_to_conversation_id'>,
  lookup: OwnerLookup,
  byId: Map<string, Pick<Conversation, 'whatsapp_config_id'>>,
): string | null {
  const destId = conversation.transferred_to_conversation_id;
  if (!destId) return null;

  const dest = byId.get(destId);
  if (!dest?.whatsapp_config_id) return null;

  const operator = lookup.operatorByConnection.get(dest.whatsapp_config_id);
  if (!operator) return null;

  return lookup.nameByUserId.get(operator) ?? null;
}

/**
 * Build the two lookup maps from raw rows.
 *
 * `operatorByConnection` maps every known connection, including the
 * house number — which maps to `null`. A plain `Map<string, string>`
 * could not tell "house number" apart from "connection I don't know
 * about", and those two produce different labels.
 */
export function buildOwnerLookup(args: {
  connections: { id: string; operator_user_id: string | null }[];
  profiles: { user_id: string; full_name: string | null }[];
  currentUserId: string | null;
}): OwnerLookup {
  const operatorByConnection = new Map<string, string>();
  for (const row of args.connections) {
    // Set the key either way; the value is what distinguishes them.
    operatorByConnection.set(row.id, row.operator_user_id ?? '');
  }

  const nameByUserId = new Map<string, string>();
  for (const p of args.profiles) {
    if (p.full_name) nameByUserId.set(p.user_id, p.full_name);
  }

  return {
    operatorByConnection,
    nameByUserId,
    currentUserId: args.currentUserId,
  };
}
