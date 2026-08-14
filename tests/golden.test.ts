/**
 * Golden-seed snapshot: pins the simulation's draws across refactors.
 *
 * Runs a 30-week world from a fixed seed with the prospect pool disabled
 * (synthetic names only, keeping it self-contained and free of real company names) and
 * compares a structural digest against the committed snapshot. Any change to
 * RNG draw order, sampling, outcomes, or touch-point planning shows up here.
 *
 * Regenerate deliberately (never to silence a surprise diff):
 *   UPDATE_GOLDEN=1 npm test -- tests/golden.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { loadConfig } from "../src/config/load.js";
import { emptyWorld } from "../src/ledger/ledger.js";
import { buildReps } from "../src/sales-team.js";
import { seedTrendsFromConfig } from "../src/trends.js";
import { advanceWorld } from "../src/generation/advance.js";
import { CohortIndex, type Cohort } from "../src/cohort.js";
import { repoPath } from "../src/util/fs.js";
import type { Period } from "../src/clock.js";
import type { Config } from "../src/config/schema.js";

const SNAPSHOT_PATH = repoPath("tests", "golden.snapshot.json");
const START = "2025-06-23";
const WEEKS = 30;

const EMPTY_COHORT: Cohort = { version: 1, targetSize: 0, members: [] };

function goldenConfig(): Config {
  const cfg = loadConfig();
  // Snapshot must not depend on external prospect CSVs (nor bake their company
  // names into a committed fixture); the synthetic path has identical rng order.
  return { ...cfg, world: { ...cfg.world, prospects: undefined } };
}

function weeklyPeriods(): Period[] {
  const periods: Period[] = [];
  let cursor = START;
  for (let i = 1; i <= WEEKS; i++) {
    const end = new Date(Date.UTC(2025, 5, 23 + i * 7)).toISOString().slice(0, 10);
    periods.push({ index: i, start: cursor, end });
    cursor = end;
  }
  return periods;
}

function digest() {
  const cfg = goldenConfig();
  const world = emptyWorld("golden-seed");
  world.reps = buildReps(cfg.salesTeam);
  const trends = seedTrendsFromConfig(cfg, START);
  advanceWorld(world, cfg, trends, START, weeklyPeriods(), new CohortIndex(EMPTY_COHORT));

  const accountById = new Map(world.accounts.map((a) => [a.id, a]));
  const artifactsByOpp = new Map<string, string[]>();
  for (const art of world.artifacts) {
    if (!art.dealId) continue;
    const list = artifactsByOpp.get(art.dealId) ?? [];
    list.push(art.kind);
    artifactsByOpp.set(art.dealId, list);
  }

  return {
    totals: {
      accounts: world.accounts.length,
      contacts: world.contacts.length,
      opportunities: world.opportunities.length,
      artifacts: world.artifacts.length,
    },
    opportunities: world.opportunities.map((o) => {
      const acc = accountById.get(o.accountId);
      return {
        id: o.id,
        account: acc?.name,
        industry: acc?.industry,
        size: acc?.size,
        region: acc?.region,
        stage: o.stage,
        status: o.status,
        amount: o.amount,
        competitors: o.competitors,
        useCase: o.useCase,
        closeDate: o.closeDate ?? null,
        winLossReason: o.winLossReason ?? null,
        artifacts: (artifactsByOpp.get(o.id) ?? []).sort(),
      };
    }),
  };
}

test("golden world digest matches the committed snapshot", () => {
  const actual = digest();
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(SNAPSHOT_PATH)) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + "\n");
    console.log(`golden: snapshot written to ${SNAPSHOT_PATH}`);
    return;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  assert.deepEqual(actual, expected);
});
