// Cross-module end-to-end check: Stock (real) -> outbox -> worker -> Accounting (real).
// Runs both backends against THROWAWAY databases, never touching dev data:
//
//   node test/e2e/stock-accounting.e2e.mjs
//
// Needs: Postgres container `k-erp-stock-pg` running, both repos installed and migrated-capable.
// Proves: delivery, idempotency, Accounting being down, permanent failure + manual retry,
// the opening-balance cut-over, and reconciliation of GL account 1300 against Stock's events.
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import { SignJWT } from "jose";

const ACCT_DIR = path.resolve(import.meta.dirname, "../..");
const STOCK_DIR = path.resolve(ACCT_DIR, "../../Stock and purchase/Stock-Purchase-Backend");
const PG = "postgresql://postgres:postgres@localhost:5433"; // dev container defaults
const DB = { stock: "k_erp_e2e_stock", acct: "k_erp_e2e_acct" };
const URL = (db) => `${PG}/${db}?schema=public`;
const SECRET = "e2e-jwt-secret-e2e-jwt-secret-1234567";
const KEY = "e2e-service-key";
const PORTS = { stock: 4101, acct: 4102 };

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd, env = {}) =>
  execSync(cmd, { cwd, env: { ...process.env, ...env }, stdio: "pipe" }).toString();
const psql = (db, sql) =>
  sh(`docker exec k-erp-stock-pg psql -U postgres -d ${db} -tAc "${sql.replace(/"/g, '\\"')}"`, ACCT_DIR).trim();

