/**
 * Running KPI trajectories (state/trends.json). See DESIGN.md §10–11 + the plan.
 *
 * Trends carry trajectories so curves are intentional, not random. Standing
 * config seeds the baselines; Tier-2 directives reshape them going forward (the
 * agent edits the numeric fields here), and `directiveEffects` is the
 * materialized, auditable record of every directive's effect. Evaluating the
 * trends at a date yields the effective parameters the deterministic generator
 * uses for that period.
 *
 * This module is the engine's TIME-VARIANCE layer. Beyond the original win-rate
 * + competitor-strength ramps it now models, so the dashboards' over-time charts
 * have intentional shape:
 *   • volume ramp:            newOppsPerWeek grows (the velocity story)
 *   • competitor presence:    a competitor shows up in more deals over time
 *   • localized bumps:        a gaussian spike-then-recover on a competitor's
 *                             strength (the "we lose more, then recover" dip)
 *   • industry-weight drift:  a segment grows its share over the year (the
 *                             "emerging off-ICP segment" story)
 *   • per-segment win delta:  a segment converts above/below baseline
 */

import { z } from "zod";
import { repoPath, readJson, writeJson, fileExists } from "./util/fs.js";
import { daysBetween, type ISODate } from "./util/date.js";
import type { Config } from "./config/schema.js";

const TRENDS_PATH = repoPath("state", "trends.json");
const DAYS_PER_QUARTER = 91.3125;

/** A gaussian perturbation centered on a date: amplitude·exp(−((t−center)/width)²). */
const Bump = z.object({
  label: z.string().default(""),
  center: z.string(), // ISO date of the peak
  widthDays: z.number().positive(), // ~1σ in days
  amplitude: z.number(), // signed peak height (added to the base value)
});

export const TrendsSchema = z.object({
  /** ISO date the baselines were seeded from config (null until first seed). */
  seededAt: z.string().nullable().default(null),
  winRate: z.object({
    baseline: z.number().min(0).max(1),
    trendPerQuarter: z.number(),
  }),
  volume: z.object({
    newOppsPerWeek: z.tuple([z.number().int(), z.number().int()]),
    /** Added to both ends of the range per quarter (the velocity ramp). */
    trendPerQuarter: z.number().default(0),
  }),
  /** Per-competitor strength (win bias) + presence (appearance) trajectories. */
  competitors: z.record(
    z.string(),
    z.object({
      strength: z.number().min(0).max(1),
      driftPerQuarter: z.number().default(0),
      /** Appearance weight in sampleCompetitors (defaults to strength at seed). */
      presence: z.number().min(0).default(0.5),
      presenceDriftPerQuarter: z.number().default(0),
      /** Localized spikes on strength (e.g. a mid-year dip-and-recover). */
      strengthBumps: z.array(Bump).default([]),
    }),
  ),
  /** Segment (industry) trajectories. */
  segments: z
    .object({
      /** Added to an industry's base weight (config) per quarter (share drift). */
      industryWeightDriftPerQuarter: z.record(z.string(), z.number()).default({}),
      /** Static additive win-rate delta for deals in this industry. */
      winRateDelta: z.record(z.string(), z.number()).default({}),
    })
    .default({}),
  /**
   * Market-intelligence cohort trajectory (the "win when PMM is
   * involved" story). The cohort SHARE of new opps ramps over time, an emerging
   * expansion opportunity. Seeded from world.yaml market_intelligence; the ramp
   * (shareDriftPerQuarter) is set here. Optional: absent → no MI cohort.
   */
  marketIntelligence: z
    .object({
      shareBaseline: z.number().min(0).max(1),
      shareDriftPerQuarter: z.number().default(0),
      pmmAbsentRate: z.number().min(0).max(1),
    })
    .optional(),
  /** Append-only audit of how each Tier-2/3 directive was materialized here. */
  directiveEffects: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        appliedFrom: z.string(),
        status: z.enum(["active", "superseded"]).default("active"),
        note: z.string(),
      }),
    )
    .default([]),
});
export type Trends = z.infer<typeof TrendsSchema>;

/** The effective parameters for a single period, after evaluating trajectories. */
export interface EffectiveParams {
  winRateTarget: number;
  newOppsPerWeek: [number, number];
  /** Competitor → strength (win bias, higher = we lose more). */
  competitorStrength: Record<string, number>;
  /** Competitor → appearance weight in sampleCompetitors. */
  competitorPresence: Record<string, number>;
  /** Industry → time-adjusted sampling weight. */
  industryWeights: Record<string, number>;
  /** Industry → additive win-rate delta. */
  segmentWinRateDelta: Record<string, number>;
  /** Share of new opps in the market-intelligence cohort (ramps over time). */
  marketIntelShare: number;
  /** Within the MI cohort, fraction of deals with no PMM persona driving. */
  pmmAbsentRate: number;
}

