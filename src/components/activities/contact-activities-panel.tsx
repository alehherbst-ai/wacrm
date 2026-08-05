"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  ACTIVITY_SELECT,
  deleteActivity,
  setActivityCompleted,
} from "@/lib/activities/queries";
import type { Activity, Contact } from "@/types";
import { Button } from "@/components/ui/button";
import { ActivityCard } from "./activity-card";
import { ActivityFormDialog } from "./activity-form-dialog";

interface ContactActivitiesPanelProps {
  contact: Pick<Contact, "id" | "name" | "phone">;
}

/**
 * Activities for one contact, shown in the contact drawer.
 *
 * Open work is listed first and completed work after it, rather than
 * hidden: the record of what was already done is most of the value of
 * looking a contact up.
 */
export function ContactActivitiesPanel({ contact }: ContactActivitiesPanelProps) {
  const t = useTranslations("Activities.contactPanel");
  const { canSendMessages } = useAuth();

  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Inside the async body, not the effect's synchronous path —
      // React 19 flags a same-tick setState in an effect as a cascading
      // render. Clearing alongside it stops the previous contact's
      // activities showing under the new contact's name.
      setLoading(true);
      setActivities([]);

      const { data, error } = await createClient()
        .from("activities")
        .select(ACTIVITY_SELECT)
        .eq("contact_id", contact.id)
        .order("due_at", { ascending: true });

      if (cancelled) return;
      if (error) {
        console.error("[activities] contact fetch failed:", error.message);
      } else {
        setActivities((data ?? []) as Activity[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contact.id]);

  const handleToggleComplete = useCallback(async (activity: Activity) => {
    const nextCompleted = !activity.completed_at;
    setActivities((prev) =>
      prev.map((a) =>
        a.id === activity.id
          ? { ...a, completed_at: nextCompleted ? new Date().toISOString() : null }
          : a,
      ),
    );
    const ok = await setActivityCompleted(
      createClient(),
      activity.id,
      nextCompleted,
    );
    if (!ok) {
      setActivities((prev) =>
        prev.map((a) => (a.id === activity.id ? activity : a)),
      );
      toast.error(t("updateError"));
    }
  }, [t]);

  const handleDelete = useCallback(async (activity: Activity) => {
    const previous = activities;
    setActivities((prev) => prev.filter((a) => a.id !== activity.id));
    const ok = await deleteActivity(createClient(), activity.id);
    if (!ok) {
      setActivities(previous);
      toast.error(t("deleteError"));
    }
  }, [activities, t]);

  const open = activities.filter((a) => !a.completed_at);
  const done = activities.filter((a) => a.completed_at);

  return (
    <div className="space-y-3">
      {canSendMessages && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setFormOpen(true)}
          className="w-full border-border"
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("newActivity")}
        </Button>
      )}

      {loading ? (
        <div className="flex justify-center py-6">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : activities.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="space-y-3">
          {open.length > 0 && (
            <div className="space-y-2">
              {open.map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  onToggleComplete={handleToggleComplete}
                  onDelete={handleDelete}
                  canWrite={canSendMessages}
                />
              ))}
            </div>
          )}

          {done.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("completedHeading", { count: done.length })}
              </p>
              {done.map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  onToggleComplete={handleToggleComplete}
                  onDelete={handleDelete}
                  canWrite={canSendMessages}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ActivityFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={contact}
        onCreated={(activity) =>
          setActivities((prev) =>
            [...prev, activity].sort(
              (a, b) =>
                new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
            ),
          )
        }
      />
    </div>
  );
}
