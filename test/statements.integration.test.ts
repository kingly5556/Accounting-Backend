import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/shared/database/prisma.js";
import { resetDb, seedChart, tokenFor } from "./helpers.js";
import { startServer, type TestServer } from "./server.js";

let srv: TestServer;
let ids: Record<string, string>;
let acct: string;
let admin: string;

async function book(date: string, dr: string, cr: string, satang: string) {
  const created = await srv.call("POST", "/api/journal-entries", {
    token: acct,
    body: {
      entryDate: date,
      description: `${dr}/${cr}`,
      lines: [
        { accountId: ids[dr], debit: satang, credit: "0" },
        { accountId: ids[cr], debit: "0", credit: satang },
      ],
    },
  });
  const posted = await srv.call("POST", `/api/journal-entries/${created.body.id}/post`, { token: acct });
  expect(posted.status).toBe(200);
  return posted.body;
}

// 2026: capital 1,000,000.00 | sales 300,000.00 | cost of sales 120,000.00 | rent 50,000.00
// -> net income 130,000.00 THB = 13,000,000 satang
async function year2026() {
  await book("2026-03-10", "1110", "3100", "100000000");
  await book("2026-04-05", "1100", "4100", "30000000");
  await book("2026-04-05", "5100", "1110", "12000000");
  await book("2026-06-01", "5300", "1110", "5000000");
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

describe("income statement", () => {
  it("revenue - expenses = net income", async () => {
    await year2026();
    const res = await srv.call("GET", "/api/reports/income-statement?from=2026-01-01&to=2026-12-31", { token: acct });
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe("30000000");
    expect(res.body.totalExpense).toBe("17000000");
    expect(res.body.netIncome).toBe("13000000");
    expect(res.body.expenses.map((r: any) => r.code)).toEqual(["5100", "5300"]);
  });

  it("honours the date range", async () => {
    await year2026();
    const q2 = await srv.call("GET", "/api/reports/income-statement?from=2026-04-01&to=2026-04-30", { token: acct });
    expect(q2.body.netIncome).toBe("18000000"); // sale 30,000,000 - cost 12,000,000, no rent yet
  });

  it("ignores DRAFT entries", async () => {
    await year2026();
    await srv.call("POST", "/api/journal-entries", {
      token: acct,
      body: { entryDate: "2026-07-01", description: "draft", lines: [
        { accountId: ids["1100"], debit: "999", credit: "0" },
        { accountId: ids["4100"], debit: "0", credit: "999" },
      ] },
    });
    const res = await srv.call("GET", "/api/reports/income-statement?from=2026-01-01&to=2026-12-31", { token: acct });
    expect(res.body.totalRevenue).toBe("30000000");
  });
});

describe("balance sheet", () => {
  it("assets = liabilities + equity + net income to date, before any year-end close", async () => {
    await year2026();
    const res = await srv.call("GET", "/api/reports/balance-sheet?asOf=2026-06-30", { token: acct });
    expect(res.body.netIncomeToDate).toBe("13000000");
    expect(res.body.totalAssets).toBe("113000000"); // 100,000,000 - 12,000,000 - 5,000,000 + 30,000,000
    expect(res.body.totalEquity).toBe("113000000"); // capital 100,000,000 + 13,000,000
    expect(res.body.balanced).toBe(true);
  });

  it("is a snapshot: an earlier date excludes later entries", async () => {
    await year2026();
    const res = await srv.call("GET", "/api/reports/balance-sheet?asOf=2026-03-31", { token: acct });
    expect(res.body.totalAssets).toBe("100000000");
    expect(res.body.netIncomeToDate).toBe("0");
    expect(res.body.balanced).toBe(true);
  });
});

describe("year-end close", () => {
  it("preview shows the closing lines and net income without changing anything", async () => {
    await year2026();
    const res = await srv.call("GET", "/api/year-end/2026/preview", { token: admin });
    expect(res.status).toBe(200);
    expect(res.body.canClose).toBe(true);
    expect(res.body.netIncome).toBe("13000000");
    const re = res.body.lines.find((l: any) => l.code === "3200");
    expect(re.credit).toBe("13000000");
    expect(await prisma.journalEntry.count({ where: { sourceType: "YEAR_END_CLOSE" } })).toBe(0);
  });

  it("only Admin may preview or close", async () => {
    expect((await srv.call("GET", "/api/year-end/2026/preview", { token: acct })).status).toBe(403);
    expect((await srv.call("POST", "/api/year-end/2026/close", { token: acct })).status).toBe(403);
  });

  it("closes revenue/expenses into retained earnings and locks the year", async () => {
    await year2026();
    const res = await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    expect(res.status).toBe(200);
    expect(res.body.entryNo).toBe("JE-2026-12-0001");
    expect(res.body.netIncome).toBe("13000000");

    // Revenue and expense accounts are zero; profit sits in retained earnings.
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-12-31", { token: acct });
    const row = (c: string) => tb.body.accounts.find((a: any) => a.code === c);
    expect(row("4100").debitBalance).toBe("0");
    expect(row("4100").creditBalance).toBe("0");
    expect(row("5100").debitBalance).toBe("0");
    expect(row("3200").creditBalance).toBe("13000000");
    expect(tb.body.balanced).toBe(true);

    // The income statement still shows the real year (the closing entry is excluded)...
    const is = await srv.call("GET", "/api/reports/income-statement?from=2026-01-01&to=2026-12-31", { token: acct });
    expect(is.body.netIncome).toBe("13000000");
    // ...and the balance sheet still balances, with the profit now in equity.
    const bs = await srv.call("GET", "/api/reports/balance-sheet?asOf=2026-12-31", { token: acct });
    expect(bs.body.balanced).toBe(true);
    expect(bs.body.netIncomeToDate).toBe("0");
    expect(bs.body.totalEquity).toBe("113000000");

    // All twelve periods are locked.
    const periods = await srv.call("GET", "/api/periods", { token: acct });
    const y = periods.body.filter((p: any) => p.period.startsWith("2026-"));
    expect(y).toHaveLength(12);
    expect(y.every((p: any) => p.status === "CLOSED")).toBe(true);
  });

  it("cannot be closed twice, and nothing can be posted into the closed year", async () => {
    await year2026();
    await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    const again = await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already closed/);

    const late = await srv.call("POST", "/api/journal-entries", {
      token: acct,
      body: { entryDate: "2026-05-10", description: "late", lines: [
        { accountId: ids["1100"], debit: "1", credit: "0" },
        { accountId: ids["4100"], debit: "0", credit: "1" },
      ] },
    });
    const post = await srv.call("POST", `/api/journal-entries/${late.body.id}/post`, { token: acct });
    expect(post.status).toBe(409);
  });

  it("a loss is debited to retained earnings", async () => {
    await book("2026-03-10", "1110", "3100", "100000000");
    await book("2026-05-01", "5300", "1110", "2500000"); // expenses only
    const res = await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    expect(res.body.netIncome).toBe("-2500000");
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-12-31", { token: acct });
    expect(tb.body.accounts.find((a: any) => a.code === "3200").debitBalance).toBe("2500000");
    expect(tb.body.balanced).toBe(true);
  });

  it("is blocked by drafts dated in the year, and says why", async () => {
    await year2026();
    await srv.call("POST", "/api/journal-entries", {
      token: acct,
      body: { entryDate: "2026-11-02", description: "forgotten draft", lines: [
        { accountId: ids["1100"], debit: "5", credit: "0" },
        { accountId: ids["4100"], debit: "0", credit: "5" },
      ] },
    });
    const preview = await srv.call("GET", "/api/year-end/2026/preview", { token: admin });
    expect(preview.body.canClose).toBe(false);
    expect(preview.body.blockers.join(" ")).toMatch(/draft/);
    expect((await srv.call("POST", "/api/year-end/2026/close", { token: admin })).status).toBe(409);
    expect(await prisma.journalEntry.count({ where: { sourceType: "YEAR_END_CLOSE" } })).toBe(0);
  });

  it("requires earlier years to be closed first, then works in order", async () => {
    await book("2025-06-01", "1100", "4100", "1000"); // 2025 revenue, never closed
    await year2026();
    const blocked = await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/earlier year/);

    expect((await srv.call("POST", "/api/year-end/2025/close", { token: admin })).status).toBe(200);
    const ok = await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    expect(ok.status).toBe(200);
    // 2026's own result is unaffected by 2025's.
    expect(ok.body.netIncome).toBe("13000000");
    const bs = await srv.call("GET", "/api/reports/balance-sheet?asOf=2026-12-31", { token: acct });
    expect(bs.body.balanced).toBe(true);
  });

  it("is blocked when retained earnings is missing", async () => {
    await year2026();
    await prisma.account.update({ where: { id: ids["3200"] }, data: { isActive: false } });
    const preview = await srv.call("GET", "/api/year-end/2026/preview", { token: admin });
    expect(preview.body.canClose).toBe(false);
    expect(preview.body.blockers.join(" ")).toMatch(/3200/);
  });

  it("a year with no revenue or expenses still locks its periods", async () => {
    await book("2026-03-10", "1110", "3100", "100000");
    const res = await srv.call("POST", "/api/year-end/2026/close", { token: admin });
    expect(res.status).toBe(200);
    expect(res.body.entryNo).toBeNull();
    expect(await prisma.accountingPeriod.count({ where: { period: { startsWith: "2026-" }, status: "CLOSED" } })).toBe(12);
  });

  it("rejects a nonsense year", async () => {
    expect((await srv.call("POST", "/api/year-end/1800/close", { token: admin })).status).toBe(400);
  });
});

