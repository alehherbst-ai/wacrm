"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import type {
  Contact,
  Deal,
  ContactNote,
  Tag,
  Pipeline,
  PipelineStage,
} from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DealForm } from "@/components/pipelines/deal-form";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
  /**
   * Fired after a tag is added or removed here. The conversation list
   * shows those tags next to the name, but realtime only carries
   * `messages` and `conversations` — a write to `contact_tags` reaches
   * no subscriber. Without this the chip would sit invisible until the
   * 30s safety-net refetch happened to run.
   */
  onTagsChanged?: () => void;
}

export function ContactSidebar({ contact, onTagsChanged }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId, canSendMessages } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // All tags on the account — the picker's source. Loaded once, not per
  // contact, so opening the menu is instant.
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [pendingTagId, setPendingTagId] = useState<string | null>(null);

  // Pipelines + stages drive the "new deal" flow: the sidebar has to ask
  // WHICH pipeline (a contact can hold deals in several), which the board's
  // DealForm never needs to since it's already scoped to one.
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [dealPipelineId, setDealPipelineId] = useState<string | null>(null);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*), pipeline:pipelines(id, name)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  // Account-wide reference data (tags, pipelines, stages) — independent of
  // which contact is selected, so it loads once.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [tagsRes, pipesRes, stagesRes] = await Promise.all([
        supabase.from("tags").select("*").order("name"),
        supabase.from("pipelines").select("*").order("name"),
        supabase.from("pipeline_stages").select("*").order("position"),
      ]);
      if (cancelled) return;
      setAllTags((tagsRes.data as Tag[]) ?? []);
      setPipelines((pipesRes.data as Pipeline[]) ?? []);
      setStages((stagesRes.data as PipelineStage[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const tagIdsOnContact = useMemo(
    () => new Set(tags.map((t) => t.id)),
    [tags],
  );

  /**
   * Add or remove a tag on the open conversation's contact.
   *
   * Goes through the API route (not a direct table write) because
   * `POST /api/contacts/[id]/tags` also fires the `tag_added` automation
   * trigger — tagging from the inbox has to behave exactly like tagging
   * from the Contacts page, or automations would silently miss the ones
   * applied mid-conversation.
   */
  const handleToggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact) return;
      const isOn = tagIdsOnContact.has(tag.id);
      setPendingTagId(tag.id);
      try {
        if (isOn) {
          await deleteContactTag(contact.id, tag.id);
          setTags((prev) => prev.filter((t) => t.id !== tag.id));
        } else {
          await addContactTag(contact.id, tag.id);
          // The row id is only needed as a React key; the refetch below
          // replaces this optimistic entry with the real one.
          setTags((prev) => [...prev, { ...tag, contact_tag_id: `tmp-${tag.id}` }]);
          void fetchContactData();
        }
        // Let the inbox list pick the change up — it renders these same
        // tags beside the conversation name.
        onTagsChanged?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : tSidebar("tagUpdateError"),
        );
      } finally {
        setPendingTagId(null);
      }
    },
    [contact, tagIdsOnContact, fetchContactData, onTagsChanged, tSidebar],
  );

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  const stagesForDealPipeline = useMemo(
    () => stages.filter((s) => s.pipeline_id === dealPipelineId),
    [stages, dealPipelineId],
  );

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      {/* `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this panel grows to fit tags,
          deals and every note instead of shrinking to the space left
          over — the overflow is then clipped by the inbox's
          overflow-hidden with nothing to scroll (the same trap as the
          conversation list, issue #229). That's why the panel simply
          cut off partway down the notes.

          `no-scrollbar` hides the bar itself, not the scrolling: wheel,
          trackpad, touch and keyboard all still work. Deliberate at
          this width — a permanent gutter next to a 280px column is
          most of what makes the panel feel cramped. */}
      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                {tSidebar("tags")}
              </div>
              {canSendMessages && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title={tSidebar("addTag")}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="max-h-64 w-56 overflow-y-auto border-border bg-popover"
                  >
                    {/* DropdownMenuGroup is REQUIRED around the label:
                        DropdownMenuLabel is base-ui's Menu.GroupLabel and
                        throws at render without a Menu.Group ancestor,
                        which crashes the whole page rather than just the
                        menu. Same trap documented in flow-builder.tsx. */}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-xs text-muted-foreground">
                        {tSidebar("addTag")}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {allTags.length === 0 ? (
                        <div className="px-2 py-3 text-xs text-muted-foreground">
                          {tSidebar("noTagsAvailable")}
                        </div>
                      ) : (
                        allTags.map((tag) => {
                          const active = tagIdsOnContact.has(tag.id);
                          return (
                            <DropdownMenuItem
                              key={tag.id}
                              disabled={pendingTagId === tag.id}
                              // base-ui closes on click by default; keeping
                              // it open lets several tags be applied in one
                              // pass. (`onSelect` is Radix's API, not this
                              // library's — it would silently never fire.)
                              closeOnClick={false}
                              onClick={() => void handleToggleTag(tag)}
                              className="text-sm text-popover-foreground"
                            >
                              <span className="flex flex-1 items-center gap-2">
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: tag.color }}
                                />
                                <span className="truncate">{tag.name}</span>
                              </span>
                              {active && <Check className="h-3.5 w-3.5 text-primary" />}
                            </DropdownMenuItem>
                          );
                        })
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    {canSendMessages && (
                      <button
                        onClick={() => void handleToggleTag(tag)}
                        disabled={pendingTagId === tag.id}
                        title={tSidebar("removeTag")}
                        className="opacity-60 hover:opacity-100 disabled:opacity-30"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Deals */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <DollarSign className="h-3 w-3" />
                {tSidebar("deals")}
              </div>
              {canSendMessages && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title={tSidebar("newDeal")}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="max-h-64 w-56 overflow-y-auto border-border bg-popover"
                  >
                    {/* Which pipeline the new deal belongs to. A contact
                        can hold deals in several at once, so this is a
                        real choice, not a default. */}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-xs text-muted-foreground">
                        {tSidebar("newDealInPipeline")}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {pipelines.length === 0 ? (
                        <div className="px-2 py-3 text-xs text-muted-foreground">
                          {tSidebar("noPipelines")}
                        </div>
                      ) : (
                        pipelines.map((p) => (
                          <DropdownMenuItem
                            key={p.id}
                            onClick={() => setDealPipelineId(p.id)}
                            className="text-sm text-popover-foreground"
                          >
                            <span className="truncate">{p.name}</span>
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                    {/* Which pipeline this deal sits in — only meaningful
                        once a contact has deals in more than one. */}
                    {deal.pipeline?.name && (
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {deal.pipeline.name}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* New-deal sheet. Mounted only once a pipeline is picked so its
          `stages` prop is never an empty list. */}
      {dealPipelineId && (
        <DealForm
          open
          onOpenChange={(next) => {
            if (!next) setDealPipelineId(null);
          }}
          pipelineId={dealPipelineId}
          stages={stagesForDealPipeline}
          defaultContactId={contact.id}
          onSaved={() => {
            setDealPipelineId(null);
            void fetchContactData();
          }}
        />
      )}
    </div>
  );
}
