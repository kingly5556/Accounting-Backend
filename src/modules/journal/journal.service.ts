import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";
import { assertPeriodOpen } from "../period/period.service.js";
import { assertTransition } from "./journal-status.js";
import { assertBalanced, buildReversalLines, type LineAmounts } from "./journal.validator.js";

type Tx = Prisma.TransactionClient;

export type LineInput = { accountId: string; debit: bigint; credit: bigint; memo?: string | null };

export type DraftInput = {
  entryDate: Date;
  description: string;
  lines: LineInput[];
  sourceModule?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceRef?: Prisma.InputJsonValue | null;
};

const entryInclude = {
  lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { id: "asc" } },
  reversalOf: { select: { id: true, entryNo: true } },
  reversedBy: { select: { id: true, entryNo: true } },
} satisfies Prisma.JournalEntryInclude;

// Rule 3: only postable, active accounts may carry lines. Checked on save AND on post.
async function assertAccountsUsable(tx: Tx, accountIds: string[]) {
  const unique = [...new Set(accountIds)];
  const accounts = await tx.account.findMany({ where: { id: { in: unique } } });
  if (accounts.length !== unique.length) {
    throw new AppError(422, "One or more accounts do not exist");
  }
  for (const a of accounts) {
    if (!a.isPostable) throw new AppError(422, `Account ${a.code} is a group header and cannot be posted to`);
    if (!a.isActive) throw new AppError(422, `Account ${a.code} is inactive`);
  }
}

function toAmounts(lines: readonly LineInput[]): LineAmounts[] {
  return lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit }));
}

export async function createDraftTx(tx: Tx, input: DraftInput, createdBy: string) {
  assertBalanced(toAmounts(input.lines));
  await assertAccountsUsable(tx, input.lines.map((l) => l.accountId));
  return tx.journalEntry.create({
    data: {
      entryDate: input.entryDate,
      description: input.description,
      createdBy,
      sourceModule: input.sourceModule ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      sourceRef: input.sourceRef ?? undefined,
      lines: {
        create: input.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo ?? null,
        })),
      },
    },
    include: entryInclude,
  });
}

export function createDraft(input: DraftInput, createdBy: string) {
  return prisma.$transaction((tx) => createDraftTx(tx, input, createdBy));
}

async function lockEntry(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "journal_entries" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new AppError(404, "Journal entry not found");
  return tx.journalEntry.findUniqueOrThrow({ where: { id }, include: { lines: true } });
}

// Gap-free numbering: the upsert row-locks the counter until this transaction ends,
// so two concurrent posts into the same month serialise and never share or skip a number.
async function nextEntryNo(tx: Tx, period: string): Promise<string> {
  const key = `JE-${period}`;
  const rows = await tx.$queryRaw<{ lastNo: number }[]>`
    INSERT INTO "document_counters" ("key", "lastNo") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "lastNo" = "document_counters"."lastNo" + 1
    RETURNING "lastNo"`;
  return `${key}-${String(rows[0].lastNo).padStart(4, "0")}`;
}

/** DRAFT -> POSTED inside an existing transaction. `date` must already be in an open period. */
export async function postEntryTx(tx: Tx, id: string, postedBy: string) {
  const entry = await lockEntry(tx, id);
  assertTransition(entry.status, "POSTED");
  assertBalanced(toAmounts(entry.lines));
  await assertAccountsUsable(tx, entry.lines.map((l) => l.accountId));
  const period = await assertPeriodOpen(tx, entry.entryDate);
  const entryNo = await nextEntryNo(tx, period);
  return tx.journalEntry.update({
    where: { id },
    data: { status: "POSTED", entryNo, postedBy, postedAt: new Date() },
    include: entryInclude,
  });
}

export function postEntry(id: string, postedBy: string) {
  return prisma.$transaction((tx) => postEntryTx(tx, id, postedBy));
}

/**
 * Posted entries are never edited. Reversing creates a new, already-posted entry with
 * every debit/credit swapped, then flips the original to REVERSED. The reversal carries
 * no source* fields (the original keeps the idempotency key), only `reversalOfId`.
 */
export function reverseEntry(id: string, user: string, entryDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const original = await lockEntry(tx, id);
    assertTransition(original.status, "REVERSED");
    if (original.reversalOfId) {
      throw new AppError(409, "A reversal entry cannot itself be reversed");
    }
    const date = entryDate ?? new Date();
    await assertPeriodOpen(tx, date);

    const reversal = await tx.journalEntry.create({
      data: {
        entryDate: date,
        description: `Reversal of ${original.entryNo}: ${original.description}`,
        createdBy: user,
        reversalOfId: original.id,
        lines: {
          create: buildReversalLines(toAmounts(original.lines)).map((l, i) => ({
            ...l,
            memo: original.lines[i].memo,
          })),
        },
      },
    });
    const posted = await postEntryTx(tx, reversal.id, user);
    await tx.journalEntry.update({ where: { id: original.id }, data: { status: "REVERSED" } });
    return posted;
  });
}

export function updateDraft(id: string, input: Omit<DraftInput, "sourceModule" | "sourceType" | "sourceId" | "sourceRef">) {
  return prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, id);
    if (entry.status !== "DRAFT") throw new AppError(409, "Only DRAFT entries can be edited");
    if (entry.sourceModule) throw new AppError(409, "Entries created from another module cannot be edited");
    assertBalanced(toAmounts(input.lines));
    await assertAccountsUsable(tx, input.lines.map((l) => l.accountId));
    await tx.journalLine.deleteMany({ where: { entryId: id } });
    return tx.journalEntry.update({
      where: { id },
      data: {
        entryDate: input.entryDate,
        description: input.description,
        lines: {
          create: input.lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            memo: l.memo ?? null,
          })),
        },
      },
      include: entryInclude,
    });
  });
}

export function deleteDraft(id: string) {
  return prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, id);
    if (entry.status !== "DRAFT") throw new AppError(409, "Only DRAFT entries can be deleted");
    await tx.journalEntry.delete({ where: { id } });
  });
}

export async function getEntry(id: string) {
  const entry = await prisma.journalEntry.findUnique({ where: { id }, include: entryInclude });
  if (!entry) throw new AppError(404, "Journal entry not found");
  return entry;
}

export type ListFilter = {
  status?: "DRAFT" | "POSTED" | "REVERSED";
  from?: Date;
  toExclusive?: Date;
  origin?: "manual" | "system";
};

export function listEntries(filter: ListFilter) {
  return prisma.journalEntry.findMany({
    where: {
      status: filter.status,
      entryDate: { gte: filter.from, lt: filter.toExclusive },
      sourceModule: filter.origin === "manual" ? null : filter.origin === "system" ? { not: null } : undefined,
    },
    include: { lines: { select: { debit: true, credit: true } } },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}
