import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkNumber } from "./uazapi-api";

/**
 * `checkNumber` is the gate the whole "start a conversation" flow rests
 * on: say yes to a number that isn't reachable and the app writes a
 * permanent contact plus a dead thread. These cover the shapes the
 * provider can hand back, since a 200 with an unhelpful body is far
 * likelier than a transport error.
 */

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });

beforeEach(() => {
  process.env.UAZAPI_BASE_URL = "https://example.uazapi.test";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkNumber", () => {
  it("accepts a registered number and returns WhatsApp's own JID", async () => {
    vi.stubGlobal(
      "fetch",
      ok([
        {
          query: "554896274914",
          jid: "554896274914@s.whatsapp.net",
          isInWhatsapp: true,
          verifiedName: "Ana",
        },
      ]),
    );

    const result = await checkNumber({
      instanceToken: "t",
      number: "554896274914",
    });
    expect(result).toEqual({
      isInWhatsapp: true,
      jid: "554896274914@s.whatsapp.net",
      verifiedName: "Ana",
    });
  });

  /**
   * WhatsApp canonicalises numbers — Brazilian mobiles gained a 9th
   * digit and humans still type both forms. The caller keys the contact
   * off the returned JID, not the typed digits, so a number that comes
   * back different must survive that way.
   */
  it("returns the canonical JID even when it differs from what was typed", async () => {
    vi.stubGlobal(
      "fetch",
      ok([
        {
          query: "55489627491",
          jid: "554896274914@s.whatsapp.net",
          isInWhatsapp: true,
        },
      ]),
    );

    const result = await checkNumber({
      instanceToken: "t",
      number: "55489627491",
    });
    expect(result.jid).toBe("554896274914@s.whatsapp.net");
  });

  it("rejects a number the provider says is not on WhatsApp", async () => {
    vi.stubGlobal(
      "fetch",
      ok([{ query: "5548999999999", isInWhatsapp: false }]),
    );

    const result = await checkNumber({
      instanceToken: "t",
      number: "5548999999999",
    });
    expect(result.isInWhatsapp).toBe(false);
    expect(result.jid).toBeNull();
  });

  /**
   * `isInWhatsapp: true` with no JID is unusable — there is nothing to
   * address. Treated as a rejection rather than passed through, so the
   * caller can't create a contact with an empty phone.
   */
  it("rejects a positive answer that carries no JID", async () => {
    vi.stubGlobal("fetch", ok([{ isInWhatsapp: true }]));

    const result = await checkNumber({ instanceToken: "t", number: "1" });
    expect(result.isInWhatsapp).toBe(false);
  });

  it("treats an empty or non-array body as not found", async () => {
    vi.stubGlobal("fetch", ok([]));
    expect(
      (await checkNumber({ instanceToken: "t", number: "1" })).isInWhatsapp,
    ).toBe(false);

    vi.stubGlobal("fetch", ok(null));
    expect(
      (await checkNumber({ instanceToken: "t", number: "1" })).isInWhatsapp,
    ).toBe(false);
  });

  it("normalises a missing verified name to null rather than empty string", async () => {
    vi.stubGlobal(
      "fetch",
      ok([{ jid: "1@s.whatsapp.net", isInWhatsapp: true, verifiedName: "" }]),
    );

    const result = await checkNumber({ instanceToken: "t", number: "1" });
    expect(result.verifiedName).toBeNull();
  });

  it("throws on a provider error instead of reporting 'not on WhatsApp'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "Invalid token." }),
      }),
    );

    await expect(
      checkNumber({ instanceToken: "bad", number: "1" }),
    ).rejects.toThrow("Invalid token.");
  });
});
