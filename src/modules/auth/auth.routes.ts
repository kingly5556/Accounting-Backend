import { Router } from "express";
import { requireAuth } from "./auth.middleware.js";

export const authRouter = Router();

// Lets the SPA hide buttons the caller cannot use (it cannot read the httpOnly
// cookie itself). UX only — every endpoint still enforces roles on its own.
authRouter.get("/me", requireAuth, (req, res) => {
  const { username, roles } = req.user!;
  res.json({ username, roles });
});
