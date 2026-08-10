"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES, formatCurrencyExact } from "@/lib/currency";
import type {
  Contact,
  Conversation,
  Deal,
  DealProduct,
  DealStatus,
  LeadSource,
  PipelineStage,
  Product,
  Profile,
} from "@/types";
import {
  DealProductsEditor,
  draftKey,
  itemsTotal,
  type DealItemDraft,
} from "./deal-products-editor";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  DollarSign,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  /**
   * Preselects the contact on a NEW deal. Set by callers that already
   * know who the deal is for — the inbox sidebar creates deals from
   * inside a conversation, where asking the user to re-pick the contact
   * they're already talking to would be busywork. Ignored when editing
   * an existing deal, which carries its own contact.
   */
  defaultContactId?: string;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  defaultContactId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [items, setItems] = useState<DealItemDraft[]>([]);
  /** Mirrors `deals.value_is_manual`: while false the value shown is the
   *  sum of the line items and the input stays locked. */
  const [valueIsManual, setValueIsManual] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sources, setSources] = useState<LeadSource[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
      setSourceId(deal.source_id ?? "");
      setValueIsManual(deal.value_is_manual ?? false);
      // Line items arrive from their own fetch below; clear whatever the
      // previously-opened deal left behind so the two never mix.
      setItems([]);
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId(defaultContactId ?? "");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
      setSourceId("");
      setValueIsManual(false);
      setItems([]);
    }
  }, [open, deal, defaultStageId, defaultContactId, stages, defaultCurrency]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [c, p, prod, src] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
        // Archived products come back too: an old deal may still point
        // at one, and the editor needs its name to render that line.
        supabase.from("products").select("*").order("name"),
        supabase
          .from("lead_sources")
          .select("*")
          .order("name"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
      setProducts((prod.data ?? []) as Product[]);
      setSources((src.data ?? []) as LeadSource[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  // Line items for the deal being edited. Separate from the block above
  // because it depends on which deal is open, not just on the sheet.
  useEffect(() => {
    if (!open || !deal) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("deal_products")
        .select("*")
        .eq("deal_id", deal.id)
        .order("created_at");
      if (cancelled) return;
      setItems(
        ((data ?? []) as DealProduct[]).map((row) => ({
          key: draftKey(),
          product_id: row.product_id,
          quantity: String(row.quantity),
          unit_price: String(row.unit_price),
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, deal, supabase]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  // Rows the database would actually accept: a product picked and a
  // positive quantity. Half-filled rows are ignored rather than
  // blocking the save — an empty row is how "I'm still deciding"
  // looks, not an error.
  const validItems = items.filter(
    (it) => it.product_id && (parseFloat(it.quantity) || 0) > 0,
  );
  const computedTotal = itemsTotal(validItems);
  const valueLocked = validItems.length > 0 && !valueIsManual;
  const effectiveValue = valueLocked
    ? computedTotal
    : parseFloat(value) || 0;

  /**
   * Replace the deal's line items wholesale rather than diffing them.
   * The set is small (a handful of rows), the unique index on
   * (deal_id, product_id) makes a partial update fiddly, and the
   * value-recompute trigger settles on the same total either way.
   */
  async function syncDealProducts(dealId: string): Promise<boolean> {
    const rows = validItems.map((it) => ({
      account_id: accountId,
      deal_id: dealId,
      product_id: it.product_id,
      quantity: parseFloat(it.quantity) || 0,
      unit_price: parseFloat(it.unit_price) || 0,
    }));

    const { error: delError } = await supabase
      .from("deal_products")
      .delete()
      .eq("deal_id", dealId);
    if (delError) return false;

    if (rows.length === 0) return true;

    const { error: insError } = await supabase
      .from("deal_products")
      .insert(rows);
    return !insError;
  }

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      // With line items and no manual override, the sum is the value.
      // The DB trigger arrives at the same number when the items land;
      // sending it here just keeps the row correct in the window
      // between the two writes.
      value: effectiveValue,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      source_id: sourceId || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
      // An override only means anything while there are items to
      // override; without them the flag would just freeze the value
      // against items added later.
      value_is_manual: validItems.length > 0 && valueIsManual,
    };

    let dealId = deal?.id ?? null;

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update(payload)
        .eq("id", deal.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("toastNotSignedIn"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { data: created, error } = await supabase
        .from("deals")
        .insert({ ...payload, user_id: user.id, account_id: accountId, status: "open" })
        .select("id")
        .single();
      if (error || !created) {
        toast.error(t("toastFailedCreate"));
        setSaving(false);
        return;
      }
      dealId = created.id;
    }

    // The deal itself is saved at this point. A line-item failure is
    // reported but doesn't roll the deal back — losing the whole edit
    // over one bad row would be worse than an incomplete item list the
    // user can fix by reopening.
    if (dealId) {
      const ok = await syncDealProducts(dealId);
      if (!ok) toast.error(t("toastFailedItems"));
    }

    setSaving(false);
    toast.success(deal ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from("deals")
      .update({ status })
      .eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    toast.success(
      status === "won" ? t("toastMarkedWon") : status === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("title")}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("contact")}</Label>
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t("selectContact")}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.phone}
                  </option>
                ))}
              </select>

              {linkedConversation && (
                <Link
                  href="/inbox"
                  className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t("linkToConversation")}
                </Link>
              )}
            </div>

            <DealProductsEditor
              items={items}
              onChange={setItems}
              products={products}
              currency={currency}
            />

            <div className="grid grid-cols-[1fr_110px] gap-3">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-muted-foreground">{t("value")}</Label>
                  {validItems.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        // Leaving override mode snaps the field back to
                        // the sum, so "restore" needs no second control.
                        if (valueIsManual) setValue(String(computedTotal));
                        setValueIsManual(!valueIsManual);
                      }}
                      className="text-[11px] text-primary hover:underline"
                    >
                      {valueIsManual ? t("useItemsTotal") : t("overrideValue")}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="number"
                    value={valueLocked ? String(computedTotal) : value}
                    onChange={(e) => setValue(e.target.value)}
                    readOnly={valueLocked}
                    aria-readonly={valueLocked}
                    placeholder="0"
                    className={`border-border bg-muted pl-7 text-foreground ${
                      valueLocked ? "cursor-not-allowed opacity-70" : ""
                    }`}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("currency")}</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* A typed value that no longer matches the items is a
                decision, not a bug — but it has to be visible, or the
                per-product chart quietly stops adding up to revenue. */}
            {validItems.length > 0 &&
              valueIsManual &&
              Math.abs(effectiveValue - computedTotal) > 0.005 && (
                <p className="-mt-2 text-xs text-amber-500">
                  {t("valueDiverges", {
                    total: formatCurrencyExact(computedTotal, currency),
                  })}
                </p>
              )}

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("source")}</Label>
              <select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("noSource")}</option>
                {sources
                  .filter((s) => s.is_active || s.id === sourceId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("expectedCloseDate")}</Label>
              <Input
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("stage")}</Label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("assignedTo")}</Label>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("unassigned")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("notes")}</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[100px] border-border bg-muted text-foreground"
              />
            </div>

            {deal && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("status")}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="mr-1 h-4 w-4" />
                        {t("markAsWon")}
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("lost")}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="flex-1 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-4 w-4" />
                        {t("markAsLost")}
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    {t("reopenDeal")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !title.trim() || !contactId || !stageId}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : deal ? t("saveChanges") : t("createDeal")}
              </Button>
            </div>

            {deal &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">{t("deletePrompt")}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t("deleting") : t("confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("deleteDeal")}
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
