// ============================================================
// Which connection row does this request mean?
//
// Until migration 044 the answer was trivial — an account had at most
// one — and the connect / status / disconnect routes each asked with
// `.maybeSingle()`. That call ERRORS when the query matches more than
// one row, so the moment a second number exists those three routes
// would start failing with "UAZAPI connection not found" and no clue
// why. Every one of them now goes through here instead.
//
// Since migration 051 there is no shared connection to disambiguate
// against: every line belongs to exactly one operator, so "which row"
// means "the caller's", or an explicit id when an admin is acting on
// somebody else's. The `scope` parameter that used to pick between a
// personal line and the account's shared one is gone — a request that
// cannot name an operator has no line to find.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface FindConnectionArgs {
  /** An explicit row id always wins — the caller already knows which. */
  connectionId?: string | null;
  /** Whose line to look for. Without it there is nothing to resolve. */
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
  const { connectionId, userId } = args;

  let query = db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi');

  if (connectionId) {
    query = query.eq('id', connectionId);
  } else {
    // No userId means no line can belong to the caller. Returning null
    // is right — inventing a fallback here would hand somebody else's
    // number to whoever asked.
    if (!userId) return null;
    query = query.eq('operator_user_id', userId);
  }

  // Ordered + limited rather than `.maybeSingle()`: the unique index
  // from 044 already guarantees at most one line per operator, but a
  // duplicate would degrade into "picks the oldest" instead of
  // erroring the whole screen.
  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('[connection-target] lookup failed:', error.message);
    return null;
  }
  return data?.[0] ?? null;
}
