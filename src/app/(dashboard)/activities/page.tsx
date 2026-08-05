"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarDays, KanbanSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  deleteActivity,
  fetchActivities,
  setActivityCompleted,
} from "@/lib/activities/queries";
import { groupByBucket } from "@/lib/activities/buckets";
import type { Activity } from "@/types";
import { ActivityBoard } from "@/components/activities/activity-board";
import {
  ActivityCalendar,
  activitiesInRange,
  type CalendarScale,
} from "@/components/activities/activity-calendar";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { Button } from "@/components/ui/button";

type ViewMode = "board" | "calendar";

export default function ActivitiesPage() {
  const t = useTranslations("Activities.page");
  const { canSendMessages } = useAuth();

  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("board");
  const [scale, setScale] = useState<CalendarScale>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [formOpen, setFormOpen] = useState(false);
  const [formDate, setFormDate] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchActivities(createClient());
      if (cancelled) return;
      setActivities(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const overdueCount = useMemo(
    () => groupByBucket(activities).overdue.length,
    [activities],
  );

  const rangeCount = useMemo(
    () =>
      view === "calendar"
        ? activitiesInRange(activities, anchor, scale).length
        : 0,
    [view, activities, anchor, scale],
  );

  const handleToggleComplete = useCallback(async (activity: Activity) => {
    const nextCompleted = !activity.completed_at;
    // Optimistic: ticking a checkbox should feel instantaneous, and the
    // reconcile below puts it back if the write is rejected.
    setActivities((prev) =>
      prev.map((a) =>
        a.id === activity.id
          ? {
              ...a,
              completed_at: nextCompleted ? new Date().toISOString() : null,
            }
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

  const handleCreated = useCallback((activity: Activity) => {
    setActivities((prev) => [...prev, activity]);
  }, []);

  const openFormFor = useCallback((date: Date | null) => {
    setFormDate(date);
    setFormOpen(true);
  }, []);

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {overdueCount > 0 ? (
              // Overdue count leads the subtitle when there is one — it
              // is the reason to open this page at all.
              <span className="font-medium text-destructive">
                {t("overdueSummary", { count: overdueCount })}
              </span>
            ) : (
              t("description")
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View switch */}
          <div className="flex rounded-lg bg-muted p-0.5">
            {(
              [
                { value: "board", label: t("viewBoard"), icon: KanbanSquare },
                { value: "calendar", label: t("viewCalendar"), icon: CalendarDays },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                onClick={() => setView(option.value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  view === option.value
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <option.icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            ))}
          </div>

          {/* Scale switch — only meaningful for the calendar. */}
          {view === "calendar" && (
            <div className="flex rounded-lg bg-muted p-0.5">
              {(
                [
                  { value: "day", label: t("scaleDay") },
                  { value: "week", label: t("scaleWeek") },
                  { value: "month", label: t("scaleMonth") },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  onClick={() => setScale(option.value)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    scale === option.value
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          {canSendMessages && (
            <Button onClick={() => openFormFor(null)} size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              {t("newActivity")}
            </Button>
          )}
        </div>
      </div>

      {view === "calendar" && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("rangeSummary", { count: rangeCount })}
        </p>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : view === "board" ? (
          <ActivityBoard
            activities={activities}
            onToggleComplete={handleToggleComplete}
            onDelete={handleDelete}
            canWrite={canSendMessages}
          />
        ) : (
          <ActivityCalendar
            activities={activities}
            scale={scale}
            anchor={anchor}
            onAnchorChange={setAnchor}
            onToggleComplete={handleToggleComplete}
            onDelete={handleDelete}
            onPickDay={openFormFor}
            canWrite={canSendMessages}
          />
        )}
      </div>

      <ActivityFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        defaultDate={formDate}
        onCreated={handleCreated}
      />
    </div>
  );
}
