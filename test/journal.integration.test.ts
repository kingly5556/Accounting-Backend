import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/shared/database/prisma.js";
import { resetDb, seedChart, tokenFor } from "./helpers.js";
import { startServer, type TestServer } from "./server.js";

let srv: TestServer;
let ids: Record<string, string>;
let acct: string; // Accountant token
let admin: string;

const line = (code: string, debit: string, credit: string) => ({ accountId: ids[code], debit, credit });
const entry = (date: string, debit = "100000", extra: object = {}) => ({
  entryDate: date,
  description: "test entry",
  lines: [line("1110", debit, "0"), line("3100", "0", debit)],
  ...extra,
});

async function postNew(date = "2026-10-15", debit = "100000") {
  const created = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry(date, debit) });
  expect(created.status).toBe(201);
  const posted = await srv.call("POST", `/api/journal-entries/${created.body.id}/post`, { token: acct });
  expect(posted.status).toBe(200);
  return posted.body;
}

beforeAll(async () => {
  srv = await startServer();
  acct = await tokenFor(["Accountant"]);
  admin = await tokenFor(["Admin"]);
});
afterAll(async () => {
  await srv.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  ids = await seedChart();
});

describe("draft -> post", () => {
  it("issues gap-free numbers per month only at post time", async () => {
    const draft = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-15") });
    expect(draft.body.entryNo).toBeNull();
    expect(draft.body.status).toBe("DRAFT");

    const a = await postNew("2026-10-15");
    const b = await postNew("2026-10-20");
    const nov = await postNew("2026-11-02");
    expect([a.entryNo, b.entryNo, nov.entryNo]).toEqual(["JE-2026-10-0001", "JE-2026-10-0002", "JE-2026-11-0001"]);
  });

  it("numbers concurrent posts without gaps or duplicates", async () => {
    const drafts = await Promise.all(
      Array.from({ length: 8 }, () => srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-15") }))
    );
    const posted = await Promise.all(
      drafts.map((d) => srv.call("POST", `/api/journal-entries/${d.body.id}/post`, { token: acct }))
    );
    expect(posted.every((p) => p.status === 200)).toBe(true);
    const nos = posted.map((p) => p.body.entryNo).sort();
    expect(nos).toEqual(Array.from({ length: 8 }, (_, i) => `JE-2026-10-${String(i + 1).padStart(4, "0")}`));
  });

  it("rejects an unbalanced draft (422)", async () => {
    const res = await srv.call("POST", "/api/journal-entries", {
      token: acct,
      body: { entryDate: "2026-10-15", description: "bad", lines: [line("1110", "100", "0"), line("3100", "0", "99")] },
    });
    expect(res.status).toBe(422);
  });

  it("rejects group-header and inactive accounts (422)", async () => {
    const header = await srv.call("POST", "/api/journal-entries", {
      token: acct,
      body: { entryDate: "2026-10-15", description: "x", lines: [line("1000", "100", "0"), line("3100", "0", "100")] },
    });
    expect(header.status).toBe(422);
    await prisma.account.update({ where: { id: ids["1100"] }, data: { isActive: false } });
    const inactive = await srv.call("POST", "/api/journal-entries", {
      token: acct,
      body: { entryDate: "2026-10-15", description: "x", lines: [line("1100", "100", "0"), line("3100", "0", "100")] },
    });
    expect(inactive.status).toBe(422);
  });

  it("re-checks accounts at post time", async () => {
    const created = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-15") });
    await prisma.account.update({ where: { id: ids["1110"] }, data: { isActive: false } });
    const res = await srv.call("POST", `/api/journal-entries/${created.body.id}/post`, { token: acct });
    expect(res.status).toBe(422);
  });

  it("only DRAFT entries can be edited or deleted", async () => {
    const posted = await postNew();
    expect((await srv.call("PATCH", `/api/journal-entries/${posted.id}`, { token: acct, body: entry("2026-10-16") })).status).toBe(409);
    expect((await srv.call("DELETE", `/api/journal-entries/${posted.id}`, { token: acct })).status).toBe(409);
    const draft = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-15") });
    expect((await srv.call("PATCH", `/api/journal-entries/${draft.body.id}`, { token: acct, body: entry("2026-10-16", "5000") })).status).toBe(200);
    expect((await srv.call("DELETE", `/api/journal-entries/${draft.body.id}`, { token: acct })).status).toBe(204);
  });

  it("books amounts above int32 (90 billion THB) exactly", async () => {
    const big = "9000000000000";
    const posted = await postNew("2026-10-15", big);
    expect(posted.lines[0].debit).toBe(big);
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-31", { token: acct });
    expect(tb.body.totalDebit).toBe(big);
    expect(tb.body.balanced).toBe(true);
  });
});

describe("accounting periods", () => {
  it("rejects posting into a closed period with 409", async () => {
    const draft = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-15") });
    const closed = await srv.call("POST", "/api/periods/2026-10/close", { token: admin });
    expect(closed.status).toBe(409); // the draft is still open in that month
    await srv.call("DELETE", `/api/journal-entries/${draft.body.id}`, { token: acct });
    expect((await srv.call("POST", "/api/periods/2026-10/close", { token: admin })).status).toBe(200);

    const late = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-20") });
    const res = await srv.call("POST", `/api/journal-entries/${late.body.id}/post`, { token: acct });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2026-10 is closed/);
  });

  it("only Admin may close a period", async () => {
    expect((await srv.call("POST", "/api/periods/2026-10/close", { token: acct })).status).toBe(403);
  });

  it("uses Bangkok time to pick the period (00:30 on the 1st belongs to the new month)", async () => {
    // Entry dates typed by users are Bangkok days; the instant is stored at noon Bangkok.
    const oct31 = await postNew("2026-10-31");
    const nov01 = await postNew("2026-11-01");
    expect(oct31.entryNo).toMatch(/^JE-2026-10-/);
    expect(nov01.entryNo).toMatch(/^JE-2026-11-/);
  });
});

