/**
 * Deal outcomes: the win/loss decision and the correlated feedback fields. Split
 * from advance.ts; pure functions over config + seeded Rng.
 */

import { Rng } from "../util/rng.js";
import type { Config } from "../config/schema.js";
import type { Account, Opportunity } from "../ledger/schema.js";
import type { EffectiveParams } from "../trends.js";

/**
 * Win probability, correlated with the levers downstream dashboards surface:
 * ICP fit (the in/out-of-ICP lift), competitor strength, multi-threading, and
 * planted per-segment deltas, around the period's trend-evaluated target.
 */
export function decideWin(
  eff: EffectiveParams,
  account: Account,
  opp: Opportunity,
  rng: Rng,
  repMod: number,
  personaAdj = 0,
): boolean {
  const icpAdj = account.icpTier === "Tier 1" ? 0.16 : account.icpTier === "Tier 2" ? 0.04 : -0.18;
  const strengths = opp.competitors.map((c) => eff.competitorStrength[c] ?? 0.5);
  const avgStrength = strengths.length > 0 ? strengths.reduce((a, b) => a + b, 0) / strengths.length : 0;
  const competitorAdj = avgStrength * 0.3;
  // Multi-threading lift: each contact beyond the lone champion helps, capped.
  const threadingAdj = Math.min(0.18, Math.max(0, opp.contactIds.length - 1) * 0.05);
  const segmentAdj = eff.segmentWinRateDelta[account.industry] ?? 0;
  // Per-AE performance (the rep leaderboard / team-rollup signal). personaAdj is
  // the no-PMM penalty (≤0). A deal with no product-marketing persona wins less.
  const pWin = Math.max(
    0.05,
    Math.min(
      0.95,
      eff.winRateTarget + icpAdj - competitorAdj + threadingAdj + segmentAdj + repMod + personaAdj,
    ),
  );
  return rng.chance(pWin);
}

export function pickLossReason(cfg: Config, opp: Opportunity, rng: Rng): string {
  // If a competitor is present, bias toward its typical loss reasons.
  if (opp.competitors.length > 0) {
    const comp = cfg.competitors.competitors.find((c) => c.name === opp.competitors[0]);
    if (comp && comp.typical_loss_reasons.length > 0 && rng.chance(0.6)) {
      return rng.pick(comp.typical_loss_reasons);
    }
  }
  return rng.weighted(cfg.world.winloss.loss_reasons);
}

/**
 * The AE-believed loss reason (what the owner records on the CRM). ~80% of the
 * time it matches the actual `winLossReason`; ~20% the AE misattributes it to a
 * DIFFERENT reason. That is the belief-vs-reality gap the product later surfaces by comparing
 * this with the prospect's win-loss reason. Stays within the configured loss-reason vocab.
 */
export function pickRepLossReason(cfg: Config, actual: string, rng: Rng): string {
  if (rng.chance(0.8)) return actual;
  const others = Object.fromEntries(
    Object.entries(cfg.world.winloss.loss_reasons).filter(([reason]) => reason !== actual),
  );
  return Object.keys(others).length > 0 ? rng.weighted(others) : actual;
}

/** Price verdict correlated with outcome + a Price loss. */
export function pickPriceFeedback(rng: Rng, won: boolean, lossReason: string | undefined): string {
  if (lossReason === "Price")
    return rng.weighted({ "More expensive": 0.75, "On par": 0.2, "Less expensive": 0.05 });
  if (won) return rng.weighted({ "Less expensive": 0.3, "On par": 0.55, "More expensive": 0.15 });
  return rng.weighted({ "Less expensive": 0.2, "On par": 0.5, "More expensive": 0.3 });
}

/** 0–2 product areas, biased toward the area implicated by the loss reason. */
export function pickProductFeedback(
  rng: Rng,
  lossReason: string | undefined,
  vocab: readonly string[],
): string[] {
  const out = new Set<string>();
  if (lossReason === "Integrations") out.add("Integrations");
  if (lossReason === "Missing feature") out.add(rng.pick(["Analytics", "AI / Automation", "Reporting"]));
  const extra = rng.int(0, 2);
  for (let i = 0; i < extra; i++) out.add(rng.pick(vocab));
  return [...out];
}

/** 1–2 of the account's tools named as integration requirements on the deal. */
export function pickTechRequirements(rng: Rng, techStack: string[]): string[] {
  if (techStack.length === 0) return [];
  const shuffled = rng.shuffle(techStack);
  return shuffled.slice(0, rng.int(1, Math.min(2, shuffled.length)));
}
