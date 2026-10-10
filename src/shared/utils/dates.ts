import { AppError } from "../middleware/error-handler.js";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "2026-10-15" -> 00:00 Bangkok on that day, as an instant. */
export function startOfBangkokDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new AppError(400, "Date must look like 2026-10-15");
  }
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d) - BANGKOK_OFFSET_MS);
  if (Number.isNaN(date.getTime())) throw new AppError(400, "Invalid date");
  return date;
}

/** Exclusive upper bound that includes the whole of `day` (Bangkok). */
export function endOfBangkokDayExclusive(day: string): Date {
  return new Date(startOfBangkokDay(day).getTime() + 24 * 60 * 60 * 1000);
}
