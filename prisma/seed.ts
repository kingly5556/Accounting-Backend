import { PrismaClient } from "@prisma/client";
import { createDraft, postEntry } from "../src/modules/journal/journal.service.js";
import { CHART_OF_ACCOUNTS } from "./chart-of-accounts.js";

const prisma = new PrismaClient();

// Noon today in Bangkok: unambiguously "today" and inside the current month.
function todayNoonBangkok(): Date {
  const bangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), bangkok.getUTCDate(), 12) - 7 * 60 * 60 * 1000);
}

async function main() {
  if ((await prisma.account.count()) > 0) {
    console.log("Chart of accounts already seeded — nothing to do.");
    return;
  }

  const ids = new Map<string, string>();
  // Parents first so parentId can be resolved.
  for (const row of CHART_OF_ACCOUNTS.filter((r) => r.group)) {
    const a = await prisma.account.create({
      data: { code: row.code, name: row.name, type: row.type, isPostable: false },
    });
    ids.set(row.code, a.id);
  }
  for (const row of CHART_OF_ACCOUNTS.filter((r) => !r.group)) {
    const a = await prisma.account.create({
      data: { code: row.code, name: row.name, type: row.type, parentId: row.parent ? ids.get(row.parent) : null },
    });
    ids.set(row.code, a.id);
  }

  const date = todayNoonBangkok();
  const sample = [
    { description: "Capital injection: opening the company", dr: "1110", cr: "3100", satang: 100_000_000n },
    { description: "Office rent", dr: "5300", cr: "1110", satang: 1_500_000n },
  ];
  for (const s of sample) {
    const draft = await createDraft(
      {
        entryDate: date,
        description: s.description,
        lines: [
          { accountId: ids.get(s.dr)!, debit: s.satang, credit: 0n },
          { accountId: ids.get(s.cr)!, debit: 0n, credit: s.satang },
        ],
      },
      "seed"
    );
    await postEntry(draft.id, "seed");
  }

  console.log(`Seeded ${CHART_OF_ACCOUNTS.length} accounts and ${sample.length} posted entries.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
