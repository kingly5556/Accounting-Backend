import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/shared/database/prisma.js";
import { resetDb, seedChart, tokenFor } from "./helpers.js";
import { startServer, type TestServer } from "./server.js";

let srv: TestServer;
let ids: Record<string, string>;
let acct: string;

const KEY = { "X-Service-Key": "test-service-key" };

const goodsReceived = (id: string, amountSatang: string | number, occurredAt = "2026-10-10T05:00:00.000Z") => ({
  topic: "GOODS_RECEIVED",
  payload: { version: 1, occurredAt, goodsReceiptId: id, poId: `po-${id}`, poNumber: "PO-2026-00002", amountSatang },
});

const adjustment = (movementId: string, direction: "INCREASE" | "DECREASE", amountSatang: number, reason = "stock count") => ({
  topic: "STOCK_ADJUSTED",
  payload: { version: 1, occurredAt: "2026-10-10T05:00:00.000Z", movementId, productId: "p1", direction, quantity: 2, reason, amountSatang },
});

const send = (body: unknown, headers: Record<string, string> = KEY) => srv.call("POST", "/api/postings", { body, headers });

beforeAll(async () => {
  srv = await startServer();
  acct = await tokenFor(["Accountant"]);
});
afterAll(async () => {
  await srv.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  ids = await seedChart();
});

describe("service-to-service auth", () => {
  it("401 without a key, with a wrong key, or with a user JWT instead", async () => {
    expect((await send(goodsReceived("g1", 100), {})).status).toBe(401);
    expect((await send(goodsReceived("g1", 100), { "X-Service-Key": "nope" })).status).toBe(401);
    expect((await srv.call("POST", "/api/postings", { token: acct, body: goodsReceived("g1", 100) })).status).toBe(401);
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("the service key does not open any user endpoint", async () => {
    expect((await srv.call("GET", "/api/accounts", { headers: KEY })).status).toBe(401);
    expect((await srv.call("POST", "/api/journal-entries", { headers: KEY, body: {} })).status).toBe(401);
  });
});

describe("GOODS_RECEIVED", () => {
  it("books Dr 1300 / Cr 2150 as a POSTED entry created by system:stock", async () => {
    const res = await send(goodsReceived("g1", 3_000_000)); // 60 x 500 THB
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.entryNo).toBe("JE-2026-10-0001");

    const e = await srv.call("GET", `/api/journal-entries/${res.body.entryId}`, { token: acct });
    expect(e.body.status).toBe("POSTED");
    expect(e.body.createdBy).toBe("system:stock");
    expect(e.body.sourceModule).toBe("stock");
    expect(e.body.sourceRef).toMatchObject({ poId: "po-g1" });
    const byCode = Object.fromEntries(e.body.lines.map((l: any) => [l.account.code, l]));
    expect(byCode["1300"].debit).toBe("3000000");
    expect(byCode["2150"].credit).toBe("3000000");
  });

  it("is idempotent: the same event twice yields one entry, then the same answer", async () => {
    const first = await send(goodsReceived("g1", 500));
    const second = await send(goodsReceived("g1", 500));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.entryId).toBe(first.body.entryId);
    expect(await prisma.journalEntry.count()).toBe(1);
  });

  it("is idempotent under concurrency (5 identical events at once)", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => send(goodsReceived("g1", 500))));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.entryId)).size).toBe(1);
    expect(await prisma.journalEntry.count()).toBe(1);
  });
});

