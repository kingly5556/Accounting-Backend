import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";
import { startOfPeriod } from "../../shared/utils/period.js";
import { createDraftTx, postEntryTx } from "../journal/journal.service.js";
import { ACCOUNT_CODES } from "../posting-rules/mapping.js";
import { accountTotals } from "../reporting/reporting.service.js";
import { ensurePeriod } from "./period.service.js";
import { buildClosingPlan, YEAR_END_MODULE, YEAR_END_TYPE, type ClosingInput } from "./year-end.js";

type Tx = Prisma.TransactionClient;

const periodsOf = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

function assertYear(year: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError(400, "Year must be between 2000 and 2100");
}

// Everything the closing needs, computed in one place so preview and close cannot disagree.
async function plan(tx: Tx, year: number) {
  assertYear(year);
  const blockers: string[] = [];
  const yearStart = startOfPeriod(`${year}-01`);
  const nextYearStart = startOfPeriod(`${year + 1}-01`);

  const already = await tx.journalEntry.findUnique({
    where: {
      sourceModule_sourceType_sourceId: { sourceModule: YEAR_END_MODULE, sourceType: YEAR_END_TYPE, sourceId: String(year) },
    },
  });
  if (already) blockers.push(`Year ${year} is already closed (${already.entryNo})`);

  // Revenue/expense must already be zero before this year, i.e. earlier years were closed.
  const before = await accountTotals(tx, { toExclusive: yearStart, types: ["REVENUE", "EXPENSE"] });
  const openBefore = before.filter((r) => r.debit !== r.credit);
  if (openBefore.length > 0) blockers.push(`An earlier year still has unclosed revenue/expense accounts — close it first`);

  const drafts = await tx.journalEntry.count({ where: { status: "DRAFT", entryDate: { gte: yearStart, lt: nextYearStart } } });
  if (drafts > 0) blockers.push(`${drafts} draft journal entr${drafts === 1 ? "y" : "ies"} dated in ${year} must be posted or deleted first`);

  const retained = await tx.account.findUnique({ where: { code: ACCOUNT_CODES.retainedEarnings } });
  if (!retained || !retained.isActive) blockers.push(`Retained earnings account ${ACCOUNT_CODES.retainedEarnings} is missing or inactive`);

  const totals = await accountTotals(tx, { toExclusive: nextYearStart, types: ["REVENUE", "EXPENSE"] });
  const closing = buildClosingPlan(
    totals as ClosingInput[],
    retained ? { id: retained.id, code: retained.code, name: retained.name } : { id: "", code: ACCOUNT_CODES.retainedEarnings, name: "" }
  );
  return { year, blockers, closing, retained };
}

export async function previewYearEnd(year: number) {
  const { blockers, closing } = await plan(prisma, year);
  return { year, canClose: blockers.length === 0, blockers, netIncome: closing.netIncome, lines: closing.lines };
}

/**
 * Closes a calendar year (Bangkok time): books one entry on 31 Dec that zeroes every revenue
 * and expense account into retained earnings, then locks all twelve periods of the year.
 * One transaction — either the entry and the locks all happen, or nothing does.
 */
export async function closeYear(year: number, closedBy: string) {
  return prisma.$transaction(async (tx) => {
    const { blockers, closing } = await plan(tx, year);
    if (blockers.length > 0) throw new AppError(409, blockers.join("; "));

    let entryNo: string | null = null;
    if (closing.lines.length > 0) {
      // Noon on 31 Dec Bangkok: unambiguously inside December whatever the display time zone.
      const entryDate = new Date(startOfPeriod(`${year + 1}-01`).getTime() - 12 * 60 * 60 * 1000);
      const draft = await createDraftTx(
        tx,
        {
          entryDate,
          description: `Year-end closing ${year}: revenue and expenses to retained earnings`,
          sourceModule: YEAR_END_MODULE,
          sourceType: YEAR_END_TYPE,
          sourceId: String(year),
          lines: closing.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
        },
        closedBy
      );
      // Posts into December, so December must still be OPEN (409 otherwise).
      entryNo = (await postEntryTx(tx, draft.id, closedBy)).entryNo;
    }

    const periods = periodsOf(year);
    for (const p of periods) await ensurePeriod(tx, p);
    await tx.accountingPeriod.updateMany({
      where: { period: { in: periods }, status: "OPEN" },
      data: { status: "CLOSED", closedBy, closedAt: new Date() },
    });
    return { year, entryNo, netIncome: closing.netIncome };
  });
}
