"use client";

import { format } from "date-fns";
import { Check, Trash2, User } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { isOverdue } from "@/lib/activities/buckets";
import type { Activity } from "@/types";

interface ActivityCardProps {
  activity: Activity;
  onToggleComplete: (activity: Activity) => void;
  onDelete: (activity: Activity) => void;
  canWrite: boolean;
  /** Compact variant for the calendar's dense month cells. */
  dense?: boolean;
}

export function ActivityCard({
  activity,
  onToggleComplete,
  onDelete,
  canWrite,
  dense = false,
}: ActivityCardProps) {
  const t = useTranslations("Activities.card");
  const overdue = isOverdue(activity);
  const done = Boolean(activity.completed_at);

  if (dense) {
    return (
      <button
        onClick={() => canWrite && onToggleComplete(activity)}
        title={`${activity.title} — ${format(new Date(activity.due_at), "HH:mm")}`}
        className={cn(
          "flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px]",
          done
            ? "bg-muted text-muted-foreground line-through"
            : overdue
              ? "bg-destructive/15 font-medium text-destructive"
              : "bg-primary/10 text-primary",
        )}
      >
        <span className="shrink-0 tabular-nums opacity-70">
          {format(new Date(activity.due_at), "HH:mm")}
        </span>
        <span className="truncate">{activity.title}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "group rounded-lg border p-2.5 transition-colors",
        done
          ? "border-border bg-muted/40"
          : overdue
            ? // Overdue is the one state the board must shout. A tinted
              // fill plus a heavier left edge reads at a glance across
              // the whole column, where a red word alone would not.
              "border-destructive/50 bg-destructive/10 border-l-4 border-l-destructive"
            : "border-border bg-card hover:bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2">
        {canWrite && (
          <button
            onClick={() => onToggleComplete(activity)}
            title={done ? t("reopen") : t("complete")}
            aria-label={done ? t("reopen") : t("complete")}
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
              done
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground/50 hover:border-primary",
            )}
          >
            {done && <Check className="h-3 w-3" />}
          </button>
        )}

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-sm font-medium",
              done
                ? "text-muted-foreground line-through"
                : overdue
                  ? "text-destructive"
                  : "text-foreground",
            )}
          >
            {activity.title}
          </p>

          <p
            className={cn(
              "mt-0.5 text-[11px] tabular-nums",
              overdue && !done
                ? "font-semibold text-destructive"
                : "text-muted-foreground",
            )}
          >
            {format(new Date(activity.due_at), "dd/MM/yyyy HH:mm")}
            {overdue && !done && ` · ${t("overdue")}`}
          </p>

          {activity.contact && (
            <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <User className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {activity.contact.name || activity.contact.phone}
              </span>
            </p>
          )}

          {activity.description && (
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
              {activity.description}
            </p>
          )}
        </div>

        {canWrite && (
          <button
            onClick={() => onDelete(activity)}
            title={t("delete")}
            aria-label={t("delete")}
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
