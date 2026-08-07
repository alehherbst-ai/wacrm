import { describe, it, expect } from 'vitest';

import { buildOwnerLookup, ownerView } from './conversation-owner';

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

  // Someone else's hand-over is not my business: from here it is still
  // their conversation, and their name is the useful answer.
  it("keeps naming the colleague when THEY handed their conversation over", () => {
    const view = ownerView(
      conversation('c2', '2026-08-07T10:00:00Z'),
      lookup([{ id: 'c2', operator_user_id: OTHER }]),
    );
    expect(view).toEqual({ kind: 'other', name: 'Bruno' });
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
