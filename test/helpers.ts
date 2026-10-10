import { SignJWT } from "jose";
import { prisma } from "../src/shared/database/prisma.js";
import { CHART_OF_ACCOUNTS } from "../prisma/chart-of-accounts.js";

// TRUNCATE does not fire row-level triggers, so it can reset posted (immutable) data.
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "journal_lines","journal_entries","accounts","accounting_periods","document_counters" RESTART IDENTITY CASCADE`
  );
}

/** Chart of accounts as { code -> id }. */
export async function seedChart(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const row of CHART_OF_ACCOUNTS.filter((r) => r.group)) {
    ids[row.code] = (await prisma.account.create({ data: { code: row.code, name: row.name, type: row.type, isPostable: false } })).id;
  }
  for (const row of CHART_OF_ACCOUNTS.filter((r) => !r.group)) {
    ids[row.code] = (
      await prisma.account.create({
        data: { code: row.code, name: row.name, type: row.type, parentId: row.parent ? ids[row.parent] : null },
      })
    ).id;
  }
  return ids;
}

export async function tokenFor(roles: string[], allowedModules = ["accounting"], sub = "tester") {
  return new SignJWT({ sub, username: sub, roles, allowedModules })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
}

export const at = (iso: string) => new Date(iso);
