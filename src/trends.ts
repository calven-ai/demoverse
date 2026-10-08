/**
 * Running KPI trajectories (state/trends.json). See docs/architecture.md#steering-three-tiers-of-instruction.
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
import { daysBetween, DAYS_PER_QUARTER, type ISODate } from "./util/date.js";
import type { Config } from "./config/schema.js";
import { Rng } from "./util/rng.js";

const TRENDS_PATH = repoPath("state", "trends.json");

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
    .prefault({}),
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
  /**
   * Customer-voice trajectories: what buyers TALK about, over time. Without
   * these every pain/trigger/job is drawn from a static bank, so a theme
   * dashboard sees noise instead of something rising or fading.
   *   - arcs: a theme with a dated weight curve (piecewise-linear points); an
   *     artifact dated where the weight is high is likely to voice it
   *   - gainShare: target share of the buyer's statements that are gains
   *     (what works, what they expect to get) vs pains, over time
   */
  voice: z
    .object({
      arcs: z
        .array(
          z.object({
            label: z.string(),
            category: z.enum(["pain", "job", "buying_trigger", "gain"]),
            /** How a buyer would actually say it: the quotable kernel. */
            says: z.string(),
            /** [ISO date, weight 0..1] points; linear between, flat outside. */
            points: z.array(z.tuple([z.string(), z.number().min(0).max(1)])).min(1),
          }),
        )
        .default([]),
      gainShare: z.array(z.tuple([z.string(), z.number().min(0).max(1)])).default([]),
      /** Cap on arcs voiced in one artifact, so a call never reads like a checklist. */
      maxArcsPerArtifact: z.number().int().min(1).default(3),
    })
    .prefault({}),
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

/** Piecewise-linear value of dated [date, value] points at `date` (flat outside). */
export function curveAt(points: [string, number][], date: ISODate): number | undefined {
  if (!points.length) return undefined;
  const sorted = [...points].sort((a, b) => a[0].localeCompare(b[0]));
  if (date <= sorted[0]![0]) return sorted[0]![1];
  for (let i = 1; i < sorted.length; i++) {
    const [d1, v1] = sorted[i]!;
    if (date <= d1) {
      const [d0, v0] = sorted[i - 1]!;
      const span = daysBetween(d0, d1);
      return span <= 0 ? v1 : v0 + ((v1 - v0) * daysBetween(d0, date)) / span;
    }
  }
  return sorted[sorted.length - 1]![1];
}

export type VoiceArc = Trends["voice"]["arcs"][number];

/**
 * The customer-voice themes one artifact should carry: each arc is included
 * with probability = its weight at `date` (stable per `key`), strongest first,
 * capped. `categories` restricts which kinds fit the artifact (a check-in call
 * voices gains, not buying triggers).
 */
export function voiceFor(
  trends: Trends,
  date: ISODate,
  key: string,
  categories: VoiceArc["category"][],
): { arcs: VoiceArc[]; gainShare?: number } {
  const rng = new Rng(`voice|${key}`);
  const picked = trends.voice.arcs
    .filter((a) => categories.includes(a.category))
    .map((a) => ({ a, w: curveAt(a.points, date) ?? 0 }))
    .filter(({ w }) => rng.chance(w))
    .sort((x, y) => y.w - x.w)
    .slice(0, trends.voice.maxArcsPerArtifact)
    .map(({ a }) => a);
  return { arcs: picked, gainShare: curveAt(trends.voice.gainShare, date) };
}
