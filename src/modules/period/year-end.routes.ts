import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { closeYear, previewYearEnd } from "./year-end.service.js";

// Year-end close is Admin-only, like closing a single period.
export const yearEndRouter = Router();
yearEndRouter.use(requireAuth, requireRole("Admin"));

const yearParam = z.coerce.number().int();

yearEndRouter.get("/:year/preview", asyncHandler(async (req, res) => {
  res.json(await previewYearEnd(yearParam.parse(req.params.year)));
}));

yearEndRouter.post("/:year/close", asyncHandler(async (req, res) => {
  res.json(await closeYear(yearParam.parse(req.params.year), req.user!.sub));
}));
