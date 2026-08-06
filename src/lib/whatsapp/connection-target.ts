// ============================================================
// Which connection row does this request mean?
//
// Until migration 044 the answer was trivial — an account had at most
// one — and the connect / status / disconnect routes each asked with
// `.maybeSingle()`. That call ERRORS when the query matches more than
// one row, so the moment a second number exists those three routes
// would start failing with "UAZAPI connection not found" and no clue
// why. Every one of them now goes through here instead.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whose line a request is about.
 *
 * `account` is the house number — the connection with no operator
 * assigned, which is what every account had before operators existed.
 * `mine` is the caller's own line.
 */
export type ConnectionScope = 'account' | 'mine';

export function parseConnectionScope(value: unknown): ConnectionScope {
  return value === 'mine' ? 'mine' : 'account';
}

export interface FindConnectionArgs {
  /** An explicit row id always wins — the caller already knows which. */
  connectionId?: string | null;
  scope?: ConnectionScope;
  /** Required when `scope` is 'mine'. */
  userId?: string | null;
}

// The row shape is `whatsapp_config`; callers read the columns they need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigRow = any;

/**
 * Resolve the connection a settings-screen request is talking about.
 *
 * Returns null when there is nothing to act on, so callers answer 404
 * rather than surfacing a Postgres error.
 */
export async function findTargetConnection(
  db: SupabaseClient,
  accountId: string,
  args: FindConnectionArgs = {}
): Promise<ConfigRow | null> {
  const { connectionId, scope = 'account', userId } = args;

  let query = db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi');

  if (connectionId) {
    query = query.eq('id', connectionId);
  } else if (scope === 'mine') {
    // No userId means no line can belong to the caller. Returning null
    // is right — inventing a fallback here would hand somebody else's
    // number to whoever asked.
    if (!userId) return null;
    query = query.eq('operator_user_id', userId);
  } else {
    query = query.is('operator_user_id', null);
  }

  // Ordered + limited rather than `.maybeSingle()`: the partial unique
  // indexes from 044 already guarantee at most one row for each branch
  // above, but a duplicate would now degrade into "picks the oldest"
  // instead of erroring the whole screen.
  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('[connection-target] lookup failed:', error.message);
    return null;
  }
  return data?.[0] ?? null;
}
