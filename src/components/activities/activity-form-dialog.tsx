"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { createActivity } from "@/lib/activities/queries";
import type { Activity, Contact } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ActivityFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-bound contact — set when opening from a contact's tab. */
  contact?: Pick<Contact, "id" | "name" | "phone"> | null;
  /** Prefills the deadline's date, e.g. the calendar day that was clicked. */
  defaultDate?: Date | null;
  onCreated: (activity: Activity) => void;
}

/**
 * Format a Date for `<input type="datetime-local">`, which wants local
 * wall-clock time with no zone. `toISOString()` would silently shift
 * the value by the UTC offset — a 9am reminder becoming 6am (or noon)
 * depending on where the agent is.
 */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Tomorrow at 9am — the deadline people actually pick most of the time. */
function defaultDueAt(base?: Date | null): Date {
  const d = base ? new Date(base) : new Date();
  if (!base) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function ActivityFormDialog({
  open,
  onOpenChange,
  contact,
  defaultDate,
  onCreated,
}: ActivityFormDialogProps) {
  const t = useTranslations("Activities.form");
  const { accountId, user } = useAuth();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState(() =>
    toLocalInputValue(defaultDueAt(defaultDate)),
  );
  const [saving, setSaving] = useState(false);

  // Re-seed on open so a second use doesn't inherit the previous
  // draft, and so a calendar day clicked after mount is respected.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setDueAt(toLocalInputValue(defaultDueAt(defaultDate)));
  }, [open, defaultDate]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !dueAt || saving) return;
    if (!accountId || !user) {
      toast.error(t("errorGeneric"));
      return;
    }

    setSaving(true);
    try {
      // `new Date("YYYY-MM-DDTHH:mm")` parses as LOCAL time, which is
      // what the field means; the query layer converts to UTC for
      // storage.
      const parsed = new Date(dueAt);
      if (Number.isNaN(parsed.getTime())) {
        toast.error(t("errorInvalidDate"));
        return;
      }

      const created = await createActivity(createClient(), {
        accountId,
        userId: user.id,
        title,
        description,
        dueAt: parsed,
        contactId: contact?.id ?? null,
      });

      if (!created) {
        toast.error(t("errorGeneric"));
        return;
      }

      toast.success(t("created"));
      onCreated(created);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [title, description, dueAt, saving, accountId, user, contact, t, onCreated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {contact
              ? t("descriptionForContact", {
                  name: contact.name || contact.phone,
                })
              : t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="activity-title">{t("titleLabel")}</Label>
            <Input
              id="activity-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
              disabled={saving}
              className="border-border bg-muted text-foreground"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="activity-due">{t("dueLabel")}</Label>
            <Input
              id="activity-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              disabled={saving}
              className="border-border bg-muted text-foreground"
            />
            <p className="text-xs text-muted-foreground">{t("dueHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="activity-description">{t("notesLabel")}</Label>
            <Textarea
              id="activity-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("notesPlaceholder")}
              rows={3}
              disabled={saving}
              className="border-border bg-muted text-foreground"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving || !title.trim()}
          >
            {saving ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
