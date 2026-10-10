import { Router } from "express";
import { asyncHandler } from "../../shared/middleware/error-handler.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { closePeriod, listPeriods } from "./period.service.js";

export const periodRouter = Router();
periodRouter.use(requireAuth);

periodRouter.get("/", asyncHandler(async (_req, res) => {
  res.json(await listPeriods());
}));

// Closing a period is Admin-only.
periodRouter.post("/:period/close", requireRole("Admin"), asyncHandler(async (req, res) => {
  res.json(await closePeriod(req.params.period, req.user!.sub));
}));
