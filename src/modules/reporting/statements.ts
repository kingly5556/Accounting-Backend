// Pure builders for the financial statements. Input is the per-account debit/credit totals
// (bigint satang) the SQL layer produces; no database or I/O here, so every rule is unit-tested.

export type AccountTotals = {
  id: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  debit: bigint;
  credit: bigint;
};

export type StatementRow = { accountId: string; code: string; name: string; amount: bigint };

const byType = (rows: readonly AccountTotals[], type: AccountTotals["type"]) => rows.filter((r) => r.type === type);
const sum = (rows: readonly StatementRow[]) => rows.reduce((s, r) => s + r.amount, 0n);

// Amounts are shown on the account's NORMAL side, so a healthy account is positive:
// assets/expenses = debit - credit; liabilities/equity/revenue = credit - debit.
const debitNormal = (r: AccountTotals): StatementRow => ({ accountId: r.id, code: r.code, name: r.name, amount: r.debit - r.credit });
const creditNormal = (r: AccountTotals): StatementRow => ({ accountId: r.id, code: r.code, name: r.name, amount: r.credit - r.debit });
const nonZero = (r: StatementRow) => r.amount !== 0n;

export function buildIncomeStatement(rows: readonly AccountTotals[]) {
  const revenues = byType(rows, "REVENUE").map(creditNormal).filter(nonZero);
  const expenses = byType(rows, "EXPENSE").map(debitNormal).filter(nonZero);
  const totalRevenue = sum(revenues);
  const totalExpense = sum(expenses);
  return { revenues, expenses, totalRevenue, totalExpense, netIncome: totalRevenue - totalExpense };
}

/**
 * `rows` must contain ALL accounts' totals up to the as-of date. Revenue and expense accounts
 * that have not been closed into retained earnings yet appear as "net income to date", which
 * is what makes assets = liabilities + equity hold at any date, not only after a year-end close.
 */
export function buildBalanceSheet(rows: readonly AccountTotals[]) {
  const assets = byType(rows, "ASSET").map(debitNormal).filter(nonZero);
  const liabilities = byType(rows, "LIABILITY").map(creditNormal).filter(nonZero);
  const equity = byType(rows, "EQUITY").map(creditNormal).filter(nonZero);
  const netIncomeToDate = sum(byType(rows, "REVENUE").map(creditNormal)) - sum(byType(rows, "EXPENSE").map(debitNormal));
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + netIncomeToDate;
  return {
    assets,
    liabilities,
    equity,
    netIncomeToDate,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}
