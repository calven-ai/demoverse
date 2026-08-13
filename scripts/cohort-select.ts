/**
 * `npm run cohort:select` — choose the ~50 deals that live in Salesforce.
 *
 * Seeds the cohort with every deal that ALREADY has prose (those are sunk cost —
 * their artifacts exist and must not be stranded), then tops up to `--size` with
 * deals picked for spread rather than at random.
 *
 * Why spread matters: the downstream product slices its dashboards by segment x competitor x
 * time and suppresses any bucket with too few decided deals. A cohort that is
 * accidentally 80% one competitor, or all Tier 1, or all from Q1, produces dashboards full
 * of "insufficient data". So the picker fills quotas in the scarcest dimension
 * first — competitor, then ICP tier, then account size, then quarter — always
 * taking the candidate that most improves the weakest-covered bucket.
 *
 * Outcome mix is targeted explicitly: the already-filled deals are 13 won / 2
 * lost, so left alone the cohort would read as an 87% win rate. The top-up is
 * weighted to land the COHORT near the world's configured win-rate target.
 *
 * Deterministic: same ledger + same flags => same cohort. Tie-breaks flow
 * through a seeded Rng, never Math.random().
 *
 *   npm run cohort:select                 # 50 deals, ~62% win rate
 *   npm run cohort:select -- --size=50 --open=5
 *   npm run cohort:select -- --dry-run    # print the pick, write nothing
 */

import { loadWorld } from "../src/ledger/ledger.js";
import { loadConfig } from "../src/config/load.js";
import { loadClock } from "../src/clock.js";
import { loadTrends, evaluateTrends } from "../src/trends.js";
import { loadCohort, saveCohort, enroll, type Cohort } from "../src/cohort.js";
import { Rng } from "../src/util/rng.js";
import { todayISO } from "../src/util/date.js";
import type { Opportunity, Account } from "../src/ledger/schema.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const targetSize = Number(arg("size") ?? 50);
const openTarget = Number(arg("open") ?? 5);

const world = loadWorld();
const cfg = loadConfig();
const rng = new Rng(`${world.seed}|cohort-select|${targetSize}`);
const accounts = new Map<string, Account>(world.accounts.map((a) => [a.id, a]));
const acctOf = (o: Opportunity): Account => accounts.get(o.accountId)!;

/** Deals that already carry prose — always in, whatever the mix says. */
const withProse = new Set(world.artifacts.filter((a) => a.dealId).map((a) => a.dealId!));

