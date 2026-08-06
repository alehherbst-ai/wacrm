import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// The sender is bound to a decrypted instance token; neither the
// crypto nor the network is under test here. What IS under test is
// WHICH connection row gets picked — a reply leaving from the wrong
// number reaches the customer as a message from a stranger, in a chat
// they never opened.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  sendMenu: vi.fn(),
  sendReaction: vi.fn(),
}));

const {
  resolveConnection,
  resolveConnectionForConversation,
  WhatsAppNotConfiguredError,
} = await import('./uazapi-client');

interface ConfigRow {
  id: string;
  account_id: string;
  provider: string;
  operator_user_id: string | null;
  created_at: string;
  uazapi_instance_token: string;
}

interface ConversationRow {
  id: string;
  account_id: string;
  whatsapp_config_id: string | null;
}

let configs: ConfigRow[];
let conversations: ConversationRow[];
/** Set to fail the conversation lookup, to exercise the fallback. */
let conversationLookupError: { message: string } | null;

/**
 * A stand-in for the Supabase query builder covering exactly the two
 * shapes this module issues: a filtered+ordered read of
 * `whatsapp_config`, and a single-row read of `conversations`.
 */
function makeDb(): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        order: () => builder,
        limit: () => {
          const rows = configs
            .filter((c) =>
              Object.entries(filters).every(
                ([k, v]) => (c as unknown as Record<string, unknown>)[k] === v,
              ),
            )
            // Mirrors the route's ordering: house number first, then oldest.
            .sort((a, b) => {
              const aAssigned = a.operator_user_id !== null ? 1 : 0;
              const bAssigned = b.operator_user_id !== null ? 1 : 0;
              if (aAssigned !== bAssigned) return aAssigned - bAssigned;
              return a.created_at.localeCompare(b.created_at);
            });
          return Promise.resolve({ data: rows.slice(0, 1), error: null });
        },
        maybeSingle: () => {
          if (conversationLookupError) {
            return Promise.resolve({ data: null, error: conversationLookupError });
          }
          const row = conversations.find((c) =>
            Object.entries(filters).every(
              ([k, v]) => (c as unknown as Record<string, unknown>)[k] === v,
            ),
          );
          return Promise.resolve({ data: row ?? null, error: null });
        },
        update: () => builder,
        then: undefined,
      };
      if (table !== 'whatsapp_config' && table !== 'conversations') {
        throw new Error(`unexpected table: ${table}`);
      }
      return builder;
    },
  } as unknown as SupabaseClient;
}

const HOUSE: ConfigRow = {
  id: 'cfg-house',
  account_id: 'acct-1',
  provider: 'uazapi',
  operator_user_id: null,
  created_at: '2026-01-01',
  uazapi_instance_token: 'tok-house',
};
const ANA: ConfigRow = {
  id: 'cfg-ana',
  account_id: 'acct-1',
  provider: 'uazapi',
  operator_user_id: 'user-ana',
  created_at: '2026-02-01',
  uazapi_instance_token: 'tok-ana',
};
const BRUNO: ConfigRow = {
  id: 'cfg-bruno',
  account_id: 'acct-1',
  provider: 'uazapi',
  operator_user_id: 'user-bruno',
  created_at: '2026-03-01',
  uazapi_instance_token: 'tok-bruno',
};

beforeEach(() => {
  configs = [HOUSE, ANA, BRUNO];
  conversations = [];
  conversationLookupError = null;
});

describe('resolveConnectionForConversation', () => {
  it('replies from the number the conversation lives on', async () => {
    conversations = [
      { id: 'cv-1', account_id: 'acct-1', whatsapp_config_id: 'cfg-bruno' },
    ];

    const { config } = await resolveConnectionForConversation(
      makeDb(),
      'acct-1',
      'cv-1',
    );

    // NOT the house number, which is what the account-level lookup
    // would have returned.
    expect(config.id).toBe('cfg-bruno');
  });

  it('picks each operator’s own number for their own conversation', async () => {
    conversations = [
      { id: 'cv-ana', account_id: 'acct-1', whatsapp_config_id: 'cfg-ana' },
      { id: 'cv-bruno', account_id: 'acct-1', whatsapp_config_id: 'cfg-bruno' },
    ];
    const db = makeDb();

    expect(
      (await resolveConnectionForConversation(db, 'acct-1', 'cv-ana')).config.id,
    ).toBe('cfg-ana');
    expect(
      (await resolveConnectionForConversation(db, 'acct-1', 'cv-bruno')).config.id,
    ).toBe('cfg-bruno');
  });

  it('falls back to the account default when the thread predates the column', async () => {
    // Threads created before migration 037 carry no connection.
    conversations = [
      { id: 'cv-old', account_id: 'acct-1', whatsapp_config_id: null },
    ];

    const { config } = await resolveConnectionForConversation(
      makeDb(),
      'acct-1',
      'cv-old',
    );

    expect(config.id).toBe('cfg-house');
  });

  it('falls back when the connection row is gone', async () => {
    // A deleted connection can leave its conversations behind. Better
    // to answer from the default than to refuse to reply at all.
    conversations = [
      { id: 'cv-1', account_id: 'acct-1', whatsapp_config_id: 'cfg-deleted' },
    ];

    const { config } = await resolveConnectionForConversation(
      makeDb(),
      'acct-1',
      'cv-1',
    );

    expect(config.id).toBe('cfg-house');
  });

  it('falls back when the conversation lookup itself fails', async () => {
    conversationLookupError = { message: 'connection reset' };

    const { config } = await resolveConnectionForConversation(
      makeDb(),
      'acct-1',
      'cv-1',
    );

    expect(config.id).toBe('cfg-house');
  });

  it('does not reach into another account', async () => {
    conversations = [
      { id: 'cv-1', account_id: 'acct-OTHER', whatsapp_config_id: 'cfg-bruno' },
    ];

    // The conversation filter includes account_id, so this resolves to
    // nothing and drops to this account's default rather than sending
    // through another tenant's connection.
    const { config } = await resolveConnectionForConversation(
      makeDb(),
      'acct-1',
      'cv-1',
    );

    expect(config.id).toBe('cfg-house');
  });
});

describe('resolveConnection (account default)', () => {
  it('prefers the house number over an operator’s', async () => {
    const { config } = await resolveConnection(makeDb(), 'acct-1');
    expect(config.id).toBe('cfg-house');
  });

  it('falls back to the oldest number when every one has an owner', async () => {
    configs = [BRUNO, ANA];
    const { config } = await resolveConnection(makeDb(), 'acct-1');
    expect(config.id).toBe('cfg-ana'); // created first
  });

  it('throws when the account has connected nothing', async () => {
    configs = [];
    await expect(resolveConnection(makeDb(), 'acct-1')).rejects.toBeInstanceOf(
      WhatsAppNotConfiguredError,
    );
  });
});
