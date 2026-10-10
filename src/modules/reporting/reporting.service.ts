import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";
import { endOfBangkokDayExclusive, startOfBangkokDay } from "../../shared/utils/dates.js";
import { YEAR_END_TYPE } from "../period/year-end.js";
import { buildBalanceSheet, buildIncomeStatement, type AccountTotals } from "./statements.js";

// Reports count POSTED *and* REVERSED entries: a reversed original must stay in so it
// cancels against its reversal. Only DRAFT is excluded. All sums are bigint (SQL
// SUM(...)::bigint) — never Number, never float.
const COUNTED = ["POSTED", "REVERSED"];

type BalanceRow = { id: string; code: string; name: string; type: string; debit: bigint; credit: bigint };

export async function trialBalance(asOf: string) {
  const until = endOfBangkokDayExclusive(asOf);
  const rows = await prisma.$queryRaw<BalanceRow[]>`
    SELECT a."id", a."code", a."name", a."type"::text AS "type",
           COALESCE(SUM(l."debit"), 0)::bigint AS "debit",
           COALESCE(SUM(l."credit"), 0)::bigint AS "credit"
    FROM "accounts" a
    JOIN "journal_lines" l ON l."accountId" = a."id"
    JOIN "journal_entries" e ON e."id" = l."entryId"
    WHERE e."status"::text = ANY(${COUNTED}) AND e."entryDate" < ${until}
    GROUP BY a."id", a."code", a."name", a."type"
    ORDER BY a."code"`;

  let totalDebit = 0n;
  let totalCredit = 0n;
  const accounts = rows.map((r) => {
    const net = r.debit - r.credit;
    const debitBalance = net > 0n ? net : 0n;
    const creditBalance = net < 0n ? -net : 0n;
    totalDebit += debitBalance;
    totalCredit += creditBalance;
    return {
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      debit: r.debit,
      credit: r.credit,
      debitBalance,
      creditBalance,
    };
  });
  return { asOf, accounts, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export async function generalLedger(accountId: string, from: string, to: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new AppError(404, "Account not found");
  const start = startOfBangkokDay(from);
  const endExclusive = endOfBangkokDayExclusive(to);
  if (endExclusive <= start) throw new AppError(400, "`to` must not be before `from`");

  const opening = await prisma.$queryRaw<{ debit: bigint; credit: bigint }[]>`
    SELECT COALESCE(SUM(l."debit"), 0)::bigint AS "debit", COALESCE(SUM(l."credit"), 0)::bigint AS "credit"
    FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."entryId"
    WHERE l."accountId" = ${accountId} AND e."status"::text = ANY(${COUNTED}) AND e."entryDate" < ${start}`;
  const openingBalance = opening[0].debit - opening[0].credit; // debit-positive

  const rows = await prisma.$queryRaw<
    { entryId: string; entryNo: string | null; entryDate: Date; description: string; memo: string | null; debit: bigint; credit: bigint }[]
  >`
    SELECT e."id" AS "entryId", e."entryNo", e."entryDate", e."description", l."memo", l."debit", l."credit"
    FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."entryId"
    WHERE l."accountId" = ${accountId} AND e."status"::text = ANY(${COUNTED})
      AND e."entryDate" >= ${start} AND e."entryDate" < ${endExclusive}
    ORDER BY e."entryDate", e."postedAt", l."id"`;

  // Running balance is debit-positive; `normalSide` tells the UI how to present it.
  let running = openingBalance;
  const lines = rows.map((r) => {
    running += r.debit - r.credit;
    return { ...r, balance: running };
  });
  const normalSide = account.type === "ASSET" || account.type === "EXPENSE" ? "DEBIT" : "CREDIT";
  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type, normalSide },
    from,
    to,
    openingBalance,
    lines,
    closingBalance: running,
  };
}

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Per-account debit/credit totals for the entries dated in [from, toExclusive).
 * `excludeClosing` drops the year-end closing entry — the income statement must show the
 * year's real revenue and expenses, not the zeros the closing entry leaves behind.
 */
export async function accountTotals(
  client: Client,
  opts: { from?: Date; toExclusive: Date; types?: AccountTotals["type"][]; excludeClosing?: boolean }
): Promise<AccountTotals[]> {
  const from = opts.from ?? new Date("1900-01-01T00:00:00Z");
  const types = opts.types ?? ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
  const closingFilter = opts.excludeClosing
    ? Prisma.sql`AND e."sourceType" IS DISTINCT FROM ${YEAR_END_TYPE}`
    : Prisma.empty;
  const rows = await client.$queryRaw<(Omit<AccountTotals, "debit" | "credit"> & { debit: bigint; credit: bigint })[]>`
    SELECT a."id", a."code", a."name", a."type"::text AS "type",
           COALESCE(SUM(l."debit"), 0)::bigint AS "debit",
           COALESCE(SUM(l."credit"), 0)::bigint AS "credit"
    FROM "accounts" a
    JOIN "journal_lines" l ON l."accountId" = a."id"
    JOIN "journal_entries" e ON e."id" = l."entryId"
    WHERE e."status"::text = ANY(${COUNTED})
      AND e."entryDate" >= ${from} AND e."entryDate" < ${opts.toExclusive}
      AND a."type"::text = ANY(${types})
      ${closingFilter}
    GROUP BY a."id", a."code", a."name", a."type"
    ORDER BY a."code"`;
  return rows;
}

export async function incomeStatement(from: string, to: string) {
  const start = startOfBangkokDay(from);
  const end = endOfBangkokDayExclusive(to);
  if (end <= start) throw new AppError(400, "`to` must not be before `from`");
  const rows = await accountTotals(prisma, { from: start, toExclusive: end, types: ["REVENUE", "EXPENSE"], excludeClosing: true });
  return { from, to, ...buildIncomeStatement(rows) };
}

export async function balanceSheet(asOf: string) {
  const rows = await accountTotals(prisma, { toExclusive: endOfBangkokDayExclusive(asOf) });
  return { asOf, ...buildBalanceSheet(rows) };
}
