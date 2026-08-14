/**
 * KPI computation + run-report rendering. See docs/architecture.md#verification-the-coherence-linter.
 *
 * Realized win-rate / volume curves are computed from the closed-deal population
 * and diffed against the configured/trend targets so the report can flag drift.
 */

import type { Config } from "./config/schema.js";
import type { World } from "./ledger/schema.js";
import { evaluateTrends, type Trends } from "./trends.js";
import type { PeriodSummary } from "./generation/advance.js";
import type { ReconcileStats } from "./connectors/types.js";

export interface Kpis {
  totalDeals: number;
  open: number;
  won: number;
  lost: number;
  winRate: number | null;
  perCompetitorWinRate: Record<string, { contested: number; won: number; rate: number }>;
}

export function computeKpis(world: World): Kpis {
  const open = world.opportunities.filter((o) => o.status === "open").length;
  const won = world.opportunities.filter((o) => o.status === "won").length;
  const lost = world.opportunities.filter((o) => o.status === "lost").length;
  const closed = won + lost;

  const perCompetitor: Kpis["perCompetitorWinRate"] = {};
  for (const o of world.opportunities) {
    if (o.status === "open") continue;
    for (const c of o.competitors) {
      const rec = (perCompetitor[c] ??= { contested: 0, won: 0, rate: 0 });
      rec.contested++;
      if (o.status === "won") rec.won++;
    }
  }
  for (const rec of Object.values(perCompetitor)) rec.rate = rec.contested ? rec.won / rec.contested : 0;

  return {
    totalDeals: world.opportunities.length,
    open,
    won,
    lost,
    winRate: closed ? won / closed : null,
    perCompetitorWinRate: perCompetitor,
  };
}

export function renderRunReport(args: {
  date: string;
  nudge?: string;
  periods: PeriodSummary[];
  world: World;
  cfg: Config;
  trends: Trends;
  startDate: string;
  simNow: string;
  reconcile?: ReconcileStats[];
  pendingArtifacts: number;
}): string {
  const kpis = computeKpis(args.world);
  const target = evaluateTrends(args.trends, args.cfg, args.startDate, args.simNow);
  const winRatePct = kpis.winRate === null ? "n/a" : `${(kpis.winRate * 100).toFixed(1)}%`;
  const targetPct = `${(target.winRateTarget * 100).toFixed(1)}%`;
  const drift =
    kpis.winRate === null ? "n/a" : `${((kpis.winRate - target.winRateTarget) * 100).toFixed(1)} pts`;

  const periodRows = args.periods
    .map(
      (p) =>
        `| ${p.index} | ${p.start}→${p.end} | ${p.newAccounts} | ${p.newOpps} | ${p.won} | ${p.lost} | ${p.artifactsPlanned} |`,
    )
    .join("\n");

  const competitorRows = Object.entries(kpis.perCompetitorWinRate)
    .sort((a, b) => b[1].contested - a[1].contested)
    .map(([name, r]) => `| ${name} | ${r.contested} | ${r.won} | ${(r.rate * 100).toFixed(0)}% |`)
    .join("\n");

  const reconcileRows = (args.reconcile ?? [])
    .map(
      (s) =>
        `| ${s.system} | ${s.disabled ? "skipped" : "ran"} | ${s.created} | ${s.updated} | ${s.skipped} | ${s.errors.length} | ${s.note ?? ""} |`,
    )
    .join("\n");

  return `# Run report ${args.date}

**Simulation now:** ${args.simNow}  ·  **Periods generated this run:** ${args.periods.length}
${args.nudge ? `\n**Per-run nudge (Tier 3):** ${args.nudge}\n` : ""}
## World totals

- Deals: **${kpis.totalDeals}** (open ${kpis.open}, won ${kpis.won}, lost ${kpis.lost})
- Accounts: ${args.world.accounts.length} · Contacts: ${args.world.contacts.length} · Artifacts: ${args.world.artifacts.length}
- Artifacts awaiting generation: **${args.pendingArtifacts}**

## KPI check

| Metric | Realized | Target | Drift |
| --- | --- | --- | --- |
| Win rate | ${winRatePct} | ${targetPct} | ${drift} |

## Per-competitor win rate (contested deals)

| Competitor | Contested | Won | Win rate |
| --- | --- | --- | --- |
${competitorRows || "| (none) | | | |"}

## Periods this run

| # | Window | New accts | New opps | Won | Lost | Artifacts |
| --- | --- | --- | --- | --- | --- | --- |
${periodRows || "| (none) | | | | | | |"}

${args.reconcile ? `## Reconcile\n\n| System | Status | Created | Updated | Skipped | Errors | Note |\n| --- | --- | --- | --- | --- | --- | --- |\n${reconcileRows}\n` : ""}
`;
}
