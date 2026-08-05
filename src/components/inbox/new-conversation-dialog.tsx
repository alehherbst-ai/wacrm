"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired with the conversation id once the thread is ready to open. */
  onStarted: (conversationId: string) => void;
}

/**
 * Reach out to someone who has never written in.
 *
 * The number is validated against WhatsApp server-side before anything
 * is written, so a typo produces an inline error here rather than a
 * permanent contact and a dead thread in the inbox.
 */
export function NewConversationDialog({
  open,
  onOpenChange,
  onStarted,
}: NewConversationDialogProps) {
  const t = useTranslations("Inbox.newConversation");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhone("");
    setError(null);
    setSubmitting(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Never strand a spinner: closing mid-request drops the result on
      // the floor, so clear the form rather than reopening into a stale
      // "checking…" state.
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = phone.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/whatsapp/conversations/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: trimmed }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        // The route distinguishes "not a phone number" from "real
        // number, no WhatsApp" — they call for different corrections,
        // so they get different messages.
        const code = (body as { error?: string } | null)?.error;
        setError(
          code === "not_on_whatsapp"
            ? t("errorNotOnWhatsapp")
            : code === "invalid_number"
              ? t("errorInvalidNumber")
              : code === "not_connected"
                ? t("errorNotConnected")
                : t("errorGeneric"),
        );
        return;
      }

      const conversationId = (body as { conversation_id?: string } | null)
        ?.conversation_id;
      if (!conversationId) {
        setError(t("errorGeneric"));
        return;
      }

      reset();
      onOpenChange(false);
      onStarted(conversationId);
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }, [phone, submitting, t, reset, onOpenChange, onStarted]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Input
            autoFocus
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              // Clear a stale error as soon as the number changes —
              // leaving "no WhatsApp" under a number they just fixed
              // reads as the new number failing too.
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            placeholder={t("placeholder")}
            inputMode="tel"
            disabled={submitting}
            aria-invalid={error ? true : undefined}
            className="border-border bg-muted text-foreground placeholder-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !phone.trim()}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? t("checking") : t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
