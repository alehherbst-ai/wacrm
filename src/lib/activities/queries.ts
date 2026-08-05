import type { SupabaseClient } from "@supabase/supabase-js";
import type { Activity } from "@/types";

/**
 * Shared shape for every activity read, so the board, the calendar and
 * the contact tab all get the contact joined and can't drift on which
 * columns they have.
 */
export const ACTIVITY_SELECT =
  "*, contact:contacts(id, name, phone, avatar_url, is_group)";

export interface ActivityInput {
  title: string;
  description?: string | null;
  /** Local wall-clock value from a `datetime-local` input. */
  dueAt: Date;
  contactId?: string | null;
}

/**
 * Load an account's activities, soonest deadline first.
 *
 * RLS scopes the rows, so no account filter appears here — the same
 * pattern the inbox and pipelines use.
 */
export async function fetchActivities(
  db: SupabaseClient,
): Promise<Activity[]> {
  const { data, error } = await db
    .from("activities")
    .select(ACTIVITY_SELECT)
    .order("due_at", { ascending: true });

  if (error) {
    console.error("[activities] fetch failed:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    return [];
  }
  return (data ?? []) as Activity[];
}

/**
 * Create an activity. `assigned_to` defaults to the creator — the
 * common case is "remind me", and an unassigned activity would notify
 * nobody when it came due (see the sweep in migration 041).
 */
export async function createActivity(
  db: SupabaseClient,
  args: ActivityInput & { accountId: string; userId: string },
): Promise<Activity | null> {
  const { data, error } = await db
    .from("activities")
    .insert({
      account_id: args.accountId,
      user_id: args.userId,
      assigned_to: args.userId,
      contact_id: args.contactId ?? null,
      title: args.title.trim(),
      description: args.description?.trim() || null,
      due_at: args.dueAt.toISOString(),
    })
    .select(ACTIVITY_SELECT)
    .single();

  if (error) {
    console.error("[activities] create failed:", error.message);
    return null;
  }
  return data as Activity;
}

/**
 * Toggle completion.
 *
 * Clearing `notified_at` when an activity is re-opened is deliberate:
 * the sweep skips anything already notified, so without this a task
 * that was completed and then re-opened past its deadline would never
 * announce itself again.
 */
export async function setActivityCompleted(
  db: SupabaseClient,
  activityId: string,
  completed: boolean,
): Promise<boolean> {
  const { error } = await db
    .from("activities")
    .update(
      completed
        ? { completed_at: new Date().toISOString() }
        : { completed_at: null, notified_at: null },
    )
    .eq("id", activityId);

  if (error) {
    console.error("[activities] completion update failed:", error.message);
    return false;
  }
  return true;
}

export async function deleteActivity(
  db: SupabaseClient,
  activityId: string,
): Promise<boolean> {
  const { error } = await db.from("activities").delete().eq("id", activityId);
  if (error) {
    console.error("[activities] delete failed:", error.message);
    return false;
  }
  return true;
}
