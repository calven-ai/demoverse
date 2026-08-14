/**
 * Sales-team helpers (config/sales-team.yaml). See the plan addendum.
 *
 * Builds the rep roster for the ledger (managers + ICs, with role + manager
 * links) and evaluates each AE's time-dependent win modifier, the per-rep
 * performance signal that makes "win rate by AE" a real leaderboard instead of
 * noise. Managers own no deals; their number is the rollup of their reports.
 */

import type { SalesTeamConfig } from "./config/schema.js";
import type { Rep } from "./ledger/schema.js";

/** The ledger rep roster, ids preserved from config (rep-001..). */
export function buildReps(salesTeam: SalesTeamConfig): Rep[] {
  const managers: Rep[] = salesTeam.managers.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    region: m.region,
    role: "manager" as const,
    title: m.title,
    external: {},
  }));
  const ics: Rep[] = salesTeam.ics.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    region: c.region,
    role: "ic" as const,
    managerId: c.reports_to,
    title: c.title,
    external: {},
  }));
  return [...managers, ...ics];
}

/**
 * An AE's win-probability modifier at `quarters` since the world start:
 * `win_modifier + ramp_per_quarter × quarters`. Returns 0 for managers/unknown.
 */
export function icWinModifier(salesTeam: SalesTeamConfig, repId: string, quarters: number): number {
  const ic = salesTeam.ics.find((c) => c.id === repId);
  if (!ic) return 0;
  return ic.win_modifier + ic.ramp_per_quarter * quarters;
}
