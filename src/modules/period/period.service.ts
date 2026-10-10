import { randomUUID } from "node:crypto";
import type { AccountingPeriod, Prisma } from "@prisma/client";
import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";
import { isValidPeriod, periodOf, startOfNextPeriod, startOfPeriod } from "../../shared/utils/period.js";

type Tx = Prisma.TransactionClient;

/** Periods are created lazily as OPEN the first time something is posted into them. */
export async function ensurePeriod(tx: Tx, period: string): Promise<AccountingPeriod> {
  // Prisma's upsert is not atomic (read-then-insert), so two first-posts into a new
  // month race on the unique key. INSERT ... ON CONFLICT DO NOTHING is.
  await tx.$executeRaw`
    INSERT INTO "accounting_periods" ("id", "period", "status")
    VALUES (${randomUUID()}, ${period}, 'OPEN')
    ON CONFLICT ("period") DO NOTHING`;
  return tx.accountingPeriod.findUniqueOrThrow({ where: { period } });
}

/** Manual posting: a CLOSED period rejects the entry with 409. */
export async function assertPeriodOpen(tx: Tx, date: Date): Promise<string> {
  const period = periodOf(date);
  const row = await ensurePeriod(tx, period);
  if (row.status === "CLOSED") {
    throw new AppError(409, `Accounting period ${period} is closed`);
  }
  return period;
}

/**
 * System posting (events from other modules) must never be refused: if the real date
 * falls in a closed period, move it to the first instant of the next OPEN period.
 * Returns the effective date and the original date when it was moved.
 */
export async function resolveEventDate(
  tx: Tx,
  occurredAt: Date
): Promise<{ date: Date; shiftedFrom: Date | null }> {
  let period = periodOf(occurredAt);
  let date = occurredAt;
  for (;;) {
    const row = await tx.accountingPeriod.findUnique({ where: { period } });
    if (!row || row.status === "OPEN") break;
    date = startOfNextPeriod(period);
    period = periodOf(date);
  }
  return { date, shiftedFrom: date === occurredAt ? null : occurredAt };
}

export function listPeriods() {
  return prisma.accountingPeriod.findMany({ orderBy: { period: "desc" } });
}

export async function closePeriod(period: string, closedBy: string) {
  if (!isValidPeriod(period)) {
    throw new AppError(400, "Period must look like 2026-10");
  }
  return prisma.$transaction(async (tx) => {
    const row = await ensurePeriod(tx, period);
    if (row.status === "CLOSED") {
      throw new AppError(409, `Accounting period ${period} is already closed`);
    }
    // A DRAFT left behind could never be posted into a closed period, so refuse to close.
    const drafts = await tx.journalEntry.count({
      where: { status: "DRAFT", entryDate: { gte: startOfPeriod(period), lt: startOfNextPeriod(period) } },
    });
    if (drafts > 0) {
      throw new AppError(409, `Period ${period} still has ${drafts} draft journal entr${drafts === 1 ? "y" : "ies"}`);
    }
    return tx.accountingPeriod.update({
      where: { period },
      data: { status: "CLOSED", closedBy, closedAt: new Date() },
    });
  });
}
