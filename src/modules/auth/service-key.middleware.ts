import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Service-to-service auth for POST /api/postings (Stock's outbox worker).
// Deliberately separate from requireAuth: no user JWT is involved, and no other
// route accepts this key. Fails closed — if the key is not configured, nothing passes.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function requireServiceKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ACCOUNTING_SERVICE_KEY;
  const provided = req.headers["x-service-key"];
  if (!expected || typeof provided !== "string") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Hash both sides so the comparison is constant-time regardless of length.
  if (!timingSafeEqual(digest(provided), digest(expected))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}