describe("reversal", () => {
  it("creates a swapped, posted entry and flips the original to REVERSED", async () => {
    const original = await postNew("2026-10-15", "250000");
    const rev = await srv.call("POST", `/api/journal-entries/${original.id}/reverse`, { token: acct, body: { entryDate: "2026-10-16" } });
    expect(rev.status).toBe(201);
    expect(rev.body.status).toBe("POSTED");
    expect(rev.body.reversalOf.id).toBe(original.id);
    expect(rev.body.sourceModule).toBeNull();
    const swapped = rev.body.lines.find((l: any) => l.account.code === "1110");
    expect(swapped.credit).toBe("250000");
    expect(swapped.debit).toBe("0");

    const after = await srv.call("GET", `/api/journal-entries/${original.id}`, { token: acct });
    expect(after.body.status).toBe("REVERSED");
    expect(after.body.reversedBy.id).toBe(rev.body.id);
  });

  it("original + reversal nets to zero on every account and the trial balance still balances", async () => {
    const original = await postNew("2026-10-15", "250000");
    await srv.call("POST", `/api/journal-entries/${original.id}/reverse`, { token: acct, body: { entryDate: "2026-10-16" } });
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-31", { token: acct });
    // Rows exist (REVERSED is counted) and each account nets to zero.
    expect(tb.body.accounts.length).toBe(2);
    for (const a of tb.body.accounts) {
      expect(a.debitBalance).toBe("0");
      expect(a.creditBalance).toBe("0");
      expect(a.debit).toBe(a.credit);
    }
    expect(tb.body.balanced).toBe(true);
  });

  it("cannot reverse twice, nor reverse a reversal", async () => {
    const original = await postNew();
    const rev = await srv.call("POST", `/api/journal-entries/${original.id}/reverse`, { token: acct, body: {} });
    expect(rev.status).toBe(201);
    expect((await srv.call("POST", `/api/journal-entries/${original.id}/reverse`, { token: acct, body: {} })).status).toBe(409);
    expect((await srv.call("POST", `/api/journal-entries/${rev.body.id}/reverse`, { token: acct, body: {} })).status).toBe(409);
  });

  it("refuses to reverse into a closed period", async () => {
    const original = await postNew("2026-10-15");
    await srv.call("POST", "/api/periods/2026-10/close", { token: admin });
    const res = await srv.call("POST", `/api/journal-entries/${original.id}/reverse`, { token: acct, body: { entryDate: "2026-10-20" } });
    expect(res.status).toBe(409);
    const ok = await srv.call("POST", `/api/journal-entries/${original.id}/reverse`, { token: acct, body: { entryDate: "2026-11-02" } });
    expect(ok.status).toBe(201);
  });
});

describe("reports", () => {
  it("excludes DRAFT entries and balances after seeded postings", async () => {
    await postNew("2026-10-15", "100000");
    await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-16", "777") }); // draft
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-31", { token: acct });
    expect(tb.body.totalDebit).toBe("100000");
    expect(tb.body.balanced).toBe(true);
  });

  it("as-of date cuts off later entries (whole Bangkok day included)", async () => {
    await postNew("2026-10-15", "100");
    await postNew("2026-10-20", "200");
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-15", { token: acct });
    expect(tb.body.totalDebit).toBe("100");
  });

  it("general ledger gives opening balance, lines and a running balance", async () => {
    await postNew("2026-09-20", "1000");
    await postNew("2026-10-05", "300");
    await postNew("2026-10-09", "200");
    const gl = await srv.call("GET", `/api/reports/general-ledger/${ids["1110"]}?from=2026-10-01&to=2026-10-31`, { token: acct });
    expect(gl.status).toBe(200);
    expect(gl.body.openingBalance).toBe("1000");
    expect(gl.body.lines.map((l: any) => l.balance)).toEqual(["1300", "1500"]);
    expect(gl.body.closingBalance).toBe("1500");
    expect(gl.body.account.normalSide).toBe("DEBIT");
  });
});

