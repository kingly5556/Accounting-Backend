// Accounting periods are calendar months in Thailand time (UTC+7, no DST), not UTC.
// A goods receipt at 00:30 on the 1st (Bangkok) belongs to the new month.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function periodOf(date: Date): string {
  const local = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** First instant (00:00 Bangkok) of the month after `period` ("2026-10" -> 1 Nov 2026). */
export function startOfNextPeriod(period: string): Date {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1) - BANGKOK_OFFSET_MS);
}

export function startOfPeriod(period: string): Date {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - BANGKOK_OFFSET_MS);
}

export function isValidPeriod(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
