import { describe, expect, it } from "vitest";
import { UNASSIGNED, itemValues, monthsBetween, type DealRow } from "./sales";

function deal(partial: Partial<DealRow>): DealRow {
  return {
    id: "d1",
    value: 0,
    status: "won",
    closed_at: null,
    assigned_to: null,
    source_id: null,
    stage_id: "s1",
    ...partial,
  };
}

describe("itemValues", () => {
  it("multiplies quantity by unit price", () => {
    const out = itemValues(
      deal({
        value: 3250,
        items: [
          { product_id: "p1", quantity: 2, unit_price: 1200, product: { id: "p1", name: "Quarto" } },
          { product_id: "p2", quantity: 1, unit_price: 850, product: { id: "p2", name: "Evento" } },
        ],
      }),
    );
    expect(out).toEqual([
      { productId: "p1", name: "Quarto", units: 2, value: 2400 },
      { productId: "p2", name: "Evento", units: 1, value: 850 },
    ]);
  });

  it("puts an item-less deal's whole value in the unassigned bucket", () => {
    const out = itemValues(deal({ value: 500, items: [] }));
    expect(out).toEqual([
      { productId: UNASSIGNED, name: "", units: 0, value: 500 },
    ]);
  });

  it("treats a missing items array the same as an empty one", () => {
    expect(itemValues(deal({ value: 500 }))[0].productId).toBe(UNASSIGNED);
  });

  // The reason the scaling exists: a manually discounted deal must not
  // leave the per-product chart adding up to more than the revenue
  // cards report.
  it("scales items down to a manually discounted deal value", () => {
    const out = itemValues(
      deal({
        value: 900,
        items: [
          { product_id: "p1", quantity: 1, unit_price: 600 },
          { product_id: "p2", quantity: 1, unit_price: 600 },
        ],
      }),
    );
    expect(out.map((i) => i.value)).toEqual([450, 450]);
    expect(out.reduce((s, i) => s + i.value, 0)).toBe(900);
  });

  it("scales items up when the deal was priced above its items", () => {
    const out = itemValues(
      deal({
        value: 1500,
        items: [
          { product_id: "p1", quantity: 1, unit_price: 750 },
          { product_id: "p2", quantity: 1, unit_price: 250 },
        ],
      }),
    );
    expect(out.reduce((s, i) => s + i.value, 0)).toBeCloseTo(1500, 6);
    // Proportions are preserved: 3:1 before, 3:1 after.
    expect(out[0].value / out[1].value).toBeCloseTo(3, 6);
  });

  it("leaves zero-priced items alone instead of dividing by zero", () => {
    const out = itemValues(
      deal({
        value: 400,
        items: [{ product_id: "p1", quantity: 2, unit_price: 0 }],
      }),
    );
    expect(out[0].value).toBe(0);
    expect(Number.isNaN(out[0].value)).toBe(false);
  });

  it("keeps string numerics from PostgREST numeric columns usable", () => {
    const out = itemValues(
      deal({
        value: "2400",
        items: [{ product_id: "p1", quantity: "2", unit_price: "1200" }],
      }),
    );
    expect(out[0].value).toBe(2400);
    expect(out[0].units).toBe(2);
  });
});

describe("monthsBetween", () => {
  const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

  it("returns the single month a whole-month period covers", () => {
    expect(monthsBetween(iso(2026, 8, 1), iso(2026, 9, 1))).toEqual([
      "2026-08-01",
    ]);
  });

  it("does not pull in the next month for an exclusive end boundary", () => {
    // Sep 1st 00:00 is the exclusive end of August — September has no
    // revenue in this period and must not contribute its goal.
    const out = monthsBetween(iso(2026, 8, 1), iso(2026, 9, 1));
    expect(out).not.toContain("2026-09-01");
  });

  it("spans every month a custom range touches", () => {
    expect(monthsBetween(iso(2026, 1, 15), iso(2026, 4, 2))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(monthsBetween(iso(2025, 12, 10), iso(2026, 2, 5))).toEqual([
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("returns an empty list for unparseable input", () => {
    expect(monthsBetween("not-a-date", "also-not")).toEqual([]);
  });
});
