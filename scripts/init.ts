/**
 * `npm run init` — scaffold the world state from config. See DESIGN.md §7.4 (init scaffolder).
 *
 * Validates the Tier-1 config, seeds the reps into the ledger, and writes the
 * clock + trends baselines plus the state/ skeleton (an empty directives file).
 * Idempotent-safe: refuses to clobber a non-empty world unless --force is passed.
 *
 * `--force` is the reset: besides the ledger/clock/trends it also clears the
 * derived state a previous world left behind (generated prose, cohort files,
 * request scratch, run reports) — leaving any of it would orphan content the
 * new ledger knows nothing about. External systems are NOT touched; the purge
 * commands for those are printed at the end.
 *
 * Flags:
 *   --force   reset existing state even if the world already has deals
 *   --seed=X  set the world seed (default: keep existing / "demoverse-v1")
 */

import { rmSync } from "node:fs";

import { loadConfig } from "../src/config/load.js";
import { emptyWorld, loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { ClockSchema, saveClock } from "../src/clock.js";
import { seedTrendsFromConfig, saveTrends } from "../src/trends.js";
import { buildReps } from "../src/sales-team.js";
import { fileExists, repoPath, writeText, ensureDir } from "../src/util/fs.js";
import { worldPath } from "../src/ledger/ledger.js";
import { todayISO, addDays } from "../src/util/date.js";

const DAYS_PER_QUARTER = 91;

/** Derived state a --force reset must clear alongside the ledger. */
const RESET_PATHS = [
  "state/content",
  "state/cohort.json",
  "state/cohort.md",
  "state/requests",
  "state/preflight",
  "runs",
];

const DIRECTIVES_SKELETON = `# Active directives (Tier 2)

The engine reads the bullet list under "## Active" and echoes it back each run.
Append durable direction here ("from now on, …"), materialize it in
state/trends.json, and move superseded entries down.

## Active

## Superseded

## Log
`;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): void {
  const cfg = loadConfig();
  const force = flag("force");

  let world = fileExists(worldPath()) ? loadWorld() : emptyWorld();
  if (world.opportunities.length > 0 && !force) {
    console.error(
      `✗ state/world.json already has ${world.opportunities.length} deals. Re-run with --force to reset (this discards the ledger).`,
    );
    process.exit(1);
  }

  // A reset clears every derived-state location, or the new world would sit
  // next to prose, cohort rows and reports that belong to the old one.
  const removed: string[] = [];
  if (force) {
    for (const rel of RESET_PATHS) {
      const path = repoPath(rel);
      if (fileExists(path)) {
        rmSync(path, { recursive: true, force: true });
        removed.push(rel);
      }
    }
  }

  const seed = arg("seed") ?? world.seed ?? "demoverse-v1";
  world = emptyWorld(seed);

  // Seed the sales org from config (managers + ICs, stable ids rep-001..).
  // ICs own deals everywhere; managers purely manage.
  world.reps = buildReps(cfg.salesTeam);
  saveWorld(world);

  // Clock starts history_quarters back, so the first run backfills up to today.
  const today = todayISO();
  const startDate = addDays(today, -cfg.world.window.history_quarters * DAYS_PER_QUARTER);
  const clock = ClockSchema.parse({
    simNow: startDate,
    period: cfg.world.window.period,
    periodIndex: 0,
    startDate,
    lastRunAt: null,
  });
  saveClock(clock);

  // Trends baselines from config.
  saveTrends(seedTrendsFromConfig(cfg, today));

  // State skeleton: an empty Tier-2 directives file (fresh worlds have no
  // standing direction yet) and the content dir the ingest step files into.
  ensureDir(repoPath("state", "content"));
  if (force || !fileExists(repoPath("state", "directives.md"))) {
    writeText(repoPath("state", "directives.md"), DIRECTIVES_SKELETON);
  }

  console.log("✓ init complete");
  console.log(`  seed:       ${seed}`);
  console.log(`  reps:       ${world.reps.length}`);
  console.log(`  start date: ${startDate}  (→ backfill target: ${today})`);
  console.log(`  period:     ${clock.period}`);
  if (removed.length > 0) {
    console.log(`  reset:      cleared ${removed.join(", ")}`);
    console.log("\n⚠ External systems were NOT touched. If a previous world was pushed, purge it:");
    console.log("    npm run sf:purge -- --all           # Salesforce demo records (dry-run first)");
    console.log("    npm run drive:audit                 # find orphaned Drive files");
    console.log("    npm run hubspot:purge               # HubSpot test portal, if used");
    console.log("  Slack threads have no purge command — archive the channels or leave them.");
  }
  console.log("\nThe clock starts in the past so your world can carry believable history.");
  console.log("Two ways to run from here:");
  console.log("  · Week by week:  `npm run pipeline` advances ONE week per run (your first");
  console.log("    increments carry historical dates until the clock catches up to today).");
  console.log("  · Seed history:  `npm run apply -- --backfill` plans the whole back-catalog");
  console.log("    in one shot — a large one-time fill job (see docs/getting-started.md).");
  console.log("  (Plain `npm run apply` generates EVERY pending period up to today at once.)");
  console.log("Then fill the generation requests and run `npm run apply -- --ingest`.");
}

main();