export function trendsPath(): string {
  return TRENDS_PATH;
}

export function loadTrends(): Trends {
  if (!fileExists(TRENDS_PATH)) throw new Error("state/trends.json not found. Run `npm run init` first.");
  return TrendsSchema.parse(readJson(TRENDS_PATH));
}

export function saveTrends(trends: Trends): void {
  writeJson(TRENDS_PATH, TrendsSchema.parse(trends));
}

/** Build baseline trends from Tier-1 config (used by `init`). */
export function seedTrendsFromConfig(cfg: Config, seededAt: ISODate): Trends {
  const competitors: Trends["competitors"] = {};
  for (const c of cfg.competitors.competitors) {
    competitors[c.name] = {
      strength: c.strength,
      driftPerQuarter: 0,
      presence: c.strength,
      presenceDriftPerQuarter: 0,
      strengthBumps: [],
    };
  }
  const mi = cfg.world.market_intelligence;
  return TrendsSchema.parse({
    seededAt,
    winRate: {
      baseline: cfg.world.winloss.baseline_win_rate,
      trendPerQuarter: cfg.world.winloss.win_rate_trend_per_quarter,
    },
    volume: { newOppsPerWeek: cfg.world.volume.new_opps_per_week, trendPerQuarter: 0 },
    competitors,
    segments: { industryWeightDriftPerQuarter: {}, winRateDelta: {} },
    marketIntelligence: mi
      ? { shareBaseline: mi.share, shareDriftPerQuarter: 0, pmmAbsentRate: mi.pmm_absent_rate }
      : undefined,
    directiveEffects: [],
  });
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Sum the gaussian bumps active at `date`. */
function bumpAt(bumps: z.infer<typeof Bump>[], date: ISODate): number {
  let total = 0;
  for (const b of bumps) {
    const d = daysBetween(b.center, date) / b.widthDays;
    total += b.amplitude * Math.exp(-(d * d));
  }
  return total;
}

/**
 * Evaluate the trajectories at `date`, measured in quarters since `startDate`.
 * Turns "win rate climbing", "a competitor toughening then recovering", "volume
 * ramping", and "a segment emerging" into concrete parameters for the period.
 */
export function evaluateTrends(
  trends: Trends,
  cfg: Config,
  startDate: ISODate,
  date: ISODate,
): EffectiveParams {
  const quarters = Math.max(0, daysBetween(startDate, date) / DAYS_PER_QUARTER);

  const winRateTarget = clamp01(trends.winRate.baseline + trends.winRate.trendPerQuarter * quarters);

  const [lo, hi] = trends.volume.newOppsPerWeek;
  const bump = trends.volume.trendPerQuarter * quarters;
  const newOppsPerWeek: [number, number] = [
    Math.max(0, Math.round(lo + bump)),
    Math.max(1, Math.round(hi + bump)),
  ];

  const competitorStrength: Record<string, number> = {};
  const competitorPresence: Record<string, number> = {};
  for (const [name, c] of Object.entries(trends.competitors)) {
    competitorStrength[name] = clamp01(
      c.strength + c.driftPerQuarter * quarters + bumpAt(c.strengthBumps, date),
    );
    competitorPresence[name] = Math.max(0, c.presence + c.presenceDriftPerQuarter * quarters);
  }

  // Industry sampling weights = config base + drift over time (shares evolve).
  const industryWeights: Record<string, number> = {};
  const drift = trends.segments.industryWeightDriftPerQuarter;
  for (const [name, base] of Object.entries(cfg.world.segments.industries)) {
    industryWeights[name] = Math.max(0, base + (drift[name] ?? 0) * quarters);
  }

  // Market-intelligence cohort share ramps over time (the emerging opportunity).
  const mi = trends.marketIntelligence;
  const marketIntelShare = mi ? clamp01(mi.shareBaseline + mi.shareDriftPerQuarter * quarters) : 0;
  const pmmAbsentRate = mi?.pmmAbsentRate ?? 0;

  return {
    winRateTarget,
    newOppsPerWeek,
    competitorStrength,
    competitorPresence,
    industryWeights,
    segmentWinRateDelta: trends.segments.winRateDelta,
    marketIntelShare,
    pmmAbsentRate,
  };
}
