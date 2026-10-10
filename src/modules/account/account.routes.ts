import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from "./account.service.js";

export const accountRouter = Router();
accountRouter.use(requireAuth);

const typeEnum = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);

const createSchema = z.object({
  code: z.string().regex(/^\d{3,10}$/, "code must be 3-10 digits"),
  name: z.string().trim().min(1),
  type: typeEnum,
  parentId: z.string().nullish(),
  isPostable: z.boolean().optional(),
});

const patchSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

const canEdit = requireRole("Accountant", "Admin");

accountRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await listAccounts());
}));

accountRouter.get("/:id", asyncHandler(async (req, res) => {
  res.json(await getAccount(req.params.id));
}));

accountRouter.post("/", canEdit, asyncHandler(async (req, res) => {
  res.status(201).json(await createAccount(createSchema.parse(req.body)));
}));

accountRouter.patch("/:id", canEdit, asyncHandler(async (req, res) => {
  res.json(await updateAccount(req.params.id, patchSchema.parse(req.body)));
}));

accountRouter.delete("/:id", canEdit, asyncHandler(async (req, res) => {
  await deleteAccount(req.params.id);
  res.status(204).end();
}));
