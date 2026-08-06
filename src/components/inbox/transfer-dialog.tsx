"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Candidate {
  user_id: string;
  full_name: string;
  connection_id: string;
}

interface TransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** Shown in the suggested opening message. */
  contactName: string;
  /** Fired with the destination conversation id once the handover lands. */
  onTransferred: (conversationId: string) => void;
}

/**
 * Hand a conversation to another operator.
 *
 * Only people with a WhatsApp number connected can appear here: the
 * conversation created on the other side has to have something to
 * speak with, and offering somebody who cannot receive it would
 * produce a thread that silently never reaches the customer.
 */
export function TransferDialog({
  open,
  onOpenChange,
  conversationId,
  contactName,
  onTransferred,
}: TransferDialogProps) {
  const t = useTranslations("Inbox.transfer");
  const { user, profile } = useAuth();

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [sendOpening, setSendOpening] = useState(true);
  const [openingMessage, setOpeningMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedName = useMemo(
    () => candidates.find((c) => c.user_id === selected)?.full_name ?? "",
    [candidates, selected],
  );

  // Load who can receive this. Done on open so somebody who connected
  // their number a minute ago is already offered.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const [connectionsRes, profilesRes] = await Promise.all([
        supabase.from("whatsapp_config").select("id, operator_user_id"),
        supabase.from("profiles").select("user_id, full_name"),
      ]);
      if (cancelled) return;

      const nameById = new Map<string, string>();
      for (const row of profilesRes.data ?? []) {
        nameById.set(row.user_id, row.full_name ?? "");
      }

      const list: Candidate[] = [];
      for (const row of connectionsRes.data ?? []) {
        const operatorId = row.operator_user_id as string | null;
        // No operator means the house number, which belongs to nobody
        // in particular — there is no person to hand the thread TO.
        if (!operatorId) continue;
        if (operatorId === user?.id) continue;
        list.push({
          user_id: operatorId,
          full_name: nameById.get(operatorId) || t("unnamedOperator"),
          connection_id: row.id as string,
        });
      }
      list.sort((a, b) => a.full_name.localeCompare(b.full_name));
      setCandidates(list);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user?.id, t]);

  // Re-seed the suggested text whenever the destination changes, but
  // never over something the user typed.
  const [openingTouched, setOpeningTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (openingTouched) return;
    setOpeningMessage(
      t("openingSuggestion", {
        operator: selectedName || profile?.full_name || "",
        contact: contactName,
      }),
    );
  }, [open, selectedName, openingTouched, contactName, profile?.full_name, t]);

  const reset = useCallback(() => {
    setSelected(null);
    setSendOpening(true);
    setOpeningMessage("");
    setOpeningTouched(false);
    setSubmitting(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleSubmit = useCallback(async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/whatsapp/conversations/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          to_user_id: selected,
          opening_message:
            sendOpening && openingMessage.trim() ? openingMessage.trim() : "",
        }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(payload.error || t("error"));
        return;
      }

      // The handover itself succeeded; the greeting is a courtesy that
      // can fail on its own. Say so instead of implying the whole
      // thing broke.
      if (payload.opening_message_error) {
        toast.warning(t("openingFailed"), { duration: 10000 });
      } else {
        toast.success(t("done", { operator: selectedName }));
      }

      reset();
      onOpenChange(false);
      onTransferred(payload.conversation_id as string);
    } catch (err) {
      console.error("[transfer] failed:", err);
      toast.error(t("error"));
    } finally {
      setSubmitting(false);
    }
  }, [
    selected,
    submitting,
    conversationId,
    sendOpening,
    openingMessage,
    selectedName,
    reset,
    onOpenChange,
    onTransferred,
    t,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("operatorLabel")}</Label>
            <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : candidates.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t("noOperators")}
                </p>
              ) : (
                candidates.map((candidate) => (
                  <button
                    key={candidate.user_id}
                    type="button"
                    onClick={() => setSelected(candidate.user_id)}
                    disabled={submitting}
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60",
                      selected === candidate.user_id && "bg-primary/10",
                    )}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                      {candidate.full_name.charAt(0).toUpperCase()}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {candidate.full_name}
                    </span>
                    {selected === candidate.user_id && (
                      <ArrowRightLeft className="h-4 w-4 shrink-0 text-primary" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* The customer is told nothing by the transfer itself: they
              keep the old number, with the history in it, and that is
              where they will reply. Until the new operator writes
              first, they have no chat with them at all. Hence checked
              by default — and still a choice. */}
          <div className="space-y-1.5">
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={sendOpening}
                onChange={(e) => setSendOpening(e.target.checked)}
                disabled={submitting}
                className="mt-1 accent-primary"
              />
              <span>
                {t("sendOpening")}
                <span className="block text-xs text-muted-foreground">
                  {t("sendOpeningHint")}
                </span>
              </span>
            </label>

            {sendOpening && (
              <Textarea
                value={openingMessage}
                onChange={(e) => {
                  setOpeningMessage(e.target.value);
                  setOpeningTouched(true);
                }}
                rows={3}
                disabled={submitting}
                className="border-border bg-muted text-foreground"
              />
            )}
          </div>
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
            disabled={submitting || !selected}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting ? t("transferring") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
