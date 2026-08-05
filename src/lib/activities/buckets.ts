/**
 * Deadline buckets for the activities board.
 *
 * These are derived, never stored (see migration 041): "today" depends
 * on the reader's clock, and a stored bucket would be stale by the next
 * midnight. Keeping the rule here — pure, one place — means the board,
 * the calendar badges and any future digest all agree on what "overdue"
 * means.
 */

import type { Activity } from "@/types";

export const ACTIVITY_BUCKETS = [
  "overdue",
  "today",
  "tomorrow",
  "next3",
  "later",
] as const;

export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

/** Local midnight that starts the day `offset` days from `from`. */
function startOfDayOffset(from: Date, offset: number): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

/**
 * Which column an activity belongs in.
 *
 * Overdue wins over everything: a task due at 09:00 that it is now
 * 17:00 of the same day is late, and calling it "today" would hide the
 * one state the board exists to make loud.
 *
 * Boundaries are local-midnight based, so a task due 23:50 today and
 * one due 00:10 tomorrow land in different columns, which is how a
 * person reads a deadline.
 *
 * Meaningful for OPEN work only. The board has no "done" column (none
 * of the five the product asks for is one), so `groupByBucket` drops
 * completed activities rather than filing them somewhere misleading —
 * a task finished in July is neither overdue nor due today.
 */
export function bucketFor(
  activity: Pick<Activity, "due_at" | "completed_at">,
  now: Date = new Date(),
): ActivityBucket {
  const due = new Date(activity.due_at);

  if (!activity.completed_at && due.getTime() < now.getTime()) {
    return "overdue";
  }

  const tomorrow = startOfDayOffset(now, 1);
  if (due < tomorrow) return "today";

  const dayAfterTomorrow = startOfDayOffset(now, 2);
  if (due < dayAfterTomorrow) return "tomorrow";

  // "Next 3 days" is the two days after tomorrow — tomorrow has its own
  // column, so overlapping them would list the same task twice.
  const inFourDays = startOfDayOffset(now, 4);
  if (due < inFourDays) return "next3";

  return "later";
}

/**
 * Group open activities into the five board columns, each ordered by
 * deadline.
 *
 * Completed work is dropped: the board is a list of what still needs
 * doing, and every column name is about a deadline that has not been
 * met yet.
 */
export function groupByBucket(
  activities: Activity[],
  now: Date = new Date(),
): Record<ActivityBucket, Activity[]> {
  const grouped = {
    overdue: [] as Activity[],
    today: [] as Activity[],
    tomorrow: [] as Activity[],
    next3: [] as Activity[],
    later: [] as Activity[],
  };

  const sorted = [...activities]
    .filter((a) => !a.completed_at)
    .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  for (const activity of sorted) {
    grouped[bucketFor(activity, now)].push(activity);
  }
  return grouped;
}

/**
 * True when the activity is past its deadline and still open — the
 * single condition the UI paints red.
 */
export function isOverdue(
  activity: Pick<Activity, "due_at" | "completed_at">,
  now: Date = new Date(),
): boolean {
  return bucketFor(activity, now) === "overdue";
}
