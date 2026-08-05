import { describe, it, expect } from "vitest";
import { bucketFor, groupByBucket, isOverdue } from "./buckets";
import type { Activity } from "@/types";

// A Wednesday, mid-afternoon, so "later today" and "earlier today" both
// exist and the day boundaries are unambiguous.
const NOW = new Date("2026-08-05T15:00:00");

function at(iso: string, completed = false): Activity {
  return {
    id: iso,
    account_id: "a",
    user_id: "u",
    title: "t",
    due_at: new Date(iso).toISOString(),
    completed_at: completed ? new Date("2026-08-05T10:00:00").toISOString() : null,
    created_at: "",
    updated_at: "",
  };
}

describe("bucketFor", () => {
  /**
   * Overdue outranks every other bucket. A task due at 09:00 when it is
   * already 15:00 the same day is late — filing it under "today" would
   * hide the one state the board exists to make loud.
   */
  it("calls an earlier-today deadline overdue, not today", () => {
    expect(bucketFor(at("2026-08-05T09:00:00"), NOW)).toBe("overdue");
  });

  it("keeps a later-today deadline in today", () => {
    expect(bucketFor(at("2026-08-05T17:00:00"), NOW)).toBe("today");
  });

  it("treats yesterday as overdue", () => {
    expect(bucketFor(at("2026-08-04T23:59:00"), NOW)).toBe("overdue");
  });

  /**
   * Done is done — a task finished long ago must never be painted red.
   * `bucketFor` is only meaningful for open work (the board has no
   * "done" column), so the guarantee that matters is this one; where
   * a completed row would nominally file is covered by groupByBucket
   * dropping it entirely.
   */
  it("never reports a completed activity as overdue", () => {
    expect(isOverdue(at("2026-07-01T09:00:00", true), NOW)).toBe(false);
  });

  it("puts tomorrow in its own column", () => {
    expect(bucketFor(at("2026-08-06T08:00:00"), NOW)).toBe("tomorrow");
    expect(bucketFor(at("2026-08-06T23:59:00"), NOW)).toBe("tomorrow");
  });

  /**
   * Day boundaries are local midnight, not "24 hours from now" — 23:50
   * today and 00:10 tomorrow are different days to a person reading a
   * deadline, even though they are 20 minutes apart.
   */
  it("splits on local midnight rather than a rolling 24h window", () => {
    expect(bucketFor(at("2026-08-05T23:50:00"), NOW)).toBe("today");
    expect(bucketFor(at("2026-08-06T00:10:00"), NOW)).toBe("tomorrow");
  });

  /** "Next 3 days" must not overlap tomorrow, or a task lists twice. */
  it("starts next3 the day after tomorrow", () => {
    expect(bucketFor(at("2026-08-07T09:00:00"), NOW)).toBe("next3");
    expect(bucketFor(at("2026-08-08T23:00:00"), NOW)).toBe("next3");
  });

  it("pushes anything past that window to later", () => {
    expect(bucketFor(at("2026-08-09T00:00:00"), NOW)).toBe("later");
    expect(bucketFor(at("2026-12-01T09:00:00"), NOW)).toBe("later");
  });
});

describe("groupByBucket", () => {
  it("files every activity into exactly one bucket", () => {
    const items = [
      at("2026-08-04T09:00:00"),
      at("2026-08-05T17:00:00"),
      at("2026-08-06T09:00:00"),
      at("2026-08-07T09:00:00"),
      at("2026-12-01T09:00:00"),
    ];
    const grouped = groupByBucket(items, NOW);
    const total = Object.values(grouped).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(items.length);
    expect(grouped.overdue).toHaveLength(1);
    expect(grouped.today).toHaveLength(1);
    expect(grouped.tomorrow).toHaveLength(1);
    expect(grouped.next3).toHaveLength(1);
    expect(grouped.later).toHaveLength(1);
  });

  it("orders each column by deadline, soonest first", () => {
    const grouped = groupByBucket(
      [at("2026-08-05T20:00:00"), at("2026-08-05T16:00:00")],
      NOW,
    );
    expect(grouped.today.map((a) => a.due_at)).toEqual([
      new Date("2026-08-05T16:00:00").toISOString(),
      new Date("2026-08-05T20:00:00").toISOString(),
    ]);
  });

  it("returns every bucket even when empty", () => {
    const grouped = groupByBucket([], NOW);
    expect(Object.keys(grouped).sort()).toEqual(
      ["later", "next3", "overdue", "today", "tomorrow"].sort(),
    );
  });

  /**
   * The board lists outstanding work. Leaving finished tasks in would
   * park a completed item under "Overdue" in red forever, which is the
   * opposite of what finishing it should do.
   */
  it("drops completed activities entirely", () => {
    const grouped = groupByBucket(
      [at("2026-08-04T09:00:00", true), at("2026-08-04T10:00:00")],
      NOW,
    );
    expect(grouped.overdue).toHaveLength(1);
    expect(
      Object.values(grouped).reduce((n, list) => n + list.length, 0),
    ).toBe(1);
  });
});

describe("isOverdue", () => {
  it("is true only for open, past-deadline work", () => {
    expect(isOverdue(at("2026-08-04T09:00:00"), NOW)).toBe(true);
    expect(isOverdue(at("2026-08-05T17:00:00"), NOW)).toBe(false);
    expect(isOverdue(at("2026-08-04T09:00:00", true), NOW)).toBe(false);
  });
});
