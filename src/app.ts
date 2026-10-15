import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { prisma } from "./shared/database/prisma.js";
import { errorHandler } from "./shared/middleware/error-handler.js";
import { accountRouter } from "./modules/account/account.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { journalRouter } from "./modules/journal/journal.routes.js";
import { periodRouter } from "./modules/period/period.routes.js";
import { yearEndRouter } from "./modules/period/year-end.routes.js";
import { postingsRouter } from "./modules/posting-rules/postings.routes.js";
import { reportingRouter } from "./modules/reporting/reporting.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// JSON cannot carry bigint: ledger amounts (satang) go out as strings so nothing
// is ever squeezed through a lossy Number.
app.set("json replacer", (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value
);

// No CORS: browsers only ever talk to ERPHUB (same origin), which calls this API
// server-to-server; the Stock worker calls /api/postings server-to-server too.
app.use(express.json());

// /health          -> process is up (cheap; used by Render's health check)
// /health?deep=1   -> also runs SELECT 1, which wakes a sleeping Neon database
// `commit` shows which build is running (Render sets RENDER_GIT_COMMIT).
app.get("/health", async (req, res) => {
  const commit = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local";
  if (req.query.deep !== "1") return res.json({ ok: true, commit });
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, db: "ok", commit });
  } catch {
    return res.status(503).json({ ok: false, db: "down", commit });
  }
});

// All API routes live under /api/* so they never collide with the SPA's own client
// routes. Mounted at the root here; ERPHUB's proxy puts this behind /erp/accounting/...
app.use("/api", authRouter);
app.use("/api/accounts", accountRouter);
app.use("/api/journal-entries", journalRouter);
app.use("/api/periods", periodRouter);
app.use("/api/year-end", yearEndRouter);
app.use("/api/reports", reportingRouter);
// Service-to-service (X-Service-Key), not a user endpoint.
app.use("/api/postings", postingsRouter);

// Serve the built SPA from the sibling Accounting-Frontend repo (override with
// FRONTEND_DIST). Anything that is not /health or /api/* falls through to index.html.
// Resolved to an absolute path: res.sendFile() rejects relative paths, and on Render
// FRONTEND_DIST is the relative "frontend/dist" (resolved against the working directory).
const frontendDist = path.resolve(
  process.env.FRONTEND_DIST ?? path.resolve(__dirname, "../../Accounting-Frontend/dist")
);
// Vite puts content-hashed bundles in /assets, so they can be cached for a week;
// index.html must always be revalidated so a new deploy is picked up.
app.use("/assets", express.static(path.join(frontendDist, "assets"), { maxAge: "7d", immutable: true }));
app.use(express.static(frontendDist, { maxAge: 0 }));
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.use(errorHandler);
