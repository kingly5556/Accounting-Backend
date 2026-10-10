import { describe, expect, it } from "vitest";
import { buildClosingPlan } from "../period/year-end.js";
import { assertBalanced } from "../journal/journal.validator.js";
import { buildBalanceSheet, buildIncomeStatement, type AccountTotals } from "./statements.js";

const acc = (code: string, type: AccountTotals["type"], debit: bigint, credit: bigint): AccountTotals => ({
  id: code,
  code,
  name: `acct ${code}`,
  type,
  debit,
  credit,
});

// Capital 1,000,000; bought stock 400,000 on credit; sold for 300,000 cash at cost 120,000; rent 50,000.
const ledger = [
  acc("1110", "ASSET", 1_300_000n, 50_000n), // cash: +1,000,000 +300,000 -50,000
  acc("1300", "ASSET", 400_000n, 120_000n), // inventory
  acc("2150", "LIABILITY", 0n, 400_000n),
  acc("3100", "EQUITY", 0n, 1_000_000n),
  acc("4100", "REVENUE", 0n, 300_000n),
  acc("5100", "EXPENSE", 120_000n, 0n),
  acc("5300", "EXPENSE", 50_000n, 0n),
];

describe("buildIncomeStatement", () => {
  it("revenue - expenses = net income, each on its normal side", () => {
    const is = buildIncomeStatement(ledger);
    expect(is.totalRevenue).toBe(300_000n);
    expect(is.totalExpense).toBe(170_000n);
    expect(is.netIncome).toBe(130_000n);
    expect(is.revenues.map((r) => r.amount)).toEqual([300_000n]);
    expect(is.expenses.map((r) => r.code)).toEqual(["5100", "5300"]);
  });

  it("a loss is a negative net income", () => {
    expect(buildIncomeStatement([acc("4100", "REVENUE", 0n, 10n), acc("5300", "EXPENSE", 25n, 0n)]).netIncome).toBe(-15n);
  });

  it("hides accounts with a zero balance", () => {
    expect(buildIncomeStatement([acc("4100", "REVENUE", 50n, 50n)]).revenues).toEqual([]);
  });
});

describe("buildBalanceSheet", () => {
  it("assets = liabilities + equity (incl. unclosed net income) at any date", () => {
    const bs = buildBalanceSheet(ledger);
    expect(bs.totalAssets).toBe(1_250_000n + 280_000n); // 1,530,000
    expect(bs.totalLiabilities).toBe(400_000n);
    expect(bs.netIncomeToDate).toBe(130_000n);
    expect(bs.totalEquity).toBe(1_130_000n);
    expect(bs.balanced).toBe(true);
  });

  it("is also balanced when the books are not (so a bad ledger is visible, not hidden)", () => {
    expect(buildBalanceSheet([acc("1110", "ASSET", 100n, 0n), acc("3100", "EQUITY", 0n, 90n)]).balanced).toBe(false);
  });

  it("handles amounts above int32", () => {
    const big = 9_000_000_000_000n;
    expect(buildBalanceSheet([acc("1110", "ASSET", big, 0n), acc("3100", "EQUITY", 0n, big)]).balanced).toBe(true);
  });
});

describe("buildClosingPlan", () => {
  const retained = { id: "3200", code: "3200", name: "RE" };
  const closing = (rows: AccountTotals[]) =>
    buildClosingPlan(rows.filter((r) => r.type === "REVENUE" || r.type === "EXPENSE") as never, retained);

  it("profit: zeroes revenue and expenses, credits retained earnings", () => {
    const plan = closing(ledger);
    expect(plan.netIncome).toBe(130_000n);
    const dr = (c: string) => plan.lines.find((l) => l.code === c)!;
    expect(dr("4100").debit).toBe(300_000n); // revenue closed with a debit
    expect(dr("5100").credit).toBe(120_000n);
    expect(dr("5300").credit).toBe(50_000n);
    expect(dr("3200").credit).toBe(130_000n);
    assertBalanced(plan.lines);
  });

  it("loss: debits retained earnings", () => {
    const plan = closing([acc("4100", "REVENUE", 0n, 100n), acc("5300", "EXPENSE", 250n, 0n)]);
    expect(plan.netIncome).toBe(-150n);
    expect(plan.lines.find((l) => l.code === "3200")).toMatchObject({ debit: 150n, credit: 0n });
    assertBalanced(plan.lines);
  });

  it("break-even: no retained earnings line, still balanced", () => {
    const plan = closing([acc("4100", "REVENUE", 0n, 100n), acc("5300", "EXPENSE", 100n, 0n)]);
    expect(plan.lines.some((l) => l.code === "3200")).toBe(false);
    assertBalanced(plan.lines);
  });

  it("nothing to close -> no lines", () => {
    expect(closing([acc("4100", "REVENUE", 5n, 5n)]).lines).toEqual([]);
  });

  it("after closing, every revenue/expense account nets to zero", () => {
    const plan = closing(ledger);
    for (const r of ledger.filter((x) => x.type === "REVENUE" || x.type === "EXPENSE")) {
      const l = plan.lines.find((x) => x.code === r.code)!;
      expect(r.debit + l.debit - (r.credit + l.credit)).toBe(0n);
    }
  });
});
