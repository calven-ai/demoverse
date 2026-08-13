/**
 * Simulation clock (state/clock.json). See DESIGN.md §10.
 *
 * The world advances in periods (default: one week). Each run advances "now" to
 * the real current date, generating the missing period(s). The first run does a
 * historical backfill of ~history_quarters ending today.
 */

import { z } from "zod";
import { repoPath, readJson, writeJson, fileExists } from "./util/fs.js";
import { addWeeks, addMonths, isBefore, todayISO, type ISODate } from "./util/date.js";

const CLOCK_PATH = repoPath("state", "clock.json");

export const ClockSchema = z.object({
  /** Where the simulated world currently is (last fully-generated boundary). */
  simNow: z.string(),
  /** Period granularity. */
  period: z.enum(["week", "month"]),
  /** Count of periods generated so far — used as the deterministic RNG salt. */
  periodIndex: z.number().int().nonnegative(),
  /** The historical start date of the world (simNow at backfill time). */
  startDate: z.string(),
  /** Wall-clock timestamp of the last run (ISO datetime), or null. */
  lastRunAt: z.string().nullable().default(null),
});
export type Clock = z.infer<typeof ClockSchema>;

/** A period the engine needs to generate: (start, end] with its index. */
export interface Period {
  index: number;
  start: ISODate;
  end: ISODate;
}

export function clockPath(): string {
  return CLOCK_PATH;
}

export function loadClock(): Clock {
  if (!fileExists(CLOCK_PATH)) throw new Error("state/clock.json not found. Run `npm run init` first.");
  return ClockSchema.parse(readJson(CLOCK_PATH));
}

export function saveClock(clock: Clock): void {
  writeJson(CLOCK_PATH, ClockSchema.parse(clock));
}

function advanceOne(date: ISODate, period: Clock["period"]): ISODate {
  return period === "week" ? addWeeks(date, 1) : addMonths(date, 1);
}

/**
 * Compute the list of periods to generate to bring `simNow` up to `today`.
 * Does not mutate the clock; the caller advances it after each period is filed.
 */
export function pendingPeriods(clock: Clock, today: ISODate = todayISO()): Period[] {
  const periods: Period[] = [];
  let cursor = clock.simNow;
  let index = clock.periodIndex;
  // Cap to avoid runaway loops if the clock is wildly stale.
  while (isBefore(cursor, today) && periods.length < 520) {
    const end = advanceOne(cursor, clock.period);
    periods.push({ index: index + 1, start: cursor, end });
    cursor = end;
    index += 1;
  }
  return periods;
}

/**
 * Force `count` periods forward from `simNow`, whatever the wall clock says.
 *
 * The world is meant to stay alive between real weeks: the operator runs an
 * increment when they want the pipeline to move, not when the calendar allows
 * it (`npm run pipeline`). Since `simNow` is normally already at today, that
 * means stepping into the near future — a deal created by this run carries a
 * `createdDate` inside the period and closes on its boundary, so the demo org
 * can show records dated a few days ahead. That is the accepted trade: the
 * alternative (re-running the trailing week) cannot progress a single deal,
 * because a deal's stage is a pure function of the elapsed fraction of its
 * cycle and that fraction would not move.
 *
 * `driftWeeks` tells the caller how far ahead of reality the world has run so
 * it can warn; nothing here enforces a limit.
 */
export function forcedPeriods(clock: Clock, count: number): Period[] {
  const periods: Period[] = [];
  let cursor = clock.simNow;
  let index = clock.periodIndex;
  for (let i = 0; i < Math.max(0, count); i++) {
    const end = advanceOne(cursor, clock.period);
    periods.push({ index: index + 1, start: cursor, end });
    cursor = end;
    index += 1;
  }
  return periods;
}

/** Whole periods `simNow` sits ahead of the real calendar (0 when in the past). */
export function driftPeriods(clock: Clock, today: ISODate = todayISO()): number {
  let n = 0;
  let cursor = today;
  while (isBefore(cursor, clock.simNow) && n < 520) {
    cursor = advanceOne(cursor, clock.period);
    n += 1;
  }
  return n;
}
