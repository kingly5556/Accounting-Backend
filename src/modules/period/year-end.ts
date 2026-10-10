import type { LineAmounts } from "../journal/journal.validator.js";

// Identity of the year-end closing entry. The (module, type, id) triple is unique in the
// journal, so a year can be closed only once, and reports can recognise and skip it.
export const YEAR_END_MODULE = "accounting";
export const YEAR_END_TYPE = "YEAR_END_CLOSE";

export type ClosingInput = {
  id: string;
  code: string;
  name: string;
  type: "REVENUE" | "EXPENSE";
  debit: bigint;
  credit: bigint;
};

export type ClosingPlan = {
  lines: (LineAmounts & { code: string; name: string })[];
  netIncome: bigint; // positive = profit, negative = loss
};

// Pure: turns revenue/expense balances into the year-end closing entry. Every revenue and
// expense account is brought to zero and the difference lands in retained earnings:
//   revenue with a credit balance  -> Dr revenue          expense with a debit balance -> Cr expense
//   profit -> Cr retained earnings                       loss                         -> Dr retained earnings
export function buildClosingPlan(
  rows: readonly ClosingInput[],
  retained: { id: string; code: string; name: string }
): ClosingPlan {
  const lines: ClosingPlan["lines"] = [];
  let netIncome = 0n; // sum of (credit - debit) over revenue and expense accounts

  for (const r of rows) {
    const net = r.credit - r.debit; // credit-positive
    if (net === 0n) continue;
    netIncome += net;
    // Zero the account: put the opposite of its balance on the opposite side.
    lines.push(
      net > 0n
        ? { accountId: r.id, code: r.code, name: r.name, debit: net, credit: 0n }
        : { accountId: r.id, code: r.code, name: r.name, debit: 0n, credit: -net }
    );
  }
  if (lines.length === 0) return { lines, netIncome: 0n };

  if (netIncome !== 0n) {
    lines.push(
      netIncome > 0n
        ? { accountId: retained.id, code: retained.code, name: retained.name, debit: 0n, credit: netIncome }
        : { accountId: retained.id, code: retained.code, name: retained.name, debit: -netIncome, credit: 0n }
    );
  }
  return { lines, netIncome };
}
