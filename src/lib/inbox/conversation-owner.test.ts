import { describe, it, expect } from 'vitest';

import {
  buildOwnerLookup,
  handedOverToName,
  ownerView,
} from './conversation-owner';

const ME = 'user-me';
const OTHER = 'user-other';

function lookup(
  connections: { id: string; operator_user_id: string | null }[],
  currentUserId: string | null = ME,
) {
  return buildOwnerLookup({
    connections,
    profiles: [
      { user_id: ME, full_name: 'Ana' },
      { user_id: OTHER, full_name: 'Bruno' },
    ],
    currentUserId,
  });
}

function conversation(
  whatsapp_config_id: string | null,
  handed_over_at: string | null = null,
) {
  return { whatsapp_config_id, handed_over_at };
}

describe('ownerView', () => {
  it('names me when the conversation is on my number', () => {
    const view = ownerView(
      conversation('c1'),
      lookup([{ id: 'c1', operator_user_id: ME }]),
    );
    expect(view).toEqual({ kind: 'me' });
  });

  it('names the colleague when the number is theirs', () => {
    const view = ownerView(
      conversation('c2'),
      lookup([{ id: 'c2', operator_user_id: OTHER }]),
    );
    expect(view).toEqual({ kind: 'other', name: 'Bruno' });
  });

  it('reports the house number as nobody-in-particular', () => {
    const view = ownerView(
      conversation('c3'),
      lookup([{ id: 'c3', operator_user_id: null }]),
    );
    expect(view).toEqual({ kind: 'house' });
  });

  // The distinction the two-map shape exists to preserve: a connection
  // we simply haven't loaded must not be reported as the house number.
  it('does not mistake an unknown connection for the house number', () => {
    const view = ownerView(
      conversation('c-unloaded'),
      lookup([{ id: 'c1', operator_user_id: ME }]),
    );
    expect(view).toEqual({ kind: 'unknown' });
  });

  it('reports a conversation on no number at all as unknown', () => {
    const view = ownerView(
      conversation(null),
      lookup([{ id: 'c1', operator_user_id: ME }]),
    );
    expect(view).toEqual({ kind: 'unknown' });
  });

  // While the hand-over stands the composer is gone, so claiming
  // ownership here would contradict what the screen is doing.
  it('reports my own handed-over conversation as handed over, not mine', () => {
    const view = ownerView(
      conversation('c1', '2026-08-07T10:00:00Z'),
      lookup([{ id: 'c1', operator_user_id: ME }]),
    );
    expect(view).toEqual({ kind: 'handedOver' });
  });

  // Naming the number's owner here would name someone who is only
  // watching — the person answering is at the other end of the
  // hand-over.
  it("reports a colleague's handed-over conversation as handed over", () => {
    const view = ownerView(
      conversation('c2', '2026-08-07T10:00:00Z'),
      lookup([{ id: 'c2', operator_user_id: OTHER }]),
    );
    expect(view).toEqual({ kind: 'handedOver' });
  });

  // The bug this rule was written for: a house-number conversation that
  // an operator pulled showed "Número da casa" in the badge while the
  // footer said it had been handed on and the composer was gone.
  it('reports a handed-over HOUSE conversation as handed over, not house', () => {
    const view = ownerView(
      conversation('c3', '2026-08-07T10:00:00Z'),
      lookup([{ id: 'c3', operator_user_id: null }]),
    );
    expect(view).toEqual({ kind: 'handedOver' });
  });

  it('falls back to unknown when the owner has no display name', () => {
    const view = ownerView(conversation('c4'), {
      operatorByConnection: new Map([['c4', 'ghost-user']]),
      nameByUserId: new Map(),
      currentUserId: ME,
    });
    expect(view).toEqual({ kind: 'unknown' });
  });

  // Signed out / user not resolved yet: never claim a conversation is
  // "mine" on the strength of a null id.
  it('never says "me" when there is no signed-in user', () => {
    const view = ownerView(
      conversation('c1'),
      lookup([{ id: 'c1', operator_user_id: ME }], null),
    );
    expect(view).toEqual({ kind: 'other', name: 'Ana' });
  });
});

describe('handedOverToName', () => {
  const lk = lookup([
    { id: 'c-house', operator_user_id: null },
    { id: 'c-mine', operator_user_id: ME },
  ]);

  it('names the operator whose number now holds it', () => {
    const byId = new Map([['dest', { whatsapp_config_id: 'c-mine' }]]);
    const source = { transferred_to_conversation_id: 'dest' };
    expect(handedOverToName(source, lk, byId)).toBe('Ana');
  });

  it('returns null when the destination link is not loaded', () => {
    const byId = new Map<string, { whatsapp_config_id: string | null }>();
    const source = { transferred_to_conversation_id: 'dest' };
    expect(handedOverToName(source, lk, byId)).toBeNull();
  });

  it('returns null when nothing was handed over', () => {
    const byId = new Map([['dest', { whatsapp_config_id: 'c-mine' }]]);
    expect(
      handedOverToName({ transferred_to_conversation_id: null }, lk, byId),
    ).toBeNull();
  });

  // The house number has no operator, so there is no name to give.
  it('returns null when the destination is the house number', () => {
    const byId = new Map([['dest', { whatsapp_config_id: 'c-house' }]]);
    const source = { transferred_to_conversation_id: 'dest' };
    expect(handedOverToName(source, lk, byId)).toBeNull();
  });
});
