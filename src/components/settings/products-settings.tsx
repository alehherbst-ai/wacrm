'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  Loader2,
  Package,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrencyExact } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { Product } from '@/types';

/** Postgres foreign-key violation — a product still referenced by a
 *  deal's line items (deal_products.product_id is ON DELETE RESTRICT). */
const FK_VIOLATION = '23503';
/** Unique violation — the account already has a product by that name. */
const UNIQUE_VIOLATION = '23505';

/**
 * Product catalogue card (migration 048).
 *
 * Products are what a deal is made of, so this list is the vocabulary
 * behind "Vendas por produto" on the sales dashboard. Archiving rather
 * than deleting is the primary action: a deleted product would take its
 * share of last quarter's revenue chart with it. The database refuses
 * such a delete outright; we translate that refusal into a nudge to
 * archive.
 */
export function ProductsSettings() {
  const t = useTranslations('Settings.products');
  const supabase = createClient();
  const { user, accountId, defaultCurrency, canEditSettings, loading: authLoading } =
    useAuth();

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');

  const fetchProducts = useCallback(async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('name');
    if (error) {
      console.error('Failed to load products:', error.message);
      toast.error(t('loadFailed'));
      return;
    }
    setProducts((data ?? []) as Product[]);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      await fetchProducts();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, fetchProducts]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!user || !accountId) {
      toast.error(t('notLinked'));
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('products').insert({
      user_id: user.id,
      account_id: accountId,
      name,
      default_price: parseFloat(newPrice) || 0,
    });
    setSaving(false);

    if (error) {
      toast.error(
        error.code === UNIQUE_VIOLATION ? t('duplicateName') : t('createFailed'),
      );
      return;
    }
    setNewName('');
    setNewPrice('');
    await fetchProducts();
    toast.success(t('created'));
  }

  async function toggleArchived(product: Product) {
    setBusyId(product.id);
    const { error } = await supabase
      .from('products')
      .update({ is_active: !product.is_active })
      .eq('id', product.id);
    setBusyId(null);
    if (error) {
      toast.error(t('updateFailed'));
      return;
    }
    setProducts((prev) =>
      prev.map((p) =>
        p.id === product.id ? { ...p, is_active: !p.is_active } : p,
      ),
    );
    toast.success(product.is_active ? t('archived') : t('restored'));
  }

  async function handleDelete(product: Product) {
    setBusyId(product.id);
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', product.id);
    setBusyId(null);

    if (error) {
      // The FK is doing exactly its job here — say so instead of
      // showing a generic failure the user can't act on.
      toast.error(
        error.code === FK_VIOLATION ? t('deleteInUse') : t('deleteFailed'),
      );
      return;
    }
    setProducts((prev) => prev.filter((p) => p.id !== product.id));
    toast.success(t('deleted'));
  }

  const active = products.filter((p) => p.is_active);
  const archived = products.filter((p) => !p.is_active);
  const visible = showArchived ? products : active;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Package className="size-4 text-primary" />
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
            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {visible.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <span
                      className={`flex-1 truncate ${
                        p.is_active ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {p.name}
                      {!p.is_active && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t('archivedBadge')}
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatCurrencyExact(p.default_price, defaultCurrency)}
                    </span>
                    {canEditSettings && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => toggleArchived(p)}
                          disabled={busyId === p.id}
                          aria-label={
                            p.is_active
                              ? t('archiveAria', { name: p.name })
                              : t('restoreAria', { name: p.name })
                          }
                          title={p.is_active ? t('archive') : t('restore')}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          {p.is_active ? (
                            <Archive className="size-3.5" />
                          ) : (
                            <ArchiveRestore className="size-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(p)}
                          disabled={busyId === p.id}
                          aria-label={t('deleteAria', { name: p.name })}
                          title={t('delete')}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400 disabled:opacity-50"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {archived.length > 0 && (
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="text-xs text-primary hover:underline"
              >
                {showArchived
                  ? t('hideArchived')
                  : t('showArchived', { count: archived.length })}
              </button>
            )}

            {canEditSettings ? (
              <div className="flex flex-wrap items-end gap-2.5">
                <div className="grid min-w-[180px] flex-1 gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('nameLabel')}
                  </Label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                    }}
                    placeholder={t('namePlaceholder')}
                    maxLength={80}
                    disabled={saving}
                  />
                </div>
                <div className="grid w-32 gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('priceLabel')}
                  </Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                    }}
                    placeholder="0,00"
                    disabled={saving}
                  />
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
    </Card>
  );
}