describe("database-level integrity", () => {
  it("CHECK: a line cannot be both debit and credit, or neither", async () => {
    const draft = await srv.call("POST", "/api/journal-entries", { token: acct, body: entry("2026-10-15") });
    await expect(
      prisma.journalLine.create({ data: { entryId: draft.body.id, accountId: ids["1110"], debit: 5n, credit: 5n } })
    ).rejects.toThrow();
    await expect(
      prisma.journalLine.create({ data: { entryId: draft.body.id, accountId: ids["1110"], debit: 0n, credit: 0n } })
    ).rejects.toThrow();
  });

  it("trigger: posted entries and their lines cannot be changed or deleted, even by raw SQL", async () => {
    const posted = await postNew();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "journal_entries" SET "description" = 'tampered' WHERE "id" = '${posted.id}'`)
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "journal_entries" SET "status" = 'DRAFT' WHERE "id" = '${posted.id}'`)
    ).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "journal_entries" WHERE "id" = '${posted.id}'`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "journal_lines" SET "debit" = 1 WHERE "entryId" = '${posted.id}' AND "debit" > 0`)).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "journal_lines" WHERE "entryId" = '${posted.id}'`)).rejects.toThrow(/immutable/);
    await expect(
      prisma.journalLine.create({ data: { entryId: posted.id, accountId: ids["1110"], debit: 1n, credit: 0n } })
    ).rejects.toThrow(/immutable/);
  });
});

describe("chart of accounts rules", () => {
  it("blocks changing code/type of an account that already has entries, but allows rename", async () => {
    await postNew();
    expect((await srv.call("PATCH", `/api/accounts/${ids["1110"]}`, { token: acct, body: { code: "1115" } })).status).toBe(409);
    expect((await srv.call("PATCH", `/api/accounts/${ids["1110"]}`, { token: acct, body: { type: "LIABILITY" } })).status).toBe(409);
    expect((await srv.call("PATCH", `/api/accounts/${ids["1110"]}`, { token: acct, body: { name: "ธนาคาร A" } })).status).toBe(200);
    expect((await srv.call("DELETE", `/api/accounts/${ids["1110"]}`, { token: acct })).status).toBe(409);
  });

  it("lets an unused account be edited and deleted", async () => {
    expect((await srv.call("PATCH", `/api/accounts/${ids["4100"]}`, { token: acct, body: { code: "4150" } })).status).toBe(200);
    expect((await srv.call("DELETE", `/api/accounts/${ids["4100"]}`, { token: acct })).status).toBe(204);
  });
});

describe("auth (via ERPHUB JWT)", () => {
  it("401 without a token or with a garbage token", async () => {
    expect((await srv.call("GET", "/api/accounts")).status).toBe(401);
    expect((await srv.call("GET", "/api/accounts", { token: "garbage" })).status).toBe(401);
  });

  it("403 when the token has no 'accounting' module — even for Admin", async () => {
    const t = await tokenFor(["Admin"], ["stock"]);
    expect((await srv.call("GET", "/api/accounts", { token: t })).status).toBe(403);
  });

  it("module members without the role can read but not write", async () => {
    const viewer = await tokenFor(["Warehouse Staff"]);
    expect((await srv.call("GET", "/api/accounts", { token: viewer })).status).toBe(200);
    expect((await srv.call("GET", "/api/reports/trial-balance", { token: viewer })).status).toBe(200);
    expect((await srv.call("POST", "/api/journal-entries", { token: viewer, body: entry("2026-10-15") })).status).toBe(403);
  });

  it("/api/me returns the caller's roles", async () => {
    const res = await srv.call("GET", "/api/me", { token: acct });
    expect(res.body).toEqual({ username: "tester", roles: ["Accountant"] });
  });

  it("createdBy / postedBy come from the JWT, not the body", async () => {
    const t = await tokenFor(["Accountant"], ["accounting"], "alice");
    const created = await srv.call("POST", "/api/journal-entries", { token: t, body: { ...entry("2026-10-15"), createdBy: "mallory" } });
    expect(created.body.createdBy).toBe("alice");
    const posted = await srv.call("POST", `/api/journal-entries/${created.body.id}/post`, { token: t });
    expect(posted.body.postedBy).toBe("alice");
  });
});
