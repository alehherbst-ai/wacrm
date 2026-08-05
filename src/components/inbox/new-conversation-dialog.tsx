"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
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

/**
 * Break typed digits into the parts the mold above the field labels.
 *
 * Exported for tests. Purely presentational — the server re-validates
 * whatever is submitted, so a wrong guess here misleads nobody into a
 * bad write, it only makes the echo less helpful.
 *
 * Brazilian numbers get a real split (country + area + subscriber)
 * because that is what the mold teaches and what every number in this
 * account looks like. Anything else only reports its digit count:
 * guessing where the area code ends for an arbitrary country would be
 * wrong often enough to be worse than saying nothing.
 */
export function describePhoneInput(raw: string): {
  digits: string;
  /** Present only when the shape is confidently recognised. */
  parts: { country: string; area: string; subscriber: string } | null;
  /** True once the digit count could plausibly be a real number. */
  plausible: boolean;
} {
  const digits = raw.replace(/\D/g, "");
  // E.164 allows 7–15 digits; below 10 no country+area+subscriber fits.
  const plausible = digits.length >= 10 && digits.length <= 15;

  // 55 + 2-digit area + 8 or 9 subscriber digits.
  const isBrazil =
    digits.startsWith("55") && (digits.length === 12 || digits.length === 13);

  return {
    digits,
    parts: isBrazil
      ? {
          country: digits.slice(0, 2),
          area: digits.slice(2, 4),
          subscriber: digits.slice(4),
        }
      : null,
    plausible,
  };
}

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

  const described = describePhoneInput(phone);

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

        <div className="space-y-3 py-2">
          {/* The mold. Shown ABOVE the field, and always — the format
              is the thing people get wrong, so it has to be readable
              before typing starts, not surfaced as an error after. Each
              segment is labelled because "5548912345678" as a single
              run of digits is exactly what was unclear. */}
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("moldTitle")}
            </p>
            <div className="flex items-end gap-2 font-mono text-sm text-foreground">
              {(
                [
                  { digits: "55", label: t("moldCountry") },
                  { digits: "48", label: t("moldArea") },
                  { digits: "91234-5678", label: t("moldSubscriber") },
                ] as const
              ).map((seg, i) => (
                <div key={seg.label} className="flex items-end gap-2">
                  {i > 0 && (
                    <span aria-hidden className="pb-4 text-muted-foreground">
                      ·
                    </span>
                  )}
                  <span className="flex flex-col items-center gap-1">
                    <span className="rounded bg-card px-1.5 py-0.5">
                      {seg.digits}
                    </span>
                    <span className="font-sans text-[10px] text-muted-foreground">
                      {seg.label}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("moldNote")}
            </p>
          </div>

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
            aria-describedby="new-conversation-echo"
            className="border-border bg-muted font-mono text-foreground placeholder-muted-foreground"
          />

          {/* Live echo of how the typed value was read. Confirms the
              split matched the mold BEFORE the round-trip, so a missing
              country code shows up as "we only see 11 digits" rather
              than as a puzzling "this number has no WhatsApp". */}
          <p
            id="new-conversation-echo"
            aria-live="polite"
            className={cn(
              "min-h-4 text-xs",
              // Amber, not red, and never disabling the button: this is
              // a nudge while typing, not a verdict. The server is what
              // actually decides, and it gives a clearer reason.
              described.digits.length > 0 && !described.plausible
                ? "text-amber-500"
                : "text-muted-foreground",
            )}
          >
            {described.digits.length === 0
              ? t("hint")
              : described.parts
                ? t("echoParsed", {
                    country: described.parts.country,
                    area: described.parts.area,
                    subscriber: described.parts.subscriber,
                  })
                : t("echoDigits", { count: described.digits.length })}
          </p>

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
