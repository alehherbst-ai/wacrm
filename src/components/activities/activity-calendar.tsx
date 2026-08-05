"use client";

import { useMemo } from "react";
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { isOverdue } from "@/lib/activities/buckets";
import type { Activity } from "@/types";
import { ActivityCard } from "./activity-card";

export type CalendarScale = "day" | "week" | "month";

interface ActivityCalendarProps {
  activities: Activity[];
  scale: CalendarScale;
  /** The date the view is centred on; the page owns navigation state. */
  anchor: Date;
  onAnchorChange: (date: Date) => void;
  onToggleComplete: (activity: Activity) => void;
  onDelete: (activity: Activity) => void;
  /** Clicking an empty day opens the form pre-filled with that date. */
  onPickDay: (date: Date) => void;
  canWrite: boolean;
}

/** Inclusive day range the given scale covers. */
export function rangeFor(anchor: Date, scale: CalendarScale): { from: Date; to: Date } {
  if (scale === "day") {
    return { from: startOfDay(anchor), to: startOfDay(anchor) };
  }
  if (scale === "week") {
    // Monday-first: the CRM's week is a work week, and the rest of the
    // app already labels weekdays Monday-first (see DOW_SHORT_MON_FIRST).
    return {
      from: startOfWeek(anchor, { weekStartsOn: 1 }),
      to: endOfWeek(anchor, { weekStartsOn: 1 }),
    };
  }
  // The month grid always shows whole weeks, so it spills into the
  // neighbouring months rather than leaving ragged edges.
  return {
    from: startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }),
    to: endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }),
  };
}

function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export function ActivityCalendar({
  activities,
  scale,
  anchor,
  onAnchorChange,
  onToggleComplete,
  onDelete,
  onPickDay,
  canWrite,
}: ActivityCalendarProps) {
  const t = useTranslations("Activities.calendar");

  const { from, to } = useMemo(() => rangeFor(anchor, scale), [anchor, scale]);
  const days = useMemo(() => eachDay(from, to), [from, to]);

  // One pass into a per-day map rather than filtering inside each cell:
  // a month view renders 42 cells, and re-scanning the whole list in
  // every one of them is quadratic for no reason.
  const byDay = useMemo(() => {
    const map = new Map<string, Activity[]>();
    for (const activity of activities) {
      const key = format(new Date(activity.due_at), "yyyy-MM-dd");
      const list = map.get(key);
      if (list) list.push(activity);
      else map.set(key, [activity]);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
      );
    }
    return map;
  }, [activities]);

  const forDay = (day: Date) => byDay.get(format(day, "yyyy-MM-dd")) ?? [];

  const step = (direction: 1 | -1) => {
    if (scale === "day") return onAnchorChange(addDays(anchor, direction));
    if (scale === "week") return onAnchorChange(addDays(anchor, 7 * direction));
    return onAnchorChange(addMonths(anchor, direction));
  };

  const heading =
    scale === "day"
      ? format(anchor, "dd/MM/yyyy")
      : scale === "week"
        ? `${format(from, "dd/MM")} – ${format(to, "dd/MM/yyyy")}`
        : format(anchor, "MM/yyyy");

  return (
    <div className="flex h-full flex-col">
      {/* Range navigator */}
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <button
          onClick={() => step(-1)}
          aria-label={t("previous")}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={() => step(1)}
          aria-label={t("next")}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          onClick={() => onAnchorChange(new Date())}
          className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("today")}
        </button>
        <span className="ml-1 text-sm font-medium tabular-nums text-foreground">
          {heading}
        </span>
      </div>

      {scale === "day" ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-3">
          {forDay(anchor).length === 0 ? (
            <button
              onClick={() => canWrite && onPickDay(anchor)}
              className="flex h-full w-full items-center justify-center rounded-lg text-sm text-muted-foreground hover:bg-muted/40"
            >
              {canWrite ? t("emptyDayCta") : t("emptyDay")}
            </button>
          ) : (
            <div className="space-y-2">
              {forDay(anchor).map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  onToggleComplete={onToggleComplete}
                  onDelete={onDelete}
                  canWrite={canWrite}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div
            className={cn(
              "grid gap-2",
              // A week gets seven roomy columns; a month needs the same
              // seven but with six rows of shorter cells.
              "grid-cols-7",
            )}
          >
            {scale === "month" &&
              days.slice(0, 7).map((d) => (
                <div
                  key={`head-${d.toISOString()}`}
                  className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {format(d, "EEEEEE")}
                </div>
              ))}

            {days.map((day) => {
              const items = forDay(day);
              const dayOverdue = items.some((a) => isOverdue(a));
              const outsideMonth =
                scale === "month" && !isSameMonth(day, anchor);

              return (
                <button
                  key={day.toISOString()}
                  onClick={() => canWrite && onPickDay(day)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors",
                    scale === "week" ? "min-h-48" : "min-h-24",
                    outsideMonth && "opacity-45",
                    dayOverdue
                      ? "border-destructive/50 bg-destructive/5"
                      : "border-border bg-card hover:bg-muted/40",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums",
                      isToday(day)
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {format(day, "d")}
                  </span>

                  <div className="flex w-full min-w-0 flex-col gap-0.5">
                    {scale === "week"
                      ? items.map((activity) => (
                          <div key={activity.id} onClick={(e) => e.stopPropagation()}>
                            <ActivityCard
                              activity={activity}
                              onToggleComplete={onToggleComplete}
                              onDelete={onDelete}
                              canWrite={canWrite}
                              dense
                            />
                          </div>
                        ))
                      : items.slice(0, 3).map((activity) => (
                          <div key={activity.id} onClick={(e) => e.stopPropagation()}>
                            <ActivityCard
                              activity={activity}
                              onToggleComplete={onToggleComplete}
                              onDelete={onDelete}
                              canWrite={canWrite}
                              dense
                            />
                          </div>
                        ))}
                    {scale === "month" && items.length > 3 && (
                      <span className="px-1 text-[10px] text-muted-foreground">
                        {t("more", { count: items.length - 3 })}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Exported for the page's "N activities in range" summary. */
export function activitiesInRange(
  activities: Activity[],
  anchor: Date,
  scale: CalendarScale,
): Activity[] {
  const { from, to } = rangeFor(anchor, scale);
  const end = addDays(startOfDay(to), 1);
  return activities.filter((a) => {
    const due = new Date(a.due_at);
    return due >= startOfDay(from) && due < end;
  });
}

export { isSameDay };
