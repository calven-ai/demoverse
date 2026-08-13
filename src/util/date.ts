/** Minimal ISO-date helpers (no external deps). Dates are `YYYY-MM-DD` strings. */

export type ISODate = string;

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function parseISODate(s: ISODate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

export function addDays(s: ISODate, days: number): ISODate {
  const d = parseISODate(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

export function addWeeks(s: ISODate, weeks: number): ISODate {
  return addDays(s, weeks * 7);
}

export function addMonths(s: ISODate, months: number): ISODate {
  const d = parseISODate(s);
  d.setUTCMonth(d.getUTCMonth() + months);
  return toISODate(d);
}

/** Whole days from a to b (b - a). Negative if b is before a. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86400000);
}

export function isBefore(a: ISODate, b: ISODate): boolean {
  return parseISODate(a).getTime() < parseISODate(b).getTime();
}

export function minISO(a: ISODate, b: ISODate): ISODate {
  return isBefore(a, b) ? a : b;
}

/** Today's real date as ISO (UTC). */
export function todayISO(): ISODate {
  return toISODate(new Date());
}
