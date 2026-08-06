"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { rowsEqual } from "@/lib/inbox/rows-equal";
import { cn } from "@/lib/utils";
import type { Contact, Conversation, ConversationStatus, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  Users,
  CheckCheck,
  Plus,
  MessageSquarePlus,
} from "lucide-react";
import { NewConversationDialog } from "./new-conversation-dialog";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Called after "clear inbox" successfully zeroes every unread count
   * server-side, so the parent can mirror it in state immediately
   * instead of waiting for N realtime UPDATEs to round-trip.
   */
  onMarkAllRead?: () => void;
  /**
   * Fired after "new conversation" resolves a typed number into a
   * thread. The parent owns selection, so it decides what to open.
   */
  onConversationStarted?: (conversationId: string) => void;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread" | "archived";

/**
 * Audience tabs — people vs groups. Orthogonal to the status filter on
 * purpose: "unread groups" and "open 1:1s" are both real workflows, so
 * the two compose instead of one replacing the other.
 */
type InboxAudience = "all" | "people" | "groups";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onMarkAllRead,
  onConversationStarted,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  // Clearing the inbox is a write to `conversations`, which the
  // `conversations_update` RLS policy (migration 017) gates on the
  // 'agent' role — the same gate `canSendMessages` encodes. Viewers
  // don't get the button rather than getting one that always fails.
  const { canSendMessages } = useAuth();
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
    // Archived threads are hidden from every other view, so this is
    // the only way back to one before the contact writes again — the
    // "clear inbox" action would otherwise read as destructive.
    { label: t("filterArchived"), value: "archived" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [audience, setAudience] = useState<InboxAudience>("all");
  const [loading, setLoading] = useState(true);
  const [clearingInbox, setClearingInbox] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  // Saved contacts, for suggesting people who have no thread yet.
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [startingContactId, setStartingContactId] = useState<string | null>(null);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  // What's currently listed, readable from inside the async fetch so a
  // resync that changes nothing can skip the state update entirely.
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      const rows = normalizeConversations(data ?? []);
      // The safety-net refetch below runs every 30s and almost always
      // returns exactly what is already listed. Pushing that back up as
      // a fresh array re-renders every row for nothing; only hand over
      // a result that actually differs.
      if (!rowsEqual(rows, conversationsRef.current)) {
        onConversationsLoadedRef.current(rows);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  // Saved contacts ride along: the search box suggests people who have
  // no conversation yet, and both are small account-wide reference sets
  // that never change while the inbox is open.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const [tagsRes, contactsRes] = await Promise.all([
        supabase.from("tags").select("*").order("name"),
        supabase
          .from("contacts")
          .select("id, name, phone, avatar_url, is_group")
          .order("name"),
      ]);
      if (cancelled) return;
      if (tagsRes.data) setTags(tagsRes.data as Tag[]);
      if (contactsRes.data) setAllContacts(contactsRes.data as Contact[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (audience !== "all") {
      // `is_group` is nullable on old rows — treat absent as "person",
      // which is what every pre-038 contact actually is.
      result = result.filter((c) =>
        audience === "groups"
          ? c.contact?.is_group === true
          : c.contact?.is_group !== true
      );
    }

    // Archived threads are hidden from every view except their own
    // (migration 040). Applied before the status filter so "Fechadas"
    // doesn't quietly resurrect a thread the agent cleared away.
    if (filter === "archived") {
      result = result.filter((c) => Boolean(c.archived_at));
    } else {
      result = result.filter((c) => !c.archived_at);

      if (filter === "unread") {
        result = result.filter((c) => c.unread_count > 0);
      } else if (filter !== "all") {
        result = result.filter((c) => c.status === filter);
      }
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      // Same digits-only fallback the contact suggestions use, so a
      // number typed with spaces or a leading "+" still matches.
      const qDigits = q.replace(/\D/g, "");
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone ?? "";
        const company = c.contact?.company?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return (
          name.includes(q) ||
          company.includes(q) ||
          phone.toLowerCase().includes(q) ||
          lastMsg.includes(q) ||
          (qDigits.length > 0 && phone.replace(/\D/g, "").includes(qDigits))
        );
      });
    }

    // Sort newest-first HERE rather than relying on the server's
    // `.order("last_message_at")`. That ordering only describes the array
    // as it was fetched; realtime updates patch `last_message_at` in
    // place (see handleMessageEvent in the inbox page), which changes the
    // value but never the array position. A conversation sitting 8th in
    // the list would receive a message and stay 8th — the preview text
    // and unread badge updated, but the row never moved, which reads as
    // "the inbox isn't live" on any account with more than a screenful
    // of conversations. Sorting on render makes every realtime patch
    // reorder the list the way the user expects.
    return [...result].sort((a, b) => {
      const at = a.last_message_at ?? a.created_at;
      const bt = b.last_message_at ?? b.created_at;
      if (!at && !bt) return 0;
      if (!at) return 1;
      if (!bt) return -1;
      return new Date(bt).getTime() - new Date(at).getTime();
    });
  }, [conversations, audience, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  /**
   * Saved contacts matching the search that have NO conversation in the
   * list yet.
   *
   * Searching for someone you've never messaged used to return nothing,
   * which reads as "this person isn't in the CRM" when they are — they
   * just have no thread. Surfacing them here turns a dead end into one
   * click. Contacts that already have a conversation are excluded
   * because the list above is already the better answer for them.
   */
  const contactSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    // One character is enough. Waiting for two meant the first keystroke
    // produced "no conversations found" and nothing else, which reads as
    // an empty CRM at exactly the moment the user is looking for proof
    // it isn't.
    if (q.length < 1) return [];

    // Typed punctuation must not stop a number matching: "48 9912"
    // should find a contact stored as "5548991234567".
    const qDigits = q.replace(/\D/g, "");

    const withConversation = new Set(
      conversations.map((c) => c.contact_id).filter(Boolean),
    );

    return allContacts
      .filter((c) => {
        if (withConversation.has(c.id)) return false;
        // Groups can't be started from here — you can't open a WhatsApp
        // group you were never added to.
        if (c.is_group) return false;
        if (audience === "groups") return false;
        const phone = c.phone ?? "";
        return (
          (c.name ?? "").toLowerCase().includes(q) ||
          phone.toLowerCase().includes(q) ||
          (qDigits.length > 0 && phone.replace(/\D/g, "").includes(qDigits))
        );
      })
      .slice(0, 8);
  }, [search, conversations, allContacts, audience]);

  const handlePickContact = useCallback(
    async (contact: Contact) => {
      if (startingContactId) return;
      setStartingContactId(contact.id);
      try {
        const res = await fetch("/api/whatsapp/conversations/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: contact.phone }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.conversation_id) {
          const code = (body as { error?: string } | null)?.error;
          toast.error(
            code === "not_on_whatsapp"
              ? t("startNotOnWhatsapp")
              : t("startError"),
          );
          return;
        }
        setSearch("");
        onConversationStarted?.(body.conversation_id as string);
      } catch {
        toast.error(t("startError"));
      } finally {
        setStartingContactId(null);
      }
    },
    [startingContactId, t, onConversationStarted],
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  // How many threads the clear action would actually take off the list.
  // Counts every visible thread, not just unread ones — clearing the
  // inbox empties it, so the button has work to do whenever anything
  // is listed.
  const clearableConversations = useMemo(
    () => conversations.filter((c) => !c.archived_at).length,
    [conversations],
  );

  /**
   * Clear the inbox: mark everything read AND archive it out of the
   * list. Nothing is deleted — the thread and its messages stay put,
   * and the next inbound message un-archives it automatically (see the
   * webhook's conversation update), so the history comes back with it.
   *
   * The `.is("archived_at", null)` filter scopes the statement to rows
   * worth touching; tenancy is enforced by RLS (`conversations_update`
   * → `is_account_member(account_id, 'agent')`), so this can never reach
   * another account's rows even though no account_id filter appears here.
   * Deliberately clears ALL visible threads, not just the ones passing
   * the current search/tab/tag filters — a "clear inbox" that silently
   * left rows behind a filter the user forgot was active would be worse
   * than useless.
   */
  const handleClearInbox = useCallback(async () => {
    setClearingInbox(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ unread_count: 0, archived_at: new Date().toISOString() })
        .is("archived_at", null);

      if (error) {
        console.error("Failed to clear inbox:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        toast.error(t("clearInboxError"));
        return;
      }

      onMarkAllRead?.();
      toast.success(t("clearInboxDone", { count: clearableConversations }));
    } finally {
      setClearingInbox(false);
    }
  }, [onMarkAllRead, t, clearableConversations]);

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        {/* Audience tabs — people vs groups. A segmented control rather
            than another dropdown: it's a two-way split the user flips
            constantly, so it earns permanent one-tap real estate where
            the status filter (five options, occasional use) does not. */}
        <div
          role="tablist"
          aria-label={t("audienceTabs")}
          className="flex rounded-lg bg-muted p-0.5"
        >
          {(
            [
              { value: "all", label: t("tabAll") },
              { value: "people", label: t("tabContacts") },
              { value: "groups", label: t("tabGroups") },
            ] as { value: InboxAudience; label: string }[]
          ).map((tab) => (
            <button
              key={tab.value}
              role="tab"
              aria-selected={audience === tab.value}
              onClick={() => setAudience(tab.value)}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                audience === tab.value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder={t("searchPlaceholder")}
              className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
            />
          </div>
          {/* Reach out first. Gated on the same role as sending, since
              that's what the thread exists to do. */}
          {canSendMessages && (
            <button
              onClick={() => setNewConversationOpen(true)}
              title={t("newConversation")}
              aria-label={t("newConversation")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Clear inbox — marks every unread thread as read. `ml-auto`
              pushes it to the far right of the filter row so it reads as
              an action rather than another filter. Only shown when there
              is something to clear and the role is allowed to write. */}
          {canSendMessages && clearableConversations > 0 && (
            <button
              onClick={handleClearInbox}
              disabled={clearingInbox}
              title={t("clearInbox")}
              className="ml-auto inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {clearingInbox ? (
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <CheckCheck className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{t("clearInbox")}</span>
            </button>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
              />
            ))}
          </div>
        )}

        {/* Saved contacts with no thread yet. Rendered below the
            conversations (and outside the empty-state branch) so it
            also shows when the search DID match threads — the person
            you want may be both. */}
        {canSendMessages && contactSuggestions.length > 0 && (
          <div className="border-t border-border">
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("contactSuggestions")}
            </p>
            {contactSuggestions.map((contact) => (
              <button
                key={contact.id}
                onClick={() => void handlePickContact(contact)}
                disabled={startingContactId !== null}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                  {contact.avatar_url ? (
                    <img
                      src={contact.avatar_url}
                      alt={contact.name || contact.phone}
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    (contact.name || contact.phone).charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {contact.name || contact.phone}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {startingContactId === contact.id
                      ? t("startingConversation")
                      : t("startConversationHint")}
                  </p>
                </div>
                {startingContactId === contact.id ? (
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                ) : (
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>

      <NewConversationDialog
        open={newConversationOpen}
        onOpenChange={setNewConversationOpen}
        onStarted={(conversationId) => onConversationStarted?.(conversationId)}
      />
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

/**
 * How many of the contact's tags render inline next to the name. The
 * row is ~320px shared with the timestamp; beyond two chips the name
 * itself truncates into uselessness, so the rest collapses to "+N"
 * (full list visible in the contact sidebar).
 */
const MAX_INLINE_TAGS = 2;

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const contactTags = contact?.tags ?? [];
  const inlineTags = contactTags.slice(0, MAX_INLINE_TAGS);
  const overflowTags = contactTags.length - inlineTags.length;

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : contact?.is_group ? (
          <Users className="h-5 w-5 text-muted-foreground" />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            {/* Contact tags, same chip treatment as the contact
                sidebar (`${color}20` wash + coloured text) so a tag
                reads identically in both places. Capped at two — the
                name keeps priority over the chips when space runs out
                (chips can shrink and truncate, the "+N" never does). */}
            {inlineTags.map((tag) => (
              <span
                key={tag.id}
                title={tag.name}
                className="inline-flex min-w-0 max-w-20 shrink items-center rounded-full px-1.5 py-px text-[10px] font-medium"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color,
                }}
              >
                <span className="truncate">{tag.name}</span>
              </span>
            ))}
            {overflowTags > 0 && (
              <span
                title={contactTags.map((tg) => tg.name).join(", ")}
                className="shrink-0 text-[10px] text-muted-foreground"
              >
                +{overflowTags}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
