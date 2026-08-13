/**
 * Domain use cases — assignment and lookup. See config/use-cases.yaml.
 *
 * Every opportunity carries one primary use case: what the buyer walked in
 * asking for. It names the deal ("<Account> - <Use Case>") and is the dominant
 * theme of that deal's prose.
 *
 * Assignment is skewed by the competitor on the deal, because that is how it
 * works in reality — you run into a competitive-enablement vendor because you
 * are in a competitive-intelligence deal, and into a research platform because
 * you are in a market-research
 * one. The skew is deliberately soft: every use case still sees several
 * competitors, so no bucket collapses to a single-competitor story.
 *
 * What this must NOT do is move any tuned statistic. Win rate, ICP tier and
 * loss reason are decided elsewhere and are not inputs here — the use case is
 * downstream of the competitor, never upstream of the outcome.
 */

import type { Config, UseCase } from "./config/schema.js";
import type { Opportunity } from "./ledger/schema.js";
import { Rng } from "./util/rng.js";

/** Separator between account name and use case in an Opportunity name. */
export const NAME_SEPARATOR = " - ";

export function useCases(cfg: Config): UseCase[] {
  return cfg.useCases.use_cases;
}

export function findUseCase(cfg: Config, name: string | undefined): UseCase | undefined {
  if (!name) return undefined;
  return cfg.useCases.use_cases.find((u) => u.name === name);
}

/**
 * Competitor affinities, mean-normalized per use case.
 *
 * Normalizing is what separates "how common is this use case" from "which
 * competitor skews toward it". Without it a use case liked by three of the four
 * competitors wins on volume as well as on skew, and one CI-heavy bucket eats
 * the pipeline. After normalizing, a use case that likes every competitor
 * equally scores 1.0 everywhere and gains nothing overall — only the RATIOS
 * inside a use case survive, which is exactly the skew we want.
 */
function normalizedAffinity(cfg: Config): Map<string, Map<string, number>> {
  const competitorNames = cfg.competitors.competitors.map((c) => c.name);
  const fallback = cfg.useCases.default_weight;
  const out = new Map<string, Map<string, number>>();

  for (const uc of cfg.useCases.use_cases) {
    const raw = competitorNames.map((n) => uc.competitor_weights[n] ?? fallback);
    const mean = raw.reduce((s, v) => s + v, 0) / Math.max(1, raw.length);
    const row = new Map<string, number>();
    competitorNames.forEach((n, i) => row.set(n, mean > 0 ? raw[i]! / mean : 1));
    out.set(uc.name, row);
  }
  return out;
}

/**
 * Pick the primary use case for a deal, given the competitors on it.
 *
 * Base rate is `target_share`; the competitors on the deal then tilt it by the
 * GEOMETRIC MEAN of their normalized affinities. Geometric mean rather than a
 * product so a second competitor refines the signal instead of compounding it —
 * a two-CI-vendor deal should look like "a CI deal", not "a CI deal squared".
 * Deals with no competitor fall back to the plain target shares.
 */
export function useCaseWeights(cfg: Config, competitors: string[]): Record<string, number> {
  const affinity = normalizedAffinity(cfg);
  const weights: Record<string, number> = {};

  for (const uc of cfg.useCases.use_cases) {
    const row = affinity.get(uc.name)!;
    const present = competitors.filter((c) => row.has(c));
    let tilt = 1;
    if (present.length > 0) {
      const logSum = present.reduce((s, c) => s + Math.log(Math.max(row.get(c)!, 1e-6)), 0);
      tilt = Math.exp(logSum / present.length);
    }
    // Floor keeps every bucket reachable for every competitor. A skew that
    // becomes a hard rule is not a pattern worth discovering — it is one we
    // hard-coded and then congratulated the downstream product for finding.
    weights[uc.name] = Math.max(uc.target_share * tilt, 0.01);
  }
  return weights;
}

export function pickUseCase(cfg: Config, competitors: string[], rng: Rng): string {
  return rng.weighted(useCaseWeights(cfg, competitors));
}