/** Bucket keys the picker balances across, scarcest-first. */
function quarterOf(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${y}Q${Math.floor((m! - 1) / 3) + 1}`;
}
function buckets(o: Opportunity): Record<string, string> {
  const a = acctOf(o);
  return {
    competitor: o.competitors[0] ?? "(none)",
    tier: a.icpTier,
    size: a.size,
    quarter: quarterOf(o.closeDate ?? o.createdDate),
  };
}

/**
 * Greedy spread fill. Repeatedly takes the candidate whose bucket values are
 * currently least represented — summed as a coverage deficit, so a deal that is
 * the first of its competitor AND its quarter outranks one that only adds a
 * quarter. Ties resolve through the seeded Rng.
 */
function fillBySpread(
  candidates: Opportunity[],
  count: number,
  seen: Record<string, Map<string, number>>,
): Opportunity[] {
  const chosen: Opportunity[] = [];
  const pool = [...candidates];
  while (chosen.length < count && pool.length > 0) {
    let best: { idx: number; score: number; jitter: number } | undefined;
    for (let i = 0; i < pool.length; i++) {
      const b = buckets(pool[i]!);
      // Lower is better: how crowded are this deal's buckets already?
      let score = 0;
      for (const [dim, val] of Object.entries(b)) score += seen[dim]!.get(val) ?? 0;
      const jitter = rng.float();
      if (!best || score < best.score || (score === best.score && jitter < best.jitter)) {
        best = { idx: i, score, jitter };
      }
    }
    const [pick] = pool.splice(best!.idx, 1);
    for (const [dim, val] of Object.entries(buckets(pick!))) {
      seen[dim]!.set(val, (seen[dim]!.get(val) ?? 0) + 1);
    }
    chosen.push(pick!);
  }
  return chosen;
}

function emptySeen(): Record<string, Map<string, number>> {
  return { competitor: new Map(), tier: new Map(), size: new Map(), quarter: new Map() };
}

// --- seed: everything already filled ---------------------------------------
const seeded = world.opportunities.filter((o) => withProse.has(o.id));
const seen = emptySeen();
for (const o of seeded) {
  for (const [dim, val] of Object.entries(buckets(o))) seen[dim]!.set(val, (seen[dim]!.get(val) ?? 0) + 1);
}

// --- work out the top-up mix ------------------------------------------------
// Target the COHORT's closed-deal win rate at the world's CURRENT target —
// the same trend-evaluated number the run report checks realized win rate
// against, not the raw config baseline (trends ramp it over the window).
// Compensates for whatever the already-filled deals happen to be.
const clock = loadClock();
const winRateTarget = evaluateTrends(loadTrends(), cfg, clock.startDate, clock.simNow).winRateTarget;
const closedTarget = targetSize - openTarget;
const wonTarget = Math.round(closedTarget * winRateTarget);
const lostTarget = closedTarget - wonTarget;

const have = { won: 0, lost: 0, open: 0 } as Record<string, number>;
for (const o of seeded) have[o.status] = (have[o.status] ?? 0) + 1;

const need = {
  won: Math.max(0, wonTarget - (have.won ?? 0)),
  lost: Math.max(0, lostTarget - (have.lost ?? 0)),
  open: Math.max(0, openTarget - (have.open ?? 0)),
};

const available = (status: string): Opportunity[] =>
  world.opportunities
    .filter((o) => o.status === status && !withProse.has(o.id))
    .sort((a, b) => a.id.localeCompare(b.id));

const picked = [
  ...fillBySpread(available("won"), need.won, seen),
  ...fillBySpread(available("lost"), need.lost, seen),
  ...fillBySpread(available("open"), need.open, seen),
];

// --- report -----------------------------------------------------------------
const all = [...seeded, ...picked];
const mix = { won: 0, lost: 0, open: 0 } as Record<string, number>;
for (const o of all) mix[o.status] = (mix[o.status] ?? 0) + 1;
const closed = (mix.won ?? 0) + (mix.lost ?? 0);

console.log(`Cohort selection — target ${targetSize} (${openTarget} open)\n`);
console.log(
  `  already filled : ${seeded.length}  (won ${have.won ?? 0} / lost ${have.lost ?? 0} / open ${have.open ?? 0})`,
);
console.log(`  added          : ${picked.length}  (won ${need.won} / lost ${need.lost} / open ${need.open})`);
console.log(`  cohort         : ${all.length}  (won ${mix.won} / lost ${mix.lost} / open ${mix.open})`);
console.log(
  `  win rate       : ${closed ? ((100 * (mix.won ?? 0)) / closed).toFixed(1) : "0.0"}% of ${closed} closed  (target ${(winRateTarget * 100).toFixed(0)}%)\n`,
);

for (const dim of ["competitor", "tier", "size", "quarter"] as const) {
  const counts = new Map<string, number>();
  for (const o of all) {
    const v = buckets(o)[dim]!;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const line = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  console.log(`  ${dim.padEnd(11)} ${line}`);
}

if (dryRun) {
  console.log("\n[dry-run] nothing written.");
  process.exit(0);
}

// --- write ------------------------------------------------------------------
// Everything selected here is `seed`: the one-time backfill cohort, no Slack.
// Deals created by later `apply` runs enroll themselves as `weekly`.
const cohort: Cohort = loadCohort();
cohort.version = 1;
cohort.targetSize = targetSize;
const added = enroll(
  cohort,
  all.map((o) => ({ oppId: o.id, accountName: acctOf(o).name, source: "seed" as const })),
  todayISO(),
);
saveCohort(cohort);

console.log(`\n✓ state/cohort.json — ${cohort.members.length} members (${added} newly enrolled).`);
console.log(`  Next: npm run cohort   (status table + state/cohort.md)`);
