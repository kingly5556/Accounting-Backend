import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/database/prisma.js";
import { AppError } from "../../shared/middleware/error-handler.js";
import { periodOf } from "../../shared/utils/period.js";
import { createDraftTx, postEntryTx } from "../journal/journal.service.js";
import { resolveEventDate } from "../period/period.service.js";
import { planPosting, type PostingPlan, type PostingRequest } from "./posting-rules.js";

const SYSTEM_USER = "system:stock";

export type PostingResult = { entryId: string; entryNo: string | null; created: boolean };

async function findExisting(plan: PostingPlan) {
  return prisma.journalEntry.findUnique({
    where: {
      sourceModule_sourceType_sourceId: {
        sourceModule: plan.sourceModule,
        sourceType: plan.sourceType,
        sourceId: plan.sourceId,
      },
    },
  });
}

/**
 * Book an event from another module. Idempotent: the same (module, type, id) yields
 * the same entry no matter how many times it is sent. Never refused for a closed
 * period — the entry is moved to the next open period instead and says so in its memo.
 */
export async function postEvent(req: PostingRequest): Promise<PostingResult> {
  const plan = planPosting(req);

  const existing = await findExisting(plan);
  if (existing) return { entryId: existing.id, entryNo: existing.entryNo, created: false };

  try {
    return await prisma.$transaction(async (tx) => {
      const codes = [...new Set(plan.lines.map((l) => l.accountCode))];
      const accounts = await tx.account.findMany({ where: { code: { in: codes } } });
      const byCode = new Map(accounts.map((a) => [a.code, a]));
      for (const code of codes) {
        if (!byCode.has(code)) {
          // Permanent (4xx): sending again cannot help until the chart of accounts is fixed.
          throw new AppError(422, `Account ${code} required by posting rule does not exist`);
        }
      }

      const { date, shiftedFrom } = await resolveEventDate(tx, plan.occurredAt);
      const description = shiftedFrom
        ? `${plan.description} [actual date ${periodOf(shiftedFrom)} — posted in next open period]`
        : plan.description;

      const draft = await createDraftTx(
        tx,
        {
          entryDate: date,
          description,
          sourceModule: plan.sourceModule,
          sourceType: plan.sourceType,
          sourceId: plan.sourceId,
          sourceRef: plan.sourceRef ?? null,
          lines: plan.lines.map((l) => ({
            accountId: byCode.get(l.accountCode)!.id,
            debit: l.debit,
            credit: l.credit,
            memo: shiftedFrom ? `actual date ${shiftedFrom.toISOString()}` : l.memo,
          })),
        },
        SYSTEM_USER
      );
      const posted = await postEntryTx(tx, draft.id, SYSTEM_USER);
      return { entryId: posted.id, entryNo: posted.entryNo, created: true };
    });
  } catch (err) {
    // Two identical events racing: the loser hits the unique key — return the winner's entry.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await findExisting(plan);
      if (winner) return { entryId: winner.id, entryNo: winner.entryNo, created: false };
    }
    throw err;
  }
}
