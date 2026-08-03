/**
 * Single place that decides which `whatsapp_config` row (and which
 * provider client) an outbound send should use.
 *
 * Before the provider layer existed, five call sites each ran their
 * own `.from('whatsapp_config').eq('account_id', accountId).single()`
 * — correct only because every account had exactly one row. Migration
 * 037 allows a second (one 'meta' + one 'uazapi' per account), so
 * every one of those `.single()` calls would start throwing the
 * moment an account connects both. This module replaces all of them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { createMetaProvider } from './meta-provider';
import { createUazapiProvider } from './uazapi-provider';
import type { WhatsAppProvider } from './types';

export class WhatsAppNotConfiguredError extends Error {
  constructor(
    message = 'WhatsApp not configured. Please set up your WhatsApp integration first.'
  ) {
    super(message);
    this.name = 'WhatsAppNotConfiguredError';
  }
}

export class AmbiguousConnectionError extends Error {
  constructor() {
    super(
      'This account has more than one WhatsApp connection — specify which one to use.'
    );
    this.name = 'AmbiguousConnectionError';
  }
}

// The row shape varies by provider (see migration 037); callers that
// need provider-specific fields read them off `.config` directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WhatsappConfigRow = any;

export interface ResolvedConnection {
  config: WhatsappConfigRow;
  provider: WhatsAppProvider;
}

export interface ResolveOutboundConnectionOptions {
  /**
   * When set, resolution prefers this conversation's own
   * `whatsapp_config_id` — a reply goes out on the channel the thread
   * is already tied to, not just "the account's only connection".
   */
  conversationId?: string;
  /**
   * Explicit override — required when the account has more than one
   * connection and `conversationId` isn't set or isn't yet tied to
   * one (e.g. a brand-new agent-initiated conversation).
   */
  connectionId?: string;
}

/**
 * Resolve the connection an outbound send should use.
 *
 * Precedence:
 *   1. `connectionId`, if passed — explicit caller choice.
 *   2. `conversationId`'s own `whatsapp_config_id`, if it has one.
 *   3. The account's only connection, if it has exactly one — this is
 *      every account that hasn't added a second provider, so it's the
 *      common case and preserves today's behaviour unchanged.
 *   4. Otherwise throws `AmbiguousConnectionError` — the caller must
 *      ask the user which connection to use.
 *
 * Throws `WhatsAppNotConfiguredError` when the account has no
 * connection at all (or the requested one doesn't exist / isn't
 * theirs).
 */
export async function resolveOutboundConnection(
  db: SupabaseClient,
  accountId: string,
  options: ResolveOutboundConnectionOptions = {}
): Promise<ResolvedConnection> {
  const { conversationId, connectionId } = options;

  if (connectionId) {
    const { data, error } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('id', connectionId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !data) throw new WhatsAppNotConfiguredError();
    return buildResolved(db, data);
  }

  if (conversationId) {
    const { data: conv } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (conv?.whatsapp_config_id) {
      const { data, error } = await db
        .from('whatsapp_config')
        .select('*')
        .eq('id', conv.whatsapp_config_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!error && data) return buildResolved(db, data);
      // Linked connection is gone (deleted) — fall through to
      // account-level resolution below.
    }
  }

  const { data: rows, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId);

  if (error || !rows || rows.length === 0) {
    throw new WhatsAppNotConfiguredError();
  }
  if (rows.length > 1) {
    throw new AmbiguousConnectionError();
  }
  return buildResolved(db, rows[0]);
}

function buildResolved(
  db: SupabaseClient,
  config: WhatsappConfigRow
): ResolvedConnection {
  if (config.provider === 'uazapi') {
    return {
      config,
      provider: createUazapiProvider({
        instanceToken: decryptAndMaybeUpgrade(
          db,
          'whatsapp_config',
          config.id,
          'uazapi_instance_token',
          config.uazapi_instance_token
        ),
      }),
    };
  }

  return {
    config,
    provider: createMetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decryptAndMaybeUpgrade(
        db,
        'whatsapp_config',
        config.id,
        'access_token',
        config.access_token
      ),
    }),
  };
}

/**
 * Decrypt a token column and, if it's still in the legacy CBC format,
 * fire-and-forget an upgrade to GCM (mirrors the pattern already used
 * in send-message.ts / webhook/route.ts for `access_token`). Centralized
 * here now that every token decrypt funnels through this module.
 */
function decryptAndMaybeUpgrade(
  db: SupabaseClient,
  table: string,
  rowId: string,
  column: string,
  encrypted: string
): string {
  const value = decrypt(encrypted);
  if (isLegacyFormat(encrypted)) {
    void db
      .from(table)
      .update({ [column]: encrypt(value) })
      .eq('id', rowId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            `[resolve] ${column} GCM upgrade failed for ${table}.${rowId}:`,
            error.message
          );
        }
      });
  }
  return value;
}
