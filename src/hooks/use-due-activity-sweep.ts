"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Raises notifications for activities whose deadline has arrived.
 *
 * This app has no scheduled job runner, so the sweep runs from the
 * client instead of a cron. That is less of a compromise than it
 * sounds: a notification exists to be seen, and the moments someone
 * has the CRM open are exactly the moments it can be. Anything already
 * due gets picked up the first time any teammate looks.
 *
 * The RPC is idempotent (it stamps `notified_at`), so calling it from
 * several tabs, or twice in a row, produces one notification per
 * activity — the guarantee that makes running it this often safe.
 */

/**
 * How often to re-check while the tab stays open. Deadlines are set to
 * the minute at best, and a task coming due while someone watches the
 * screen is the whole point of the feature, so a minute is responsive
 * without being chatty — the RPC is a single indexed query against a
 * partial index of un-notified, unfinished work.
 */
const SWEEP_INTERVAL_MS = 60_000;

export function useDueActivitySweep(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const sweep = async () => {
      // A hidden tab can't show anything anyway, and skipping keeps
      // background tabs from waking the DB every minute forever.
      if (document.visibilityState !== "visible") return;

      // "Today" is the READER's today. The server's NOW() is UTC, so
      // deriving the window there would put a Brazilian agent's
      // heads-up three hours out. The browser is the only place that
      // knows where the person actually is, so it sends the boundaries.
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const { error } = await createClient().rpc("notify_due_activities", {
        p_day_start: dayStart.toISOString(),
        p_day_end: dayEnd.toISOString(),
      });
      if (error && !cancelled) {
        // Non-fatal by design: a missed sweep only delays a bell, and
        // the next tick retries. Logged so a persistent failure (e.g.
        // migration 041 not applied) is visible rather than silent.
        console.warn("[activities] due sweep failed:", error.message);
      }
    };

    void sweep();
    const id = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void sweep();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}
