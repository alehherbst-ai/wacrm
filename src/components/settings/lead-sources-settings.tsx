'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Radio, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { LeadSource } from '@/types';

const UNIQUE_VIOLATION = '23505';

const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];

/**
 * Lead sources card (migration 048) — the closed vocabulary behind the
 * dashboard's "Origem do lead" breakdown.
 *
 * Deleting a source is safe for the deals that used it: the FK is
 * ON DELETE SET NULL, so they survive as unattributed rather than
 * disappearing. The dialog says as much, because "delete" next to a
 * word that also names a chart slice reads more destructive than it is.
 */
export function LeadSourcesSettings() {
  const t = useTranslations('Settings.leadSources');
  const supabase = createClient();
  const { user, accountId, canEditSettings, loading: authLoading } = useAuth();

  const [sources, setSources] = useState<LeadSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toDelete, setToDelete] = useState<LeadSource | null>(null);

  const [newName, setNewName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[5].value);

  const fetchSources = useCallback(async () => {
    const { data, error } = await supabase
      .from('lead_sources')
      .select('*')
      .order('name');
    if (error) {
      console.error('Failed to load lead sources:', error.message);
      toast.error(t('loadFailed'));
      return;
    }
    setSources((data ?? []) as LeadSource[]);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      await fetchSources();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, fetchSources]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!user || !accountId) {
      toast.error(t('notLinked'));
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('lead_sources').insert({
      user_id: user.id,
      account_id: accountId,
      name,
      color,
    });
    setSaving(false);

    if (error) {
      toast.error(
        error.code === UNIQUE_VIOLATION ? t('duplicateName') : t('createFailed'),
      );
      return;
    }
    setNewName('');
    await fetchSources();
    toast.success(t('created'));
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    const { error } = await supabase
      .from('lead_sources')
      .delete()
      .eq('id', toDelete.id);
    setDeleting(false);
    if (error) {
      toast.error(t('deleteFailed'));
      return;
    }
    setSources((prev) => prev.filter((s) => s.id !== toDelete.id));
    setToDelete(null);
    toast.success(t('deleted'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Radio className="size-4 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sources.map((s) => (
                  <span
                    key={s.id}
                    className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium"
                    style={{
                      backgroundColor: `${s.color}20`,
                      color: s.color,
                      border: `1px solid ${s.color}40`,
                    }}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                    {canEditSettings && (
                      <button
                        type="button"
                        onClick={() => setToDelete(s)}
                        aria-label={t('deleteAria', { name: s.name })}
                        className="ml-0.5 rounded-full p-0.5 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {canEditSettings ? (
              <div className="flex flex-wrap items-center gap-2.5">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                  }}
                  placeholder={t('placeholder')}
                  maxLength={40}
                  disabled={saving}
                  className="min-w-[180px] flex-1"
                />
                <div className="flex gap-1.5">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setColor(c.value)}
                      aria-label={t('useColor', {
                        color: t(`colors.${c.name}` as Parameters<typeof t>[0]),
                      })}
                      aria-pressed={color === c.value}
                      title={t(`colors.${c.name}` as Parameters<typeof t>[0])}
                      className={cn(
                        'size-6 rounded-md transition-transform hover:scale-110',
                        color === c.value &&
                          'outline outline-2 outline-offset-2 outline-primary',
                      )}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCreate}
                  disabled={saving || !newName.trim()}
                >
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {t('add')}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
            )}
          </>
        )}
      </CardContent>

      <Dialog
        open={!!toDelete}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {toDelete ? t('deleteConfirm', { name: toDelete.name }) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setToDelete(null)}
              disabled={deleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteTitle')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
