/**
 * Living-increment tests.
 *
 * The world is meant to accumulate its history a slice at a time: an increment
 * opens a couple of deals, moves each open deal at most one stage, and plants
 * only the touch points those events earned. These tests pin the two properties
 * that keep that motion honest: the forced clock (an increment runs on demand,
 * not when the calendar allows it) and the per-run intake override.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config/load.js";
import { emptyWorld } from "../src/ledger/ledger.js";
import { buildReps } from "../src/sales-team.js";
import { seedTrendsFromConfig } from "../src/trends.js";
import { advanceWorld } from "../src/generation/advance.js";
import { CohortIndex } from "../src/cohort.js";
import { forcedPeriods, driftPeriods, pendingPeriods, type Clock } from "../src/clock.js";

const START = "2025-01-01";
const EMPTY_COHORT = { version: 1 as const, targetSize: 0, members: [] };

function clockAt(simNow: string, periodIndex = 10): Clock {
  return { simNow, period: "week", periodIndex, startDate: START, lastRunAt: null };
}

function freshWorld() {
  const cfg = loadConfig();
  const world = emptyWorld("increment-test");
  world.reps = buildReps(cfg.salesTeam);
  return { cfg, world, trends: seedTrendsFromConfig(cfg, START) };
}

test("a forced increment runs even when the world is already current", () => {
  const clock = clockAt("2026-08-13");
  // The calendar owes nothing. This is the exact state a routine run finds.
  assert.equal(pendingPeriods(clock, "2026-08-13").length, 0);

  const periods = forcedPeriods(clock, 1);
  assert.equal(periods.length, 1);
  assert.deepEqual(periods[0], { index: 11, start: "2026-08-13", end: "2026-08-20" });
});

test("forced periods are contiguous and keep numbering from the clock", () => {
  const periods = forcedPeriods(clockAt("2026-08-13", 57), 3);
  assert.deepEqual(
    periods.map((p) => [p.index, p.start, p.end]),
    [
      [58, "2026-08-13", "2026-08-20"],
      [59, "2026-08-20", "2026-08-27"],
      [60, "2026-08-27", "2026-09-03"],
    ],
  );
});

test("drift reports how far the world has run past the real calendar", () => {
  assert.equal(driftPeriods(clockAt("2026-08-13"), "2026-08-13"), 0);
  assert.equal(driftPeriods(clockAt("2026-08-06"), "2026-08-13"), 0, "a world behind today has no drift");
  assert.equal(driftPeriods(clockAt("2026-08-20"), "2026-08-13"), 1);
  assert.equal(driftPeriods(clockAt("2026-09-03"), "2026-08-13"), 3);
});

test("--new-opps overrides intake exactly, for that run only", () => {
  const { cfg, world, trends } = freshWorld();
  const periods = forcedPeriods(clockAt(START, 0), 2);

  advanceWorld(world, cfg, trends, START, periods, new CohortIndex(EMPTY_COHORT), { newOppsPerPeriod: 5 });
  assert.equal(world.opportunities.length, 10, "5 deals per period, exactly");

  // The standing rate is untouched. A later run without the flag falls back to it.
  assert.deepEqual(trends.volume.newOppsPerWeek, cfg.world.volume.new_opps_per_week);
});

test("an increment moves an open deal at most one stage and plants only that stage's touch points", () => {
  const { cfg, world, trends } = freshWorld();
  const cohort = new CohortIndex(EMPTY_COHORT);
  const stages = cfg.world.pipeline.stages;

  // Open a cohort of deals, then advance one week at a time and watch a single
  // deal: a real one does not jump Discovery → Negotiation in a week.
  advanceWorld(world, cfg, trends, START, forcedPeriods(clockAt(START, 0), 1), cohort, {
    newOppsPerPeriod: 6,
  });
  const tracked = world.opportunities[0]!.id;

  let clock = clockAt("2025-01-08", 1);
  for (let week = 0; week < 8; week++) {
    const opp = world.opportunities.find((o) => o.id === tracked)!;
    if (opp.status !== "open") break;
    const before = stages.indexOf(opp.stage);
    const artsBefore = world.artifacts.filter((a) => a.dealId === tracked).length;

    advanceWorld(world, cfg, trends, START, forcedPeriods(clock, 1), cohort, { newOppsPerPeriod: 0 });
    clock = clockAt(forcedPeriods(clock, 1)[0]!.end, clock.periodIndex + 1);

    const after = stages.indexOf(world.opportunities.find((o) => o.id === tracked)!.stage);
    assert.ok(after >= before, "a deal never moves backwards");
    assert.ok(after - before <= 1, `deal jumped ${after - before} stages in one week`);

    const planted = world.artifacts.filter((a) => a.dealId === tracked).length - artsBefore;
    assert.ok(planted <= 4, `one increment planted ${planted} artifacts on a single deal`);
  }

  const opp = world.opportunities.find((o) => o.id === tracked)!;
  assert.ok(opp.stageHistory.length >= 2, "the deal recorded its progression");
});
