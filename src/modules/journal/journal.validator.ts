import { AppError } from "../../shared/middleware/error-handler.js";

export type LineAmounts = { accountId: string; debit: bigint; credit: bigint };

export function totals(lines: readonly LineAmounts[]): { debit: bigint; credit: bigint } {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    debit += l.debit;
    credit += l.credit;
  }
  return { debit, credit };
}

// Pure function: the heart of the module. Checked on draft save AND on post.
export function assertBalanced(lines: readonly LineAmounts[]): void {
  if (lines.length < 2) {
    throw new AppError(422, "A journal entry needs at least 2 lines");
  }
  for (const l of lines) {
    if (l.debit < 0n || l.credit < 0n) {
      throw new AppError(422, "Amounts cannot be negative");
    }
    const oneSide = (l.debit > 0n && l.credit === 0n) || (l.credit > 0n && l.debit === 0n);
    if (!oneSide) {
      throw new AppError(422, "Each line must have exactly one side (debit or credit) greater than zero");
    }
  }
  const { debit, credit } = totals(lines);
  if (debit !== credit) {
    throw new AppError(422, `Entry does not balance: debit ${debit} != credit ${credit}`);
  }
}

export function buildReversalLines(lines: readonly LineAmounts[]): LineAmounts[] {
  return lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit }));
}
