"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ACTIVITY_BUCKETS, groupByBucket } from "@/lib/activities/buckets";
import type { Activity } from "@/types";
import { ActivityCard } from "./activity-card";

interface ActivityBoardProps {
  activities: Activity[];
  onToggleComplete: (activity: Activity) => void;
  onDelete: (activity: Activity) => void;
  canWrite: boolean;
}

/**
 * Kanban of what's outstanding, ordered by urgency left to right.
 *
 * Columns run overdue → today → tomorrow → next 3 days → later so the
 * eye lands on the work that's late first; a chronological left-to-
 * right (later → overdue) would bury it off the right edge.
 */
export function ActivityBoard({
  activities,
  onToggleComplete,
  onDelete,
  canWrite,
}: ActivityBoardProps) {
  const t = useTranslations("Activities.board");
  const grouped = useMemo(() => groupByBucket(activities), [activities]);

  return (
    <div className="flex h-full gap-3 overflow-x-auto pb-2">
      {ACTIVITY_BUCKETS.map((bucket) => {
        const items = grouped[bucket];
        const isOverdueColumn = bucket === "overdue";
        const hasOverdue = isOverdueColumn && items.length > 0;

        return (
          <div
            key={bucket}
            className={cn(
              "flex w-72 shrink-0 flex-col rounded-xl border",
              hasOverdue
                ? "border-destructive/50 bg-destructive/5"
                : "border-border bg-card",
            )}
          >
            <div
              className={cn(
                "flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2.5",
                hasOverdue ? "border-destructive/30" : "border-border",
              )}
            >
              <h3
                className={cn(
                  "text-sm font-semibold",
                  hasOverdue ? "text-destructive" : "text-foreground",
                )}
              >
                {t(bucket)}
              </h3>
              <span
                className={cn(
                  "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
                  hasOverdue
                    ? "bg-destructive text-white"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {items.length}
              </span>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {items.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {t("empty")}
                </p>
              ) : (
                items.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    onToggleComplete={onToggleComplete}
                    onDelete={onDelete}
                    canWrite={canWrite}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
