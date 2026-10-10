import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { endOfBangkokDayExclusive, startOfBangkokDay } from "../../shared/utils/dates.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import {
  createDraft,
  deleteDraft,
  getEntry,
  listEntries,
  postEntry,
  reverseEntry,
  updateDraft,
} from "./journal.service.js";

export const journalRouter = Router();
journalRouter.use(requireAuth);

// Amounts are satang. Accept integer strings (safe above 2^53) or non-negative integers.
const satang = z
  .union([z.string().regex(/^\d+$/, "amount must be a whole number of satang"), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must look like 2026-10-15");

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: satang.default("0"),
  credit: satang.default("0"),
  memo: z.string().nullish(),
});

const entrySchema = z.object({
  entryDate: dateString,
  description: z.string().trim().min(1),
  lines: z.array(lineSchema).min(2),
});

const canWrite = requireRole("Accountant", "Admin");

// A date typed by a user means "that day in Bangkok". Noon keeps it unambiguous
// on the right day and inside the right month whatever the display timezone.
function entryInstant(day: string): Date {
  return new Date(startOfBangkokDay(day).getTime() + 12 * 60 * 60 * 1000);
}

journalRouter.get("/", asyncHandler(async (req, res) => {
  const q = z
    .object({
      status: z.enum(["DRAFT", "POSTED", "REVERSED"]).optional(),
      from: dateString.optional(),
      to: dateString.optional(),
      origin: z.enum(["manual", "system"]).optional(),
    })
    .parse(req.query);
  res.json(
    await listEntries({
      status: q.status,
      origin: q.origin,
      from: q.from ? startOfBangkokDay(q.from) : undefined,
      toExclusive: q.to ? endOfBangkokDayExclusive(q.to) : undefined,
    })
  );
}));

journalRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json(await getEntry(req.params.id));
}));

journalRouter.post("/", canWrite, asyncHandler(async (req, res) => {
  const input = entrySchema.parse(req.body);
  const entry = await createDraft(
    { entryDate: entryInstant(input.entryDate), description: input.description, lines: input.lines },
    req.user!.sub
  );
  res.status(201).json(entry);
}));

journalRouter.patch("/:id", canWrite, asyncHandler(async (req, res) => {
  const input = entrySchema.parse(req.body);
  res.json(
    await updateDraft(req.params.id, {
      entryDate: entryInstant(input.entryDate),
      description: input.description,
      lines: input.lines,
    })
  );
}));

journalRouter.delete("/:id", canWrite, asyncHandler(async (req, res) => {
  await deleteDraft(req.params.id);
  res.status(204).end();
}));

journalRouter.post("/:id/post", canWrite, asyncHandler(async (req, res) => {
  res.json(await postEntry(req.params.id, req.user!.sub));
}));

journalRouter.post("/:id/reverse", canWrite, asyncHandler(async (req, res) => {
  const body = z.object({ entryDate: dateString.optional() }).parse(req.body ?? {});
  res.status(201).json(
    await reverseEntry(req.params.id, req.user!.sub, body.entryDate ? entryInstant(body.entryDate) : undefined)
  );
}));