/**
 * Assign use cases across a FIXED set of deals so the set matches `target_share`
 * exactly, with competitor affinity deciding which deal fills which slot.
 *
 * Needed because the demo cohort is only ~50 deals. An independent per-deal draw
 * is right for the open-ended ledger, but over 50 deals it leaves buckets with
 * one or two members — and analytics products suppress any dashboard slice too thin to be
 * meaningful, so a whole use case silently vanishes from the demo.
 *
 * Quotas fix HOW MANY of each; affinity fixes WHICH deals. Repeatedly takes the
 * use case with the largest unmet quota and gives it the remaining deal that
 * wants it most, so the scarcest bucket always gets first pick of the deals that
 * genuinely suit it.
 *
 * `preassigned` counts toward the quotas — deals whose use case was inferred
 * from existing prose are immovable and must not be double-counted.
 */
export function allocateUseCases(
  cfg: Config,
  deals: { id: string; competitors: string[] }[],
  preassigned: Record<string, number> = {},
): Map<string, string> {
  const ucs = cfg.useCases.use_cases;
  const totalShare = ucs.reduce((s, u) => s + u.target_share, 0);
  const totalDeals = deals.length + Object.values(preassigned).reduce((s, n) => s + n, 0);

  const remaining: Record<string, number> = {};
  for (const uc of ucs) {
    const want = Math.round((uc.target_share / totalShare) * totalDeals);
    remaining[uc.name] = Math.max(0, want - (preassigned[uc.name] ?? 0));
  }
  // Rounding + preassignment rarely land on exactly the deal count; settle the
  // difference on the largest-share use cases so no deal goes unassigned.
  const byShare = [...ucs].sort((a, b) => b.target_share - a.target_share);
  let slack = deals.length - Object.values(remaining).reduce((s, n) => s + n, 0);
  for (let i = 0; slack !== 0; i = (i + 1) % byShare.length) {
    const name = byShare[i]!.name;
    if (slack > 0) {
      remaining[name]!++;
      slack--;
    } else if (remaining[name]! > 0) {
      remaining[name]!--;
      slack++;
    }
  }

  const out = new Map<string, string>();
  const pool = new Map(deals.map((d) => [d.id, useCaseWeights(cfg, d.competitors)]));

  while (pool.size > 0) {
    const target = Object.entries(remaining)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!target) break;
    const [name] = target;

    let best: { id: string; score: number } | undefined;
    for (const [id, weights] of pool) {
      const score = weights[name] ?? 0;
      if (!best || score > best.score || (score === best.score && id < best.id)) best = { id, score };
    }
    out.set(best!.id, name);
    pool.delete(best!.id);
    remaining[name]!--;
  }
  // Anything left over (quotas exhausted early) falls back to its best fit.
  for (const [id, weights] of pool) {
    out.set(id, Object.entries(weights).sort((a, b) => b[1] - a[1])[0]![0]);
  }
  return out;
}

/** The CRM-facing deal name. */
export function opportunityName(accountName: string, useCase: string | undefined): string {
  return useCase ? `${accountName}${NAME_SEPARATOR}${useCase}` : accountName;
}

/**
 * Split a stored Opportunity name back into its parts. Used when renaming
 * existing deals so a re-run does not produce "Acme - CI - CI".
 */
export function splitOpportunityName(name: string): { account: string; useCase?: string } {
  const idx = name.indexOf(NAME_SEPARATOR);
  if (idx === -1) return { account: name };
  return { account: name.slice(0, idx), useCase: name.slice(idx + NAME_SEPARATOR.length) };
}

/**
 * The prose direction for a deal's use case: what the buyer is trying to fix and
 * what the AE leads with. Injected into every prompt for the deal so transcripts,
 * emails and notes all orbit the same theme.
 */
export function useCaseBrief(cfg: Config, opp: Pick<Opportunity, "useCase">): string | undefined {
  const uc = findUseCase(cfg, opp.useCase);
  if (!uc) return undefined;
  return [
    `Primary use case: ${uc.name} (${uc.domain})`,
    `  Buyer's pain: ${uc.buyer_pain.trim()}`,
    `  AE leads with: ${uc.lead_with.trim()}`,
    `  ${cfg.world.company.short_name ?? cfg.world.company.name} agents demoed: ${uc.agents.join(", ")}`,
  ].join("\n");
}
