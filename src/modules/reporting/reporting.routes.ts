import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { balanceSheetXlsx, incomeStatementXlsx, trialBalanceXlsx } from "./excel.js";
import { balanceSheet, generalLedger, incomeStatement, trialBalance } from "./reporting.service.js";

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

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function sendXlsx(res: Response, filename: string, data: unknown) {
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(data as ArrayBuffer));
}

reportingRouter.get("/income-statement", asyncHandler(async (req, res) => {
  const q = z.object({ from: day.optional(), to: day.optional() }).parse(req.query);
  const to = q.to ?? todayBangkok();
  res.json(await incomeStatement(q.from ?? `${to.slice(0, 4)}-01-01`, to));
}));

reportingRouter.get("/balance-sheet", asyncHandler(async (req, res) => {
  const { asOf } = z.object({ asOf: day.optional() }).parse(req.query);
  res.json(await balanceSheet(asOf ?? todayBangkok()));
}));

// Excel exports. Plain GETs, so the browser can download them with a normal link and the
// ERPHUB session cookie (no token handling in the SPA).
reportingRouter.get("/trial-balance.xlsx", asyncHandler(async (req, res) => {
  const { asOf } = z.object({ asOf: day.optional() }).parse(req.query);
  const date = asOf ?? todayBangkok();
  sendXlsx(res, `trial-balance-${date}.xlsx`, await trialBalanceXlsx(await trialBalance(date)));
}));

reportingRouter.get("/income-statement.xlsx", asyncHandler(async (req, res) => {
  const q = z.object({ from: day.optional(), to: day.optional() }).parse(req.query);
  const to = q.to ?? todayBangkok();
  const from = q.from ?? `${to.slice(0, 4)}-01-01`;
  sendXlsx(res, `income-statement-${from}_${to}.xlsx`, await incomeStatementXlsx(await incomeStatement(from, to)));
}));

reportingRouter.get("/balance-sheet.xlsx", asyncHandler(async (req, res) => {
  const { asOf } = z.object({ asOf: day.optional() }).parse(req.query);
  const date = asOf ?? todayBangkok();
  sendXlsx(res, `balance-sheet-${date}.xlsx`, await balanceSheetXlsx(await balanceSheet(date)));
}));