describe("STOCK_ADJUSTED", () => {
  it("decrease -> Dr 5200 / Cr 1300; increase -> Dr 1300 / Cr 5200", async () => {
    const dec = await send(adjustment("m1", "DECREASE", 6000));
    const inc = await send(adjustment("m2", "INCREASE", 2500));
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-31", { token: acct });
    const row = (code: string) => tb.body.accounts.find((a: any) => a.code === code);
    expect(dec.status).toBe(201);
    expect(inc.status).toBe(201);
    expect(row("5200").debitBalance).toBe("3500"); // 6000 loss - 2500 gain
    expect(row("1300").creditBalance).toBe("3500");
    expect(tb.body.balanced).toBe(true);
  });

  it("two adjustments with the same free-text reason are two entries (keyed by movement id)", async () => {
    const a = await send(adjustment("m1", "DECREASE", 100, "count"));
    const b = await send(adjustment("m2", "DECREASE", 100, "count"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.entryId).not.toBe(b.body.entryId);
    expect(await prisma.journalEntry.count()).toBe(2);
  });
});

describe("validation (all permanent 4xx — the sender must not retry)", () => {
  it("422 when a mapped account does not exist", async () => {
    await prisma.account.delete({ where: { id: ids["2150"] } });
    const res = await send(goodsReceived("g1", 500));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/2150/);
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("422 when a mapped account is inactive", async () => {
    await prisma.account.update({ where: { id: ids["1300"] }, data: { isActive: false } });
    expect((await send(goodsReceived("g1", 500))).status).toBe(422);
  });

  it("400 for zero/negative amounts, unknown topics and unknown versions", async () => {
    expect((await send(goodsReceived("g1", 0))).status).toBe(400);
    expect((await send(goodsReceived("g1", -5))).status).toBe(400);
    expect((await send({ topic: "NOPE", payload: {} })).status).toBe(400);
    const v2 = goodsReceived("g1", 5);
    (v2.payload as any).version = 2;
    expect((await send(v2)).status).toBe(400);
  });

  it("books amounts above int32", async () => {
    const res = await send(goodsReceived("g1", "9000000000000"));
    expect(res.status).toBe(201);
    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-31", { token: acct });
    expect(tb.body.totalDebit).toBe("9000000000000");
  });
});

describe("periods and time zone", () => {
  it("uses Bangkok time: 2026-10-31T17:30Z (1 Nov 00:30 in Bangkok) lands in 2026-11", async () => {
    const res = await send(goodsReceived("g1", 500, "2026-10-31T17:30:00.000Z"));
    expect(res.body.entryNo).toBe("JE-2026-11-0001");
  });

  it("never refuses an event for a closed period: moves it to the next open one and says so", async () => {
    await srv.call("POST", "/api/periods/2026-10/close", { token: await tokenFor(["Admin"]) });
    const res = await send(goodsReceived("g1", 500, "2026-10-12T05:00:00.000Z"));
    expect(res.status).toBe(201);
    expect(res.body.entryNo).toBe("JE-2026-11-0001");
    const e = await srv.call("GET", `/api/journal-entries/${res.body.entryId}`, { token: acct });
    expect(e.body.description).toMatch(/actual date 2026-10/);
    expect(e.body.lines[0].memo).toMatch(/2026-10-12/);
  });

  it("skips several consecutive closed periods", async () => {
    const admin = await tokenFor(["Admin"]);
    await srv.call("POST", "/api/periods/2026-10/close", { token: admin });
    await srv.call("POST", "/api/periods/2026-11/close", { token: admin });
    const res = await send(goodsReceived("g1", 500, "2026-10-12T05:00:00.000Z"));
    expect(res.body.entryNo).toBe("JE-2026-12-0001");
  });
});

describe("reversing an automatic entry", () => {
  it("reversal carries no source fields; the original keeps its idempotency key", async () => {
    const posted = await send(goodsReceived("g1", 500));
    const rev = await srv.call("POST", `/api/journal-entries/${posted.body.entryId}/reverse`, { token: acct, body: {} });
    expect(rev.status).toBe(201);
    expect(rev.body.sourceModule).toBeNull();
    expect(rev.body.sourceId).toBeNull();

    // Replaying the event still returns the original — it is not booked a second time.
    const replay = await send(goodsReceived("g1", 500));
    expect(replay.status).toBe(200);
    expect(replay.body.entryId).toBe(posted.body.entryId);
    expect(await prisma.journalEntry.count()).toBe(2);
  });
});

describe("reconciliation with the Stock module's events", () => {
  it("account 1300 equals the sum of event values since cut-over (opening + receipts - decreases + increases)", async () => {
    const opening = { topic: "OPENING_BALANCE", payload: { version: 1, occurredAt: "2026-10-01T05:00:00.000Z", asOf: "2026-10-01", amountSatang: 1_000_000 } };
    expect((await send(opening)).status).toBe(201);
    expect((await send(opening)).status).toBe(200); // cut-over script is re-runnable

    const events = [
      goodsReceived("g1", 3_000_000),
      goodsReceived("g2", 450_000),
      adjustment("m1", "DECREASE", 6_000),
      adjustment("m2", "INCREASE", 1_500),
    ];
    for (const e of events) expect([200, 201]).toContain((await send(e)).status);
    for (const e of events) expect((await send(e)).status).toBe(200); // outbox retries replay everything

    const expected = 1_000_000n + 3_000_000n + 450_000n - 6_000n + 1_500n;
    const gl = await srv.call("GET", `/api/reports/general-ledger/${ids["1300"]}?from=2026-10-01&to=2026-10-31`, { token: acct });
    expect(gl.body.closingBalance).toBe(expected.toString());

    const tb = await srv.call("GET", "/api/reports/trial-balance?asOf=2026-10-31", { token: acct });
    expect(tb.body.balanced).toBe(true);
    // Every event produced exactly one entry (1:1 with source ids).
    expect(await prisma.journalEntry.count({ where: { sourceModule: "stock" } })).toBe(5);
  });
});
