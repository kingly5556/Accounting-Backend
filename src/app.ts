import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
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

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

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
const frontendDist =
  process.env.FRONTEND_DIST ?? path.resolve(__dirname, "../../Accounting-Frontend/dist");
app.use(express.static(frontendDist));
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.use(errorHandler);
