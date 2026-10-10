import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { generalLedger, trialBalance } from "./reporting.service.js";

export const reportingRouter = Router();
reportingRouter.use(requireAuth);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must look like 2026-10-15");

function todayBangkok(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

reportingRouter.get("/trial-balance", asyncHandler(async (req, res) => {
  const { asOf } = z.object({ asOf: day.optional() }).parse(req.query);
  res.json(await trialBalance(asOf ?? todayBangkok()));
}));

reportingRouter.get("/general-ledger/:accountId", asyncHandler(async (req, res) => {
  const q = z.object({ from: day.optional(), to: day.optional() }).parse(req.query);
  const to = q.to ?? todayBangkok();
  const from = q.from ?? `${to.slice(0, 7)}-01`;
  res.json(await generalLedger(req.params.accountId, from, to));
}));
