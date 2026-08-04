import { describe, it, expect } from "vitest";
import { rowsEqual } from "./rows-equal";

describe("rowsEqual", () => {
  it("treats distinct objects with the same data as equal", () => {
    const a = [{ id: "1", text: "oi" }];
    const b = [{ id: "1", text: "oi" }];
    expect(a).not.toBe(b);
    expect(rowsEqual(a, b)).toBe(true);
  });

  /**
   * The two sides come from different places — a REST `select()` and a
   * realtime `payload.new` carry the same columns but not necessarily
   * in the same order. A plain JSON.stringify would call these
   * different and every safety-net refetch would repaint the screen,
   * which is the bug this exists to prevent.
   */
  it("ignores key order", () => {
    expect(
      rowsEqual([{ id: "1", status: "sent" }], [{ status: "sent", id: "1" }]),
    ).toBe(true);
  });

  it("ignores key order in nested objects", () => {
    expect(
      rowsEqual(
        [{ id: "1", contact: { name: "Ana", phone: "5548" } }],
        [{ id: "1", contact: { phone: "5548", name: "Ana" } }],
      ),
    ).toBe(true);
  });

  it("detects a changed field", () => {
    expect(
      rowsEqual([{ id: "1", status: "sent" }], [{ id: "1", status: "read" }]),
    ).toBe(false);
  });

  it("detects an added or removed row", () => {
    expect(rowsEqual([{ id: "1" }], [{ id: "1" }, { id: "2" }])).toBe(false);
    expect(rowsEqual([{ id: "1" }, { id: "2" }], [{ id: "1" }])).toBe(false);
  });

  it("respects array order (a reordered inbox is a real change)", () => {
    expect(rowsEqual([{ id: "1" }, { id: "2" }], [{ id: "2" }, { id: "1" }])).toBe(
      false,
    );
  });

  it("distinguishes null from an absent value", () => {
    expect(rowsEqual([{ id: "1", media_url: null }], [{ id: "1" }])).toBe(false);
  });

  it("handles empty lists", () => {
    expect(rowsEqual([], [])).toBe(true);
    expect(rowsEqual([], [{ id: "1" }])).toBe(false);
  });
});
