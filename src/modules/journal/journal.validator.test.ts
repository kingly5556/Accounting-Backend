import { describe, expect, it } from "vitest";
import { assertBalanced, buildReversalLines, totals } from "./journal.validator.js";
import { assertTransition } from "./journal-status.js";

const line = (accountId: string, debit: bigint, credit: bigint) => ({ accountId, debit, credit });

describe("assertBalanced", () => {
  it("accepts a balanced two-line entry", () => {
    expect(() => assertBalanced([line("1300", 3_000_000n, 0n), line("2150", 0n, 3_000_000n)])).not.toThrow();
  });
  it("accepts a balanced multi-line entry", () => {
    expect(() => assertBalanced([line("a", 100n, 0n), line("b", 50n, 0n), line("c", 0n, 150n)])).not.toThrow();
  });
  it("rejects an unbalanced entry", () => {
    expect(() => assertBalanced([line("a", 100n, 0n), line("b", 0n, 99n)])).toThrow(/balance/i);
  });
  it("rejects a single line", () => {
    expect(() => assertBalanced([line("a", 100n, 0n)])).toThrow(/at least 2/i);
  });
  it("rejects no lines", () => {
    expect(() => assertBalanced([])).toThrow();
  });
  it("rejects a line with both debit and credit", () => {
    expect(() => assertBalanced([line("a", 100n, 100n), line("b", 0n, 0n)])).toThrow(/one side/i);
  });
  it("rejects a line with neither debit nor credit", () => {
    expect(() => assertBalanced([line("a", 0n, 0n), line("b", 0n, 0n)])).toThrow(/one side/i);
  });
  it("rejects negative amounts", () => {
    expect(() => assertBalanced([line("a", -100n, 0n), line("b", 0n, -100n)])).toThrow();
  });
  it("handles amounts beyond int32 exactly (more than 21.4 million THB)", () => {
    const big = 9_000_000_000_000n;
    expect(() => assertBalanced([line("a", big, 0n), line("b", 0n, big)])).not.toThrow();
    expect(() => assertBalanced([line("a", big, 0n), line("b", 0n, big - 1n)])).toThrow();
  });
});

describe("totals", () => {
  it("sums both sides as bigint", () => {
    expect(totals([line("a", 5n, 0n), line("b", 0n, 2n), line("c", 0n, 3n)])).toEqual({ debit: 5n, credit: 5n });
  });
});

describe("buildReversalLines", () => {
  const original = [line("1300", 3_000_000n, 0n), line("2150", 0n, 3_000_000n)];
  it("swaps debit and credit on every line", () => {
    expect(buildReversalLines(original)).toEqual([line("1300", 0n, 3_000_000n), line("2150", 3_000_000n, 0n)]);
  });
  it("original + reversal nets to zero on every account", () => {
    const all = [...original, ...buildReversalLines(original)];
    const net = new Map<string, bigint>();
    for (const l of all) net.set(l.accountId, (net.get(l.accountId) ?? 0n) + l.debit - l.credit);
    expect([...net.values()].every((v) => v === 0n)).toBe(true);
  });
  it("produces a balanced entry", () => {
    expect(() => assertBalanced(buildReversalLines(original))).not.toThrow();
  });
});

describe("assertTransition", () => {
  it("allows DRAFT -> POSTED and POSTED -> REVERSED", () => {
    expect(() => assertTransition("DRAFT", "POSTED")).not.toThrow();
    expect(() => assertTransition("POSTED", "REVERSED")).not.toThrow();
  });
  it("rejects everything else", () => {
    expect(() => assertTransition("DRAFT", "REVERSED")).toThrow();
    expect(() => assertTransition("POSTED", "DRAFT")).toThrow();
    expect(() => assertTransition("REVERSED", "POSTED")).toThrow();
    expect(() => assertTransition("REVERSED", "REVERSED")).toThrow();
  });
});