describe("Excel export", () => {
  async function load(buffer: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    return wb.worksheets[0];
  }

  it("trial balance: real numeric cells that match the report", async () => {
    await year2026();
    const res = await srv.raw("/api/reports/trial-balance.xlsx?asOf=2026-12-31", acct);
    expect(res.status).toBe(200);
    expect(res.type).toContain("spreadsheetml.sheet");
    expect(res.disposition).toContain("trial-balance-2026-12-31.xlsx");
    const ws = await load(res.buffer);
    const rows: Record<string, ExcelJS.CellValue[]> = {};
    ws.eachRow((r) => {
      const v = r.values as ExcelJS.CellValue[];
      if (typeof v[1] === "string") rows[v[1]] = v;
    });
    expect(rows["1110"][3]).toBe(100_000_000 / 100 - 120_000 - 50_000); // 830,000.00 THB, a number not text
    expect(typeof rows["1110"][3]).toBe("number");
    expect(rows["3100"][4]).toBe(1_000_000);
    let total: ExcelJS.Row | undefined;
    ws.eachRow((r) => {
      if (r.getCell(2).value === "Total") total = r;
    });
    expect(total!.getCell(3).value).toBe(total!.getCell(4).value); // debit total = credit total
  });

  it("income statement and balance sheet export too", async () => {
    await year2026();
    const is = await srv.raw("/api/reports/income-statement.xlsx?from=2026-01-01&to=2026-12-31", acct);
    expect(is.status).toBe(200);
    const isSheet = await load(is.buffer);
    let net: ExcelJS.CellValue = null;
    isSheet.eachRow((r) => {
      if (r.getCell(2).value === "Net income") net = r.getCell(3).value;
    });
    expect(net).toBe(130_000);

    const bs = await srv.raw("/api/reports/balance-sheet.xlsx?asOf=2026-12-31", acct);
    expect(bs.status).toBe(200);
    expect(bs.disposition).toContain("balance-sheet-2026-12-31.xlsx");
  });

  it("needs a valid session", async () => {
    expect((await srv.raw("/api/reports/trial-balance.xlsx", "garbage")).status).toBe(401);
  });
});
