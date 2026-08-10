"use client";

import Link from "next/link";
import { Package, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { Product } from "@/types";
import { formatCurrencyExact } from "@/lib/currency";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * One editable line. `key` is a client-side identity so React can keep
 * inputs stable while rows are added and removed — the database row id
 * is deliberately not carried here, because saving replaces the whole
 * set rather than diffing it (see `syncDealProducts`).
 */
export interface DealItemDraft {
  key: string;
  product_id: string;
  /** Kept as strings while editing so a half-typed "1." doesn't get
   *  coerced to 1 under the user's cursor. Parsed on save. */
  quantity: string;
  unit_price: string;
}

export function draftKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Sum of the line items, in account currency. Non-numeric input
 *  counts as zero rather than NaN-poisoning the total. */
export function itemsTotal(items: DealItemDraft[]): number {
  return items.reduce((sum, it) => {
    const qty = parseFloat(it.quantity);
    const price = parseFloat(it.unit_price);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return sum;
    return sum + qty * price;
  }, 0);
}

interface DealProductsEditorProps {
  items: DealItemDraft[];
  onChange: (items: DealItemDraft[]) => void;
  /** Catalogue for the picker. Archived products are filtered out here,
   *  except one still referenced by an existing line. */
  products: Product[];
  currency: string;
  disabled?: boolean;
}

export function DealProductsEditor({
  items,
  onChange,
  products,
  currency,
  disabled = false,
}: DealProductsEditorProps) {
  const t = useTranslations("Pipelines.products");

  const byId = new Map(products.map((p) => [p.id, p]));
  const selectedIds = new Set(items.map((i) => i.product_id).filter(Boolean));

  function update(key: string, patch: Partial<DealItemDraft>) {
    onChange(items.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function addRow() {
    // Preselect the first product nothing points at yet — the common
    // case is adding a different product, and the unique index on
    // (deal_id, product_id) would reject a duplicate anyway.
    const next = products.find((p) => p.is_active && !selectedIds.has(p.id));
    onChange([
      ...items,
      {
        key: draftKey(),
        product_id: next?.id ?? "",
        quantity: "1",
        unit_price: next ? String(next.default_price ?? 0) : "0",
      },
    ]);
  }

  function removeRow(key: string) {
    onChange(items.filter((it) => it.key !== key));
  }

  /** Selecting a product pulls its catalogue price in — but only over
   *  an untouched row, so re-picking doesn't wipe a negotiated price
   *  the user already typed. */
  function pickProduct(key: string, productId: string) {
    const row = items.find((it) => it.key === key);
    const previous = row ? byId.get(row.product_id) : undefined;
    const priceUntouched =
      !row ||
      row.unit_price === "" ||
      row.unit_price === "0" ||
      (previous != null && row.unit_price === String(previous.default_price));

    const picked = byId.get(productId);
    update(key, {
      product_id: productId,
      ...(priceUntouched && picked
        ? { unit_price: String(picked.default_price ?? 0) }
        : {}),
    });
  }

  const total = itemsTotal(items);
  const hasCatalogue = products.some((p) => p.is_active);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-muted-foreground">{t("label")}</Label>
        {items.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("total")}{" "}
            <span className="font-medium text-foreground">
              {formatCurrencyExact(total, currency)}
            </span>
          </span>
        )}
      </div>

      {!hasCatalogue ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("emptyCatalogue")}{" "}
          <Link
            href="/settings?tab=deals"
            className="text-primary hover:underline"
          >
            {t("emptyCatalogueLink")}
          </Link>
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const product = byId.get(item.product_id);
            const qty = parseFloat(item.quantity);
            const price = parseFloat(item.unit_price);
            const subtotal =
              Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;

            return (
              <div
                key={item.key}
                className="rounded-lg border border-border bg-muted/40 p-2"
              >
                <div className="flex items-center gap-2">
                  <select
                    value={item.product_id}
                    disabled={disabled}
                    onChange={(e) => pickProduct(item.key, e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
                  >
                    <option value="">{t("selectProduct")}</option>
                    {products
                      // Archived products stay selectable only where a
                      // line already points at them, so opening an old
                      // deal doesn't silently blank its item.
                      .filter(
                        (p) => p.is_active || p.id === item.product_id,
                      )
                      .map((p) => (
                        <option
                          key={p.id}
                          value={p.id}
                          disabled={
                            p.id !== item.product_id && selectedIds.has(p.id)
                          }
                        >
                          {p.name}
                          {p.is_active ? "" : ` ${t("archivedSuffix")}`}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeRow(item.key)}
                    disabled={disabled}
                    aria-label={t("removeItem", {
                      name: product?.name ?? "",
                    })}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-[70px_1fr_auto] items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="decimal"
                    value={item.quantity}
                    disabled={disabled}
                    aria-label={t("quantity")}
                    onChange={(e) =>
                      update(item.key, { quantity: e.target.value })
                    }
                    className="h-8 border-border bg-muted text-sm text-foreground"
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={item.unit_price}
                    disabled={disabled}
                    aria-label={t("unitPrice")}
                    onChange={(e) =>
                      update(item.key, { unit_price: e.target.value })
                    }
                    className="h-8 border-border bg-muted text-sm text-foreground"
                  />
                  <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                    {formatCurrencyExact(subtotal, currency)}
                  </span>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={addRow}
            disabled={disabled}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:opacity-50"
          >
            {items.length === 0 ? (
              <Package className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {t("addItem")}
          </button>
        </div>
      )}
    </div>
  );
}
