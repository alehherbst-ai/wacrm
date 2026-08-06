import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '@/types';

import { buildSegments, orderChain, threadRole } from './transfer-chain';

function conv(
  id: string,
  extra: Partial<Conversation> = {},
): Conversation {
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

function msg(id: string, conversationId: string, at: string): Message {
  return {
    id,
    conversation_id: conversationId,
    sender_type: 'customer',
    content_type: 'text',
    status: 'delivered',
    created_at: at,
  };
}

describe('orderChain', () => {
  it('walks the inheritance pointers oldest-first', () => {
    const ana = conv('ana');
    const bruno = conv('bruno', { inherited_from_conversation_id: 'ana' });
    const carlos = conv('carlos', { inherited_from_conversation_id: 'bruno' });

    // Deliberately shuffled: order must come from the pointers, not
    // from how the rows happened to arrive.
    const ordered = orderChain([carlos, ana, bruno], 'carlos');

    expect(ordered.map((c) => c.id)).toEqual(['ana', 'bruno', 'carlos']);
  });

  it('orders by pointer even when timestamps are identical', () => {
    const a = conv('a', { created_at: '2026-05-01T10:00:00Z' });
    const b = conv('b', {
      created_at: '2026-05-01T10:00:00Z',
      inherited_from_conversation_id: 'a',
    });

    expect(orderChain([b, a], 'b').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('keeps links the pointers do not reach, oldest first', () => {
    // Bruno already had his own thread with this contact; transferring
    // merged the two chains. That thread is real history and has to
    // survive the ordering.
    const anaChain = conv('ana', { created_at: '2026-03-01T00:00:00Z' });
    const brunosOwn = conv('bruno-old', { created_at: '2026-01-01T00:00:00Z' });
    const current = conv('bruno', {
      created_at: '2026-04-01T00:00:00Z',
      inherited_from_conversation_id: 'ana',
    });

    const ordered = orderChain([current, anaChain, brunosOwn], 'bruno');

    expect(ordered.map((c) => c.id)).toEqual(['bruno-old', 'ana', 'bruno']);
  });

  it('survives a pointer cycle without hanging', () => {
    const a = conv('a', { inherited_from_conversation_id: 'b' });
    const b = conv('b', { inherited_from_conversation_id: 'a' });

    expect(() => orderChain([a, b], 'a')).not.toThrow();
    expect(orderChain([a, b], 'a')).toHaveLength(2);
  });

  it('handles a chain of one — the never-transferred case', () => {
    const only = conv('only');
    expect(orderChain([only], 'only').map((c) => c.id)).toEqual(['only']);
  });
});

describe('buildSegments', () => {
  const ana = conv('ana');
  const bruno = conv('bruno', { inherited_from_conversation_id: 'ana' });

  it('files each message under the link it was sent in', () => {
    const segments = buildSegments(
      [ana, bruno],
      [
        msg('m2', 'bruno', '2026-05-02T10:00:00Z'),
        msg('m1', 'ana', '2026-05-01T10:00:00Z'),
      ],
      'bruno',
      () => null,
    );

    expect(segments.map((s) => s.messages.map((m) => m.id))).toEqual([
      ['m1'],
      ['m2'],
    ]);
  });

  it('marks only the link being answered in as current', () => {
    const segments = buildSegments([ana, bruno], [], 'bruno', () => null);
    expect(segments.map((s) => s.isCurrent)).toEqual([false, true]);
  });

  it('keeps an empty link — its divider is what explains the jump', () => {
    const segments = buildSegments(
      [ana, bruno],
      [msg('m1', 'bruno', '2026-05-02T10:00:00Z')],
      'bruno',
      () => null,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].messages).toEqual([]);
  });

  it('sorts within a link by time', () => {
    const segments = buildSegments(
      [ana],
      [
        msg('late', 'ana', '2026-05-01T12:00:00Z'),
        msg('early', 'ana', '2026-05-01T09:00:00Z'),
      ],
      'ana',
      () => null,
    );
    expect(segments[0].messages.map((m) => m.id)).toEqual(['early', 'late']);
  });
});

describe('threadRole', () => {
  const mine = new Set(['cfg-mine']);

  it('is the owner on their own live thread', () => {
    expect(
      threadRole({
        conversation: conv('c', { whatsapp_config_id: 'cfg-mine' }),
        myConnectionIds: mine,
        seesEverything: false,
      }),
    ).toEqual({ kind: 'owner' });
  });

  it('observes a thread on somebody else’s number', () => {
    expect(
      threadRole({
        conversation: conv('c', { whatsapp_config_id: 'cfg-theirs' }),
        myConnectionIds: mine,
        seesEverything: false,
      }),
    ).toEqual({ kind: 'observer', reason: 'other-number' });
  });

  it('observes their own thread while it is handed over', () => {
    expect(
      threadRole({
        conversation: conv('c', {
          whatsapp_config_id: 'cfg-mine',
          handed_over_at: '2026-05-01T10:00:00Z',
        }),
        myConnectionIds: mine,
        seesEverything: false,
      }),
    ).toEqual({ kind: 'observer', reason: 'handed-over' });
  });

  it('hands it back once the customer writes to this number again', () => {
    // The inbound pipeline clears handed_over_at; this is what the UI
    // makes of that.
    expect(
      threadRole({
        conversation: conv('c', {
          whatsapp_config_id: 'cfg-mine',
          handed_over_at: null,
          transferred_at: '2026-05-01T10:00:00Z',
        }),
        myConnectionIds: mine,
        seesEverything: false,
      }),
    ).toEqual({ kind: 'owner' });
  });

  it('lets a gestor with no number of their own still answer', () => {
    expect(
      threadRole({
        conversation: conv('c', { whatsapp_config_id: 'cfg-theirs' }),
        myConnectionIds: new Set(),
        seesEverything: true,
      }),
    ).toEqual({ kind: 'owner' });
  });

  it('still stops a gestor from answering a handed-over thread', () => {
    // Two people answering one customer from two numbers is confusing
    // regardless of who the second one is.
    expect(
      threadRole({
        conversation: conv('c', {
          whatsapp_config_id: 'cfg-theirs',
          handed_over_at: '2026-05-01T10:00:00Z',
        }),
        myConnectionIds: new Set(),
        seesEverything: true,
      }),
    ).toEqual({ kind: 'observer', reason: 'handed-over' });
  });
});
