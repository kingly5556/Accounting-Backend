import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";
import type { SessionPayload } from "./types.js";

const encoder = new TextEncoder();

// Must match this module's `key` in ERPHUB's src/config/modules.json.
const MODULE_KEY = "accounting";

function getSecretKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return encoder.encode(secret);
}

function isSessionPayload(payload: unknown): payload is SessionPayload {
  const p = payload as Partial<SessionPayload>;
  return (
    typeof p.sub === "string" &&
    typeof p.username === "string" &&
    Array.isArray(p.roles) &&
    Array.isArray(p.allowedModules)
  );
}

// Verify-only: this module never issues tokens, it only checks ones ERPHUB
// already signed and forwarded as `Authorization: Bearer <jwt>`. See
// AGENTS.md — no login/session store belongs in this codebase.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = header.slice("Bearer ".length);

  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (!isSessionPayload(payload)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!payload.allowedModules.includes(MODULE_KEY)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const hasRole = req.user.roles.some((role) => allowedRoles.includes(role));
    if (!hasRole) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}
