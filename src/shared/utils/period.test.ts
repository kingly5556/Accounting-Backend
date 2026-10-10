import { describe, expect, it } from "vitest";
import { isValidPeriod, periodOf, startOfNextPeriod, startOfPeriod } from "./period.js";

describe("periodOf (Asia/Bangkok)", () => {
  it("puts 2026-10-31T17:30Z (1 Nov 00:30 Bangkok) in 2026-11", () => {
    expect(periodOf(new Date("2026-10-31T17:30:00Z"))).toBe("2026-11");
  });
  it("keeps 2026-10-31T16:59Z (31 Oct 23:59 Bangkok) in 2026-10", () => {
    expect(periodOf(new Date("2026-10-31T16:59:00Z"))).toBe("2026-10");
  });
  it("rolls the year over", () => {
    expect(periodOf(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01");
  });
});

describe("period boundaries", () => {
  it("startOfNextPeriod is 00:00 Bangkok on the 1st", () => {
    expect(startOfNextPeriod("2026-10").toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(startOfNextPeriod("2026-12").toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });
  it("startOfPeriod / periodOf round-trip", () => {
    expect(periodOf(startOfPeriod("2026-02"))).toBe("2026-02");
  });
  it("validates format", () => {
    expect(isValidPeriod("2026-10")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("26-10")).toBe(false);
  });
});