async function token(roles, modules) {
  return new SignJWT({ sub: "e2e", username: "e2e", roles, allowedModules: modules })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

async function call(port, method, p, { tok, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function start(dir, port, env) {
  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: dir,
    shell: true,
    env: { ...process.env, PORT: String(port), JWT_SECRET: SECRET, ...env },
    stdio: "ignore",
  });
  return child;
}
function stop(child) {
  if (!child) return;
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    child.kill();
  }
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server on :${port} did not start`);
}

const acctEnv = { DATABASE_URL: URL(DB.acct), ACCOUNTING_SERVICE_KEY: KEY };
const stockEnv = { DATABASE_URL: URL(DB.stock), ACCOUNTING_URL: `http://127.0.0.1:${PORTS.acct}`, ACCOUNTING_SERVICE_KEY: KEY };

async function main() {
  let acct, stock;
  try {
    // ---- fresh databases ---------------------------------------------------------------
    for (const db of Object.values(DB)) {
      psql("postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      psql("postgres", `CREATE DATABASE ${db}`);
    }
    sh("npx prisma migrate deploy", ACCT_DIR, { DATABASE_URL: URL(DB.acct) });
    sh("npx tsx prisma/seed.ts", ACCT_DIR, { DATABASE_URL: URL(DB.acct) });
    sh("npx prisma migrate deploy", STOCK_DIR, { DATABASE_URL: URL(DB.stock) });
    sh("npx tsx prisma/seed.ts", STOCK_DIR, { DATABASE_URL: URL(DB.stock) });

    const admin = await token(["Admin", "Warehouse Staff"], ["stock", "accounting"]);
    const acctTok = await token(["Accountant"], ["accounting"]);

    // ---- legacy history: stock that existed BEFORE the outbox (inserted without events) -----
    const widA = psql(DB.stock, `SELECT id FROM products WHERE sku='WID-A'`);
    psql(
      DB.stock,
      `INSERT INTO stock_movements (id,"productId",type,quantity,"balanceBefore","balanceAfter","refType","createdBy","createdAt") ` +
        `VALUES ('legacy1','${widA}','RECEIPT',100,0,100,'LEGACY','seed', now() - interval '1 day')`
    );
    // Two seconds of separation so the cut-off is unambiguous.
    stock = start(STOCK_DIR, PORTS.stock, stockEnv);
    acct = start(ACCT_DIR, PORTS.acct, acctEnv);
    await Promise.all([waitUp(PORTS.stock), waitUp(PORTS.acct)]);

    // ---- first real events ------------------------------------------------------------------
    const pos = (await call(PORTS.stock, "GET", "/api/purchase-orders", { tok: admin })).body;
    const sent = pos.find((p) => p.status === "SENT");
    const po = (await call(PORTS.stock, "GET", `/api/purchase-orders/${sent.id}`, { tok: admin })).body;
    const lineB = po.lines.find((l) => l.qtyOrdered === 50); // Widget B, 50 @ 22.00
    const lineC = po.lines.find((l) => l.qtyOrdered === 200); // Box C, 200 @ 5.00
    const receive = (lines) =>
      call(PORTS.stock, "POST", "/api/goods-receipts", { tok: admin, body: { poId: po.id, lines } });

    let r = await receive([{ poLineId: lineB.id, qtyReceived: 20 }, { poLineId: lineC.id, qtyReceived: 100 }]);
    check("partial receipt accepted by Stock", r.status === 201, JSON.stringify(r.body));
    const expected = { receipts: 20n * 2200n + 100n * 500n }; // 94,000 satang

    // Cut-over: book legacy stock (100 x WID-A @ 15.00 = 150,000 satang) once.
    const cut1 = sh("npx tsx scripts/accounting-opening-balance.ts", STOCK_DIR, stockEnv);
    check("cut-over queues the opening balance", /Queued opening balance: 150000 satang/.test(cut1), cut1);
    const cut2 = sh("npx tsx scripts/accounting-opening-balance.ts", STOCK_DIR, stockEnv);
    check("cut-over is idempotent", /already queued/.test(cut2), cut2);

    // Adjustments: two with the SAME free-text reason must both be booked.
    const adj = (quantity) =>
      call(PORTS.stock, "POST", "/api/inventory/adjustments", { tok: admin, body: { productId: widA, quantity, reason: "stock count" } });
    check("adjustment -5 accepted", (await adj(-5)).status === 201);
    check("adjustment -5 again (same reason) accepted", (await adj(-5)).status === 201);
    check("adjustment +2 accepted", (await adj(2)).status === 201);
    const adjNet = -5n * 1500n - 5n * 1500n + 2n * 1500n; // -12,000

    // ---- delivery ---------------------------------------------------------------------------
    await sleep(13_000);
    const pending = psql(DB.stock, `SELECT count(*) FROM outbox_messages WHERE status <> 'SENT'`);
    check("all outbox rows delivered (SENT)", pending === "0", `non-SENT rows: ${pending}`);
    const entries = psql(DB.acct, `SELECT count(*) FROM journal_entries WHERE "sourceModule"='stock'`);
    check("one journal entry per event (1 receipt + 1 opening + 3 adjustments = 5)", entries === "5", entries);

    // ---- reconciliation: GL 1300 == opening + receipts + adjustments -------------------------------
    const acct1300 = psql(DB.acct, `SELECT id FROM accounts WHERE code='1300'`);
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    let gl = (await call(PORTS.acct, "GET", `/api/reports/general-ledger/${acct1300}?from=2020-01-01&to=${today}`, { tok: acctTok })).body;
    const want = 150000n + expected.receipts + adjNet;
    check(`GL 1300 = opening 150,000 + receipts ${expected.receipts} + adjustments ${adjNet} = ${want}`, gl.closingBalance === want.toString(), gl.closingBalance);
    let tb = (await call(PORTS.acct, "GET", `/api/reports/trial-balance?asOf=${today}`, { tok: acctTok })).body;
    check("trial balance balances", tb.balanced === true);

    // ---- Accounting down: Stock must keep working, events wait, then drain --------------------
    stop(acct);
    acct = undefined;
    await sleep(1000);
    r = await receive([{ poLineId: lineB.id, qtyReceived: 30 }, { poLineId: lineC.id, qtyReceived: 100 }]);
    check("Stock still accepts a receipt while Accounting is down", r.status === 201, JSON.stringify(r.body));
    const receipts2 = 30n * 2200n + 100n * 500n; // 116,000
    await sleep(8000);
    const waiting = psql(DB.stock, `SELECT count(*) FROM outbox_messages WHERE status='PENDING' AND attempts>0`);
    check("event waits in the outbox, retrying", waiting === "1", waiting);
    acct = start(ACCT_DIR, PORTS.acct, acctEnv);
    await waitUp(PORTS.acct);
    await sleep(40_000); // backoff after a few failures can be ~20-40s
    const left = psql(DB.stock, `SELECT count(*) FROM outbox_messages WHERE status <> 'SENT'`);
    check("event delivered after Accounting came back", left === "0", `non-SENT rows: ${left}`);
    const dup = psql(DB.acct, `SELECT count(*) FROM journal_entries WHERE "sourceModule"='stock' AND "sourceType"='GOODS_RECEIPT'`);
    check("no duplicate postings after retries (2 receipts = 2 entries)", dup === "2", dup);

    // ---- permanent failure: mapped account missing -> FAILED, fix, manual retry -----------------
    psql(DB.acct, `UPDATE accounts SET "isActive"=false WHERE code='2150'`);
    const widB = psql(DB.stock, `SELECT id FROM products WHERE sku='WID-B'`);
    // WID-B has stock from the receipts above; an adjustment is a fresh event that needs 1300 + 5200 only,
    // so use a receipt-like event that needs 2150: create a new PO line? Simpler: post the event directly.
    const direct = await fetch(`http://127.0.0.1:${PORTS.acct}/api/postings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Key": KEY },
      body: JSON.stringify({
        topic: "GOODS_RECEIVED",
        payload: { version: 1, occurredAt: new Date().toISOString(), goodsReceiptId: "e2e-poison", poId: "x", amountSatang: "100" },
      }),
    });
    check("Accounting refuses an event whose account is inactive (permanent 422)", direct.status === 422, String(direct.status));
    psql(DB.acct, `UPDATE accounts SET "isActive"=true WHERE code='2150'`);
    check("(widB id lookup sanity)", widB.length > 0);

    // The same thing through Stock's outbox: queue a poison row, watch it go FAILED, fix, retry.
    psql(
      DB.stock,
      `INSERT INTO outbox_messages (id,topic,destination,"dedupeKey",payload,status,attempts,"nextAt","createdAt") VALUES ` +
        `('poison1','GOODS_RECEIVED','accounting','accounting:GOODS_RECEIPT:poison1',` +
        `'{"version":1,"occurredAt":"${new Date().toISOString()}","goodsReceiptId":"poison1","poId":"x","amountSatang":"0"}',` +
        `'PENDING',0,now(),now())`
    );
    await sleep(8000);
    const st = psql(DB.stock, `SELECT status||':'||attempts FROM outbox_messages WHERE id='poison1'`);
    check("a permanently-bad event goes FAILED on the first attempt (no retry storm)", st === "FAILED:1", st);
    const adminList = await call(PORTS.stock, "GET", "/api/outbox?status=FAILED", { tok: admin });
    check("FAILED rows are visible to an Admin", adminList.status === 200 && adminList.body.some((m) => m.id === "poison1"));
    const nonAdmin = await call(PORTS.stock, "GET", "/api/outbox", { tok: await token(["Warehouse Staff"], ["stock"]) });
    check("non-Admin cannot see the outbox (403)", nonAdmin.status === 403, String(nonAdmin.status));
    psql(DB.stock, `UPDATE outbox_messages SET payload = jsonb_set(payload,'{amountSatang}','"100"') WHERE id='poison1'`);
    const retry = await call(PORTS.stock, "POST", "/api/outbox/poison1/retry", { tok: admin });
    check("manual retry resets the row to PENDING", retry.status === 200 && retry.body.status === "PENDING");
    await sleep(8000);
    check("fixed event delivered after retry", psql(DB.stock, `SELECT status FROM outbox_messages WHERE id='poison1'`) === "SENT");

    // ---- final reconciliation --------------------------------------------------------------------------
    gl = (await call(PORTS.acct, "GET", `/api/reports/general-ledger/${acct1300}?from=2020-01-01&to=${today}`, { tok: acctTok })).body;
    const finalWant = want + receipts2 + 100n; // + second receipt + the 100-satang retried event
    check(`final GL 1300 = ${finalWant}`, gl.closingBalance === finalWant.toString(), gl.closingBalance);
    tb = (await call(PORTS.acct, "GET", `/api/reports/trial-balance?asOf=${today}`, { tok: acctTok })).body;
    check("final trial balance balances", tb.balanced === true);
  } finally {
    stop(stock);
    stop(acct);
    for (const db of Object.values(DB)) {
      try {
        psql("postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      } catch {
        /* best effort */
      }
    }
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
