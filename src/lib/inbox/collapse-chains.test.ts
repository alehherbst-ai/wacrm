import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';

import { chainIdsFor, collapseChains } from './collapse-chains';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: 'u',
    contact_id: 'contact-1',
    status: 'open',
    unread_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('collapseChains', () => {
  it('leaves a conversation that was never transferred alone', () => {
    const rows = collapseChains([conv('solo')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('solo');
  });

  // The reported bug, exactly as it appeared: one contact, two rows —
  // the old link holding every message, the new one holding none.
  it('shows one row for a contact whose conversation was handed over', () => {
    const old = conv('old', {
      transfer_chain_id: 'chain',
      handed_over_at: '2026-03-02T10:00:00Z',
      transferred_to_conversation_id: 'new',
      last_message_text: 'Nós temos os dois, só queria entender',
      last_message_at: '2026-03-02T09:00:00Z',
      whatsapp_config_id: 'house',
    });
    const fresh = conv('new', {
      transfer_chain_id: 'chain',
      inherited_from_conversation_id: 'old',
      whatsapp_config_id: 'mine',
    });

    const rows = collapseChains([old, fresh]);

    expect(rows).toHaveLength(1);
    // Identity comes from the live link — that is where a reply goes.
    expect(rows[0].id).toBe('new');
    expect(rows[0].whatsapp_config_id).toBe('mine');
    // ...but the preview comes from wherever the newest message is.
    expect(rows[0].last_message_text).toBe(
      'Nós temos os dois, só queria entender',
    );
    expect(rows[0].last_message_at).toBe('2026-03-02T09:00:00Z');
  });

  it('collapses a chain of three to a single row', () => {
    const links = [
      conv('a', { transfer_chain_id: 'c', handed_over_at: '2026-03-01T00:00:00Z' }),
      conv('b', { transfer_chain_id: 'c', handed_over_at: '2026-03-02T00:00:00Z' }),
      conv('c3', { transfer_chain_id: 'c' }),
    ];
    const rows = collapseChains(links);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('c3');
  });

  it('sums unread across the chain so nothing is silently dropped', () => {
    const rows = collapseChains([
      conv('old', {
        transfer_chain_id: 'c',
        handed_over_at: '2026-03-02T10:00:00Z',
        unread_count: 3,
      }),
      conv('new', { transfer_chain_id: 'c', unread_count: 2 }),
    ]);
    expect(rows[0].unread_count).toBe(5);
  });

  it('keeps the chain visible when every link has been handed over', () => {
    const rows = collapseChains([
      conv('a', {
        transfer_chain_id: 'c',
        handed_over_at: '2026-03-01T00:00:00Z',
        last_message_at: '2026-03-01T00:00:00Z',
      }),
      conv('b', {
        transfer_chain_id: 'c',
        handed_over_at: '2026-03-02T00:00:00Z',
        last_message_at: '2026-03-02T00:00:00Z',
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('b');
  });

  it('picks the most recently active among several live links', () => {
    const rows = collapseChains([
      conv('quiet', {
        transfer_chain_id: 'c',
        last_message_at: '2026-03-01T00:00:00Z',
      }),
      conv('busy', {
        transfer_chain_id: 'c',
        last_message_at: '2026-03-05T00:00:00Z',
      }),
    ]);
    expect(rows[0].id).toBe('busy');
  });

  // Archiving one number's link must not hide the contact while
  // another link is still live in someone's inbox.
  it('treats the chain as archived only when every link is', () => {
    const partly = collapseChains([
      conv('a', { transfer_chain_id: 'c', archived_at: '2026-03-01T00:00:00Z' }),
      conv('b', { transfer_chain_id: 'c' }),
    ]);
    expect(partly[0].archived_at).toBeNull();

    const fully = collapseChains([
      conv('a', {
        transfer_chain_id: 'c',
        archived_at: '2026-03-01T00:00:00Z',
        handed_over_at: '2026-03-01T00:00:00Z',
      }),
      conv('b', { transfer_chain_id: 'c', archived_at: '2026-03-02T00:00:00Z' }),
    ]);
    expect(fully[0].archived_at).toBe('2026-03-02T00:00:00Z');
  });

  it('keeps separate contacts separate', () => {
    const rows = collapseChains([
      conv('ana', { contact_id: 'ana', transfer_chain_id: 'chain-ana' }),
      conv('bruno', { contact_id: 'bruno', transfer_chain_id: 'chain-bruno' }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('orders rows by the merged recency, newest first', () => {
    const rows = collapseChains([
      conv('older', { last_message_at: '2026-03-01T00:00:00Z' }),
      conv('newer', { last_message_at: '2026-03-09T00:00:00Z' }),
      conv('middle', { last_message_at: '2026-03-05T00:00:00Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['newer', 'middle', 'older']);
  });

  it('sorts a chain by its newest link, not by the live link', () => {
    // The live link is empty; the chain must still rank by the message
    // that actually arrived, or a busy transferred thread sinks.
    const rows = collapseChains([
      conv('other', { last_message_at: '2026-03-04T00:00:00Z' }),
      conv('old', {
        transfer_chain_id: 'c',
        handed_over_at: '2026-03-05T00:00:00Z',
        last_message_at: '2026-03-05T00:00:00Z',
      }),
      conv('live', { transfer_chain_id: 'c' }),
    ]);
    expect(rows[0].id).toBe('live');
    expect(rows[0].last_message_at).toBe('2026-03-05T00:00:00Z');
  });
});

describe('chainIdsFor', () => {
  it('gathers every link so any of them keeps the row selected', () => {
    const all = [
      conv('old', { transfer_chain_id: 'c' }),
      conv('new', { transfer_chain_id: 'c' }),
      conv('unrelated', { transfer_chain_id: 'other' }),
    ];
    const ids = chainIdsFor(all[1], all);
    expect([...ids].sort()).toEqual(['new', 'old']);
  });

  it('returns just the row for an untransferred conversation', () => {
    const solo = conv('solo');
    expect([...chainIdsFor(solo, [solo])]).toEqual(['solo']);
  });
});
