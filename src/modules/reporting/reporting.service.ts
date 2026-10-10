import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";
import { endOfBangkokDayExclusive, startOfBangkokDay } from "../../shared/utils/dates.js";

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
