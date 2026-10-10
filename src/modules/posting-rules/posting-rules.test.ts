import { describe, expect, it } from "vitest";
import { assertBalanced } from "../journal/journal.validator.js";
import { planPosting, postingRequestSchema } from "./posting-rules.js";

const when = "2026-10-10T08:00:00.000Z";

function plan(input: unknown) {
  return planPosting(postingRequestSchema.parse(input));
}

// Plans use account codes; the validator only needs the amounts.
const balanced = (p: ReturnType<typeof plan>) =>
  assertBalanced(p.lines.map((l) => ({ accountId: l.accountCode, debit: l.debit, credit: l.credit })));

describe("GOODS_RECEIVED", () => {
  it("60 x 500 THB -> Dr 1300 / Cr 2150 = 3,000,000 satang", () => {
    const p = plan({
      topic: "GOODS_RECEIVED",
      payload: { version: 1, occurredAt: when, goodsReceiptId: "gr1", poId: "po1", amountSatang: "3000000" },
    });
    expect(p.sourceType).toBe("GOODS_RECEIPT");
    expect(p.sourceId).toBe("gr1");
    expect(p.lines).toEqual([
      { accountCode: "1300", debit: 3_000_000n, credit: 0n },
      { accountCode: "2150", debit: 0n, credit: 3_000_000n },
    ]);
    expect(p.sourceRef).toMatchObject({ poId: "po1" });
    balanced(p);
  });
});

describe("STOCK_ADJUSTED", () => {
  const payload = {
    version: 1,
    occurredAt: when,
    movementId: "mv1",
    productId: "p1",
    quantity: 4,
    amountSatang: 6000,
  };
  it("decrease -> Dr 5200 / Cr 1300", () => {
    const p = plan({ topic: "STOCK_ADJUSTED", payload: { ...payload, direction: "DECREASE" } });
    expect(p.lines).toEqual([
      { accountCode: "5200", debit: 6000n, credit: 0n },
      { accountCode: "1300", debit: 0n, credit: 6000n },
    ]);
    balanced(p);
  });
  it("increase -> Dr 1300 / Cr 5200", () => {
    const p = plan({ topic: "STOCK_ADJUSTED", payload: { ...payload, direction: "INCREASE" } });
    expect(p.lines).toEqual([
      { accountCode: "1300", debit: 6000n, credit: 0n },
      { accountCode: "5200", debit: 0n, credit: 6000n },
    ]);
    balanced(p);
  });
  it("keys on the movement id, not on the free-text reason", () => {
    const a = plan({ topic: "STOCK_ADJUSTED", payload: { ...payload, direction: "DECREASE", reason: "count", movementId: "mv1" } });
    const b = plan({ topic: "STOCK_ADJUSTED", payload: { ...payload, direction: "DECREASE", reason: "count", movementId: "mv2" } });
    expect(a.sourceId).not.toBe(b.sourceId);
  });
});

describe("OPENING_BALANCE", () => {
  it("Dr 1300 / Cr 3200, keyed by the cut-over date", () => {
    const p = plan({
      topic: "OPENING_BALANCE",
      payload: { version: 1, occurredAt: when, asOf: "2026-10-10", amountSatang: "100000" },
    });
    expect(p.sourceId).toBe("2026-10-10");
    expect(p.lines.map((l) => l.accountCode)).toEqual(["1300", "3200"]);
    balanced(p);
  });
});

describe("validation", () => {
  it("rejects a zero amount", () => {
    expect(() =>
      plan({ topic: "GOODS_RECEIVED", payload: { version: 1, occurredAt: when, goodsReceiptId: "g", poId: "p", amountSatang: 0 } })
    ).toThrow();
  });
  it("rejects a negative amount", () => {
    expect(() =>
      plan({ topic: "GOODS_RECEIVED", payload: { version: 1, occurredAt: when, goodsReceiptId: "g", poId: "p", amountSatang: -5 } })
    ).toThrow();
  });
  it("rejects an unknown topic and an unknown schema version", () => {
    expect(() => plan({ topic: "NOPE", payload: {} })).toThrow();
    expect(() =>
      plan({ topic: "GOODS_RECEIVED", payload: { version: 2, occurredAt: when, goodsReceiptId: "g", poId: "p", amountSatang: 1 } })
    ).toThrow();
  });
  it("accepts amounts above int32", () => {
    const p = plan({
      topic: "GOODS_RECEIVED",
      payload: { version: 1, occurredAt: when, goodsReceiptId: "g", poId: "p", amountSatang: "9000000000000" },
    });
    expect(p.lines[0].debit).toBe(9_000_000_000_000n);
  });
});
