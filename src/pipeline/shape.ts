/**
 * Per-deal SHAPE: how long a deal runs, and whether it goes quiet partway.
 *
 * Cycle length used to be a flat uniform draw over `avg_sales_cycle_weeks`.
 * Because stages are derived from elapsed fraction, that made every deal of
 * four weeks or more produce an identical stage history: five of the seven
 * possible lengths were structurally indistinguishable, and nothing ever landed
 * outside the band. A pipeline with no tails reads as generated, for the same
 * reason uniform diligence does.
 *
 * So a deal now draws an ARCHETYPE first. Most are `standard` and sit
 * triangularly inside the configured band, peaking at its midpoint. The rest
 * are the edge cases every real pipeline carries:
 *
 *   fast     warm inbound, closes in a week or two, leaves barely a trail
 *   slog     the enterprise grind, a quarter of security review and procurement
 *   stalled  goes dark mid-cycle, earning nothing for weeks, then resumes
 *
 * `stalled` is modeled as a PAUSE IN THE STAGE CLOCK rather than as new
 * branching logic. Since touch points are only ever planted when a deal ENTERS
 * a stage, freezing the clock is exactly what going dark looks like: several
 * consecutive periods in the same stage with no artifacts at all.
 *
 * Determinism contract: everything here is a pure function of
 * `(world.seed, oppId, cfg)`, drawn from a FRESH rng stream salted `|pace|`.
 * That is what lets `backfillStageHistory` replay a deal's schedule and get
 * byte-identical results. Never make shape depend on period, ledger order, or
 * anything else that a replay cannot reconstruct.
 */

import { Rng } from "../util/rng.js";
import type { Config } from "../config/schema.js";
import type { World } from "../ledger/schema.js";
import { openStages, stageForFraction } from "./stages.js";

export type DealArchetype = "standard" | "fast" | "slog" | "stalled";

export interface DealShape {
  archetype: DealArchetype;
  /** Weeks of actual selling. Excludes any stall. */
  cycleWeeks: number;
  /** Silent weeks inserted mid-cycle. Zero for everything but `stalled`. */
  stallWeeks: number;
  /** Open-stage index the silence follows. Meaningless when `stallWeeks` is 0. */
  stallAfterIdx: number;
}

/** Total calendar weeks from creation to close, stall included. */
export function totalWeeks(shape: DealShape): number {
  return shape.cycleWeeks + shape.stallWeeks;
}

/**
 * A `fast` deal is deliberately THIN: it closes before a normal buying process
 * could leave a paper trail, so the planners skip its optional touch points and
 * it lands roughly two artifacts in total rather than two per week.
 */
export function isThin(shape: DealShape): boolean {
  return shape.archetype === "fast";
}

/** Deterministic per-deal shape. Pure in (seed, oppId, cfg). */
export function dealShape(world: World, cfg: Config, oppId: string): DealShape {
  const rng = new Rng(`${world.seed}|pace|${oppId}`);
  const pipeline = cfg.world.pipeline;
  const outliers = pipeline.cycle_outliers;
  const [lo, hi] = pipeline.avg_sales_cycle_weeks;
  // The band's midpoint is the mode: common in the middle, rare at the edges.
  const mode = Math.round((lo + hi) / 2);
  const body = (): number => (hi <= lo ? lo : rng.triangular(lo, mode, hi));

  // Key order is part of the determinism contract: `weighted` walks the entries
  // in insertion order, so never reorder these.
  const standardRate = Math.max(0, 1 - outliers.fast.rate - outliers.slog.rate - outliers.stalled.rate);
  const weights = {
    standard: standardRate,
    fast: outliers.fast.rate,
    slog: outliers.slog.rate,
    stalled: outliers.stalled.rate,
  };
  // Every rate at 0 (an operator switching all edge cases off) would make
  // `weighted` throw, so fall back to the plain body draw.
  const archetype: DealArchetype = standardRate >= 1 ? "standard" : (rng.weighted(weights) as DealArchetype);

  let cycleWeeks: number;
  let stallWeeks = 0;
  let stallAfterIdx = 0;

  switch (archetype) {
    case "fast":
      cycleWeeks = rng.int(outliers.fast.weeks[0], outliers.fast.weeks[1]);
      break;
    case "slog":
      cycleWeeks = rng.int(outliers.slog.weeks[0], outliers.slog.weeks[1]);
      break;
    case "stalled": {
      cycleWeeks = body();
      stallWeeks = rng.int(outliers.stalled.stall_weeks[0], outliers.stalled.stall_weeks[1]);
      // Deals go quiet after the buyer has engaged, not on the first call, so
      // the pause lands somewhere from the end of Evaluation onward.
      const n = openStages(cfg).length;
      stallAfterIdx = n > 1 ? rng.int(1, n - 1) : 0;
      break;
    }
    default:
      cycleWeeks = body();
  }

  return { archetype, cycleWeeks: Math.max(1, cycleWeeks), stallWeeks, stallAfterIdx };
}

/**
 * The stage a deal is in `elapsedDays` after creation, given its total `spanDays`.
 *
 * Replaces a bare `stageForFraction(elapsed / span)`: the stall window is
 * subtracted so a stalled deal's clock freezes, holding it in one stage while
 * the calendar keeps moving. With `stallWeeks === 0` this is exactly the old
 * behavior, which is what keeps every non-stalled deal replayable as before.
 */
export function stageForElapsed(
  cfg: Config,
  elapsedDays: number,
  spanDays: number,
  shape: DealShape,
): string {
  const stages = openStages(cfg);
  const stallDays = shape.stallWeeks * 7;
  const activeDays = Math.max(1, spanDays - stallDays);

  let activeElapsed = elapsedDays;
  if (stallDays > 0) {
    // Where the silence begins, measured in SELLING time: the point at which
    // the deal has finished the stage it goes quiet after.
    const pauseAt = Math.round((activeDays * (shape.stallAfterIdx + 1)) / stages.length);
    if (elapsedDays > pauseAt) {
      activeElapsed = elapsedDays <= pauseAt + stallDays ? pauseAt : elapsedDays - stallDays;
    }
  }

  return stageForFraction(stages, activeElapsed / activeDays);
}
