/**
 * ICP fit scoring (config/icp.yaml). See docs/architecture.md#entity-model.
 *
 * Mirrors the downstream product's ICP scorecard model:
 * the generator runs this over an account's RAW firmographics to derive an
 * internal fit tier, which biases deal outcomes and classifies in-ICP vs
 * out-of-ICP. We NEVER emit the score/tier. The downstream product re-derives the identical
 * value live from the same raw fields (that's the demo payoff). The pre-flight
 * report reuses this to show the in/out split the ICP dashboard will compute.
 */

import type { IcpConfig } from "./config/schema.js";

export type IcpTier = "Tier 1" | "Tier 2" | "Tier 3";

/** The account-level fields the scorecard reads (raw firmographics only). */
export interface IcpInputs {
  industry: string;
  size: string;
  employeeBand: string;
  revenueBand: string;
  fundingStage: string;
  techStack: string[];
  triggers: string[];
}

export interface IcpFit {
  score: number; // 0..100
  tier: IcpTier;
  inIcp: boolean; // Tier 1 or Tier 2
}

/** Map an ICP dimension key → the account value(s) it scores. */
function valuesForDimension(key: string, a: IcpInputs): { scalar?: string; list?: string[] } {
  switch (key) {
    case "industry":
      return { scalar: a.industry };
    case "size":
      return { scalar: a.size };
    case "employee_band":
      return { scalar: a.employeeBand };
    case "revenue_band":
      return { scalar: a.revenueBand };
    case "funding_stage":
      return { scalar: a.fundingStage };
    case "tech_stack":
      return { list: a.techStack };
    case "triggers":
      return { list: a.triggers };
    default:
      return {};
  }
}

/**
 * Score an account's firmographics against the configured scorecard.
 * Normalize-over-available: score = round(earned / Σweight × 100).
 */
export function scoreIcp(icp: IcpConfig, a: IcpInputs): IcpFit {
  let earned = 0;
  let available = 0;
  for (const [key, dim] of Object.entries(icp.dimensions)) {
    available += dim.weight;
    const { scalar, list } = valuesForDimension(key, a);
    let frac = 0;
    if (dim.match === "anyOf") {
      for (const v of list ?? []) frac = Math.max(frac, dim.levels[v] ?? 0);
    } else if (scalar !== undefined) {
      frac = dim.levels[scalar] ?? 0;
    }
    earned += dim.weight * frac;
  }
  const score = available > 0 ? Math.round((earned / available) * 100) : 0;
  const tier: IcpTier =
    score >= icp.thresholds.tier1 ? "Tier 1" : score >= icp.thresholds.tier2 ? "Tier 2" : "Tier 3";
  return { score, tier, inIcp: tier !== "Tier 3" };
}
