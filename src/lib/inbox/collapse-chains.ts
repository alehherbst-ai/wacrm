// ============================================================
// One contact, one row.
//
// A transfer copies nothing (migration 045): handing a conversation
// over CREATES a second conversation on the receiving operator's
// number and marks the first as handed over. Both rows are real, both
// come back from the same query, and until now the sidebar rendered
// both — so a contact who had been transferred once appeared twice,
// and a contact transferred twice appeared three times.
//
// The two rows were also each wrong in their own way. The new link is
// where the answer will be written but holds no messages yet, so it
// read "Nenhuma mensagem ainda"; the old link held the entire history
// but is no longer where anyone can reply. The history and the
// ownership had come apart onto two lines of the same list.
//
// This module puts them back together: one row per chain, showing the
// link that is live now, carrying the newest message from anywhere in
// the chain and the unread count of the whole thing.
//
// Pure — the fetching stays in the components, the merge decision
// lives here where it can be tested.
// ============================================================

import type { Conversation } from '@/types';

/**
 * The id every link of one chain shares. A conversation that was never
 * transferred is a chain of one and stands in for itself, which is why
 * this falls back to the row's own id rather than skipping it.
 */
export function chainKey(
  conversation: Pick<Conversation, 'id' | 'transfer_chain_id'>,
): string {
  return conversation.transfer_chain_id ?? conversation.id;
}

/** Newest first, missing timestamps last. */
function byRecency(a: Conversation, b: Conversation): number {
  const at = a.last_message_at ?? '';
  const bt = b.last_message_at ?? '';
  if (at === bt) return b.created_at.localeCompare(a.created_at);
  if (!at) return 1;
  if (!bt) return -1;
  return bt.localeCompare(at);
}

/**
 * Pick the link that represents the chain.
 *
 * The live link is the one nobody has handed away — that is where a
 * reply would go, so it decides the row's identity, its ownership
 * badge, and what opening the row opens. Among several (a chain that
 * merged two threads), the most recently active wins.
 *
 * If every link has been handed over, the chain is mid-flight and the
 * newest link is the closest thing to current. Falling back keeps the
 * contact on screen; dropping the chain would make a conversation
 * vanish from the inbox because of a transient state.
 */
function pickLive(links: Conversation[]): Conversation {
  const live = links.filter((c) => !c.handed_over_at);
  const pool = live.length > 0 ? live : links;
  return [...pool].sort(byRecency)[0];
}

/**
 * Collapse a flat conversation list into one row per transfer chain.
 *
 * Input order is not relied on; output is sorted by the merged
 * `last_message_at`, newest first, which is the order the sidebar
 * wants anyway.
 */
export function collapseChains(conversations: Conversation[]): Conversation[] {
  const groups = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    const key = chainKey(conversation);
    const bucket = groups.get(key);
    if (bucket) bucket.push(conversation);
    else groups.set(key, [conversation]);
  }

  const rows: Conversation[] = [];

  for (const links of groups.values()) {
    if (links.length === 1) {
      rows.push(links[0]);
      continue;
    }

    const live = pickLive(links);

    // The newest message anywhere in the chain — usually on a different
    // link than the live one, which is the whole bug this fixes.
    const newest = [...links].sort(byRecency)[0];

    // Unread is summed, not taken from the live link. A customer who
    // wrote to the old number after the hand-over left unread messages
    // there; the operator has to see that count somewhere, and the one
    // row for this contact is the only place left.
    const unread = links.reduce((sum, c) => sum + (c.unread_count || 0), 0);

    // A chain is archived only when every link is. One link still in
    // the inbox means the contact is still in the inbox.
    const archivedAt = links.every((c) => c.archived_at)
      ? live.archived_at
      : null;

    rows.push({
      ...live,
      last_message_text: newest.last_message_text,
      last_message_at: newest.last_message_at,
      unread_count: unread,
      archived_at: archivedAt,
    });
  }

  return rows.sort(byRecency);
}

/**
 * Every conversation id folded into the given row, itself included.
 *
 * The sidebar needs this to keep selection working: opening the row
 * opens the live link, but the currently-open conversation may be any
 * link of the chain (the thread renders them all), and the row still
 * has to render as selected.
 */
export function chainIdsFor(
  row: Conversation,
  conversations: Conversation[],
): Set<string> {
  const key = chainKey(row);
  const ids = new Set<string>([row.id]);
  for (const c of conversations) {
    if (chainKey(c) === key) ids.add(c.id);
  }
  return ids;
}
