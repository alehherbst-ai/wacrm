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
  /** The signed-in operator owns the number this conversation lives on. */
  | { kind: 'me' }
  /** Another operator owns it; `name` is who to ask. */
  | { kind: 'other'; name: string }
  /** Owned by a named operator, but they handed it over and are waiting. */
  | { kind: 'handedOver' }
  /** The house number — no operator claims it. */
  | { kind: 'house' }
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
 * Decide how to label this conversation's owner.
 *
 * `handedOver` outranks `me` deliberately: while the hand-over stands,
 * the person who transferred is watching, not answering, and telling
 * them "you own this" would contradict the missing composer. It only
 * applies to your own conversations — a colleague's thread that they
 * handed to a third person is still, from where you sit, simply
 * theirs, and naming them is the useful answer.
 */
export function ownerView(
  conversation: Pick<Conversation, 'whatsapp_config_id' | 'handed_over_at'>,
  lookup: OwnerLookup,
): OwnerView {
  const { operatorByConnection, nameByUserId, currentUserId } = lookup;

  const connectionId = conversation.whatsapp_config_id;
  if (!connectionId) return { kind: 'unknown' };

  // A connection we know about, with no operator, is the house number.
  // One we've never heard of is simply unresolved — saying "house"
  // there would be a guess, and the wrong one hides a real owner.
  if (!operatorByConnection.has(connectionId)) {
    return { kind: 'unknown' };
  }

  const ownerId = operatorByConnection.get(connectionId);
  if (!ownerId) return { kind: 'house' };

  if (currentUserId && ownerId === currentUserId) {
    return conversation.handed_over_at ? { kind: 'handedOver' } : { kind: 'me' };
  }

  const name = nameByUserId.get(ownerId);
  return name ? { kind: 'other', name } : { kind: 'unknown' };
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
