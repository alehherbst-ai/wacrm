/**
 * Value-equality for rows fetched from Supabase.
 *
 * The inbox re-fetches on a timer as a safety net against a silently
 * stale websocket. Almost every one of those fetches returns exactly
 * what is already on screen, but a fresh array of fresh objects still
 * replaces state — which re-renders the list, and (in the thread) fires
 * the scroll-to-bottom effect that watches `messages`. The result was a
 * visible repaint and a scroll jump every 30 seconds.
 *
 * Comparing before setting state turns those no-op refetches into
 * genuinely no-ops.
 *
 * Key order is normalised because the two sides come from different
 * places: a REST `select()` and a realtime `payload.new` carry the same
 * columns but not necessarily in the same order, and a plain
 * `JSON.stringify` would call those different and defeat the whole
 * point.
 */

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const entries = Object.entries(val as Record<string, unknown>);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries);
    }
    return val;
  });
}

/**
 * True when two row lists carry the same data, regardless of object
 * identity or key order. Compares length first so the common
 * "something actually changed" case bails out immediately.
 */
export function rowsEqual(a: unknown[], b: unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return stableStringify(a) === stableStringify(b);
}
