import { describe, it, expect } from "vitest";
import { describePhoneInput } from "./new-conversation-dialog";

/**
 * Drives the live echo under the number field — the thing that tells
 * the agent whether what they typed matched the mold, before the
 * round-trip turns a missing country code into a confusing "this
 * number has no WhatsApp".
 */
describe("describePhoneInput", () => {
  it("splits a Brazilian mobile into country, area and subscriber", () => {
    expect(describePhoneInput("5548912345678")).toEqual({
      digits: "5548912345678",
      parts: { country: "55", area: "48", subscriber: "912345678" },
      plausible: true,
    });
  });

  it("splits a Brazilian landline (8-digit subscriber)", () => {
    expect(describePhoneInput("554832105678").parts).toEqual({
      country: "55",
      area: "48",
      subscriber: "32105678",
    });
  });

  /**
   * The mold says digits, but people paste from contact lists. Anything
   * non-numeric is stripped rather than rejected — the field would
   * otherwise punish the most common way of getting a number.
   */
  it("strips formatting people actually paste", () => {
    expect(describePhoneInput("+55 (48) 91234-5678").digits).toBe(
      "5548912345678",
    );
    expect(describePhoneInput("+55 (48) 91234-5678").parts).toEqual({
      country: "55",
      area: "48",
      subscriber: "912345678",
    });
  });

  /**
   * The single most common mistake this echo exists to catch: typing
   * the number the way you'd dial it locally, with no country code.
   * 11 digits is a plausible-looking length, so it must NOT be labelled
   * as a parsed Brazilian number.
   */
  it("does not invent a split for a number missing its country code", () => {
    const result = describePhoneInput("48912345678");
    expect(result.parts).toBeNull();
    expect(result.digits).toHaveLength(11);
  });

  it("reports no split for a non-Brazilian number rather than guessing", () => {
    // Guessing where the area code ends varies by country; the echo
    // falls back to a digit count instead of asserting something wrong.
    expect(describePhoneInput("14155551212").parts).toBeNull();
    expect(describePhoneInput("14155551212").plausible).toBe(true);
  });

  it("flags a number still too short to be real", () => {
    expect(describePhoneInput("5548").plausible).toBe(false);
    expect(describePhoneInput("554891234").plausible).toBe(false);
  });

  it("flags a number longer than E.164 allows", () => {
    expect(describePhoneInput("1234567890123456").plausible).toBe(false);
  });

  it("handles an empty field without throwing", () => {
    expect(describePhoneInput("")).toEqual({
      digits: "",
      parts: null,
      plausible: false,
    });
  });
});
