"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Search, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { Contact } from "@/types";
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
 * Which half of the dialog is showing. Saved contacts lead because
 * that's the common case — most people you want to reach are already
 * in the CRM, and re-typing a number you already stored is both slower
 * and how duplicate contacts get created.
 */
type StartMode = "contacts" | "number";

/**
 * Reach out to someone who has never written in — by picking a saved
 * contact, or by typing a number for someone who isn't saved yet.
 *
 * Either way the number is validated against WhatsApp server-side
 * before anything is written, so a typo (or a saved contact whose
 * number is stale) produces an inline error here rather than a
 * permanent contact and a dead thread in the inbox.
 */
export function NewConversationDialog({
  open,
  onOpenChange,
  onStarted,
}: NewConversationDialogProps) {
  const t = useTranslations("Inbox.newConversation");
  const [mode, setMode] = useState<StartMode>("contacts");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  /** Which contact's thread is being opened, for the row spinner. */
  const [pendingContactId, setPendingContactId] = useState<string | null>(null);

  const described = describePhoneInput(phone);

  // Load saved contacts when the dialog opens. Fetching on open rather
  // than on mount keeps the inbox from paying for a list nobody asked
  // for, and picks up contacts created since the page loaded.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setContactsLoading(true);
      const { data, error: fetchError } = await createClient()
        .from("contacts")
        .select("id, name, phone, avatar_url, is_group, company")
        // Groups are excluded: a WhatsApp group can't be opened from
        // the outside, only joined. Offering them here would produce a
        // row that always fails.
        .or("is_group.is.null,is_group.eq.false")
        .order("name")
        .limit(500);
      if (cancelled) return;
      if (fetchError) {
        console.error("[new-conversation] contact fetch failed:", fetchError.message);
      } else {
        setContacts((data ?? []) as Contact[]);
      }
      setContactsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filteredContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    if (!q) return contacts;
    // Digits-only comparison too, so searching "48 99123" finds a
    // contact stored as "5548991234567".
    const qDigits = q.replace(/\D/g, "");
    return contacts.filter((c) => {
      const name = (c.name ?? "").toLowerCase();
      const phoneValue = c.phone ?? "";
      const company = (c.company ?? "").toLowerCase();
      return (
        name.includes(q) ||
        company.includes(q) ||
        phoneValue.toLowerCase().includes(q) ||
        (qDigits.length > 0 && phoneValue.replace(/\D/g, "").includes(qDigits))
      );
    });
  }, [contacts, contactSearch]);

  const reset = useCallback(() => {
    setPhone("");
    setError(null);
    setSubmitting(false);
    setContactSearch("");
    setPendingContactId(null);
    setMode("contacts");
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

  /**
   * Resolve a number into a thread and hand it to the parent. Shared by
   * both halves of the dialog so a saved contact and a typed number go
   * through exactly the same validation and the same error vocabulary —
   * a stored number can be wrong too.
   */
  const startConversation = useCallback(
    async (phoneValue: string) => {
      setError(null);
      try {
        const res = await fetch("/api/whatsapp/conversations/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phoneValue }),
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
      }
    },
    [t, reset, onOpenChange, onStarted],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = phone.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await startConversation(trimmed);
    } finally {
      setSubmitting(false);
    }
  }, [phone, submitting, startConversation]);

  const handlePickContact = useCallback(
    async (contact: Contact) => {
      if (pendingContactId || !contact.phone) return;
      setPendingContactId(contact.id);
      try {
        await startConversation(contact.phone);
      } finally {
        setPendingContactId(null);
      }
    },
    [pendingContactId, startConversation],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {mode === "contacts" ? t("descriptionContacts") : t("description")}
          </DialogDescription>
        </DialogHeader>

        {/* Mode switch — same segmented control as the inbox audience
            tabs, so the two read as the same kind of choice. */}
        <div
          role="tablist"
          aria-label={t("modeTabs")}
          className="flex rounded-lg bg-muted p-0.5"
        >
          {(
            [
              { value: "contacts", label: t("modeContacts") },
              { value: "number", label: t("modeNumber") },
            ] as { value: StartMode; label: string }[]
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={mode === tab.value}
              onClick={() => {
                setMode(tab.value);
                // An error raised by the other half is about a number
                // the user is no longer looking at.
                setError(null);
              }}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                mode === tab.value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {mode === "contacts" ? (
          <div className="space-y-3 py-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder={t("searchContactsPlaceholder")}
                className="border-border bg-muted pl-9 text-foreground placeholder-muted-foreground"
              />
            </div>

            {/* Fixed-height list: the dialog must not grow or shrink as
                the filter narrows, or the buttons below it move under
                the cursor mid-click. */}
            <div className="h-64 overflow-y-auto rounded-lg border border-border">
              {contactsLoading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    {contacts.length === 0
                      ? t("noContacts")
                      : t("noContactsMatch")}
                  </p>
                  <button
                    type="button"
                    onClick={() => setMode("number")}
                    className="text-xs text-primary hover:underline"
                  >
                    {t("useNumberInstead")}
                  </button>
                </div>
              ) : (
                filteredContacts.map((contact) => {
                  const label = contact.name || contact.phone;
                  const isPending = pendingContactId === contact.id;
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={() => void handlePickContact(contact)}
                      disabled={pendingContactId !== null}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-foreground">
                        {contact.avatar_url ? (
                          <img
                            src={contact.avatar_url}
                            alt={label}
                            className="h-8 w-8 rounded-full object-cover"
                          />
                        ) : (
                          label.charAt(0).toUpperCase()
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{label}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {isPending ? t("checking") : contact.phone}
                        </p>
                      </div>
                      {isPending ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : (
                        <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        ) : (
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
        )}

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting || pendingContactId !== null}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          {/* Only the typed-number half has something to submit — a
              contact row IS its own submit button. */}
          {mode === "number" && (
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !phone.trim()}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? t("checking") : t("start")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
