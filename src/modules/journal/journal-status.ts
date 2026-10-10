import type { JournalStatus } from "@prisma/client";
import { AppError } from "../../shared/middleware/error-handler.js";

// Explicit allow-list. A posted entry may only ever move POSTED -> REVERSED
// (a status flip, enforced again by a DB trigger). Nothing else changes it.
const ALLOWED: Record<JournalStatus, JournalStatus[]> = {
  DRAFT: ["POSTED"],
  POSTED: ["REVERSED"],
  REVERSED: [],
};

export function assertTransition(current: JournalStatus, next: JournalStatus): void {
  if (!ALLOWED[current].includes(next)) {
    throw new AppError(409, `Cannot move journal entry from ${current} to ${next}`);
  }
}
