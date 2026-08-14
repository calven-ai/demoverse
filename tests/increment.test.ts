/**
 * Living-increment tests.
 *
 * The world is meant to accumulate its history a slice at a time: an increment
 * opens a couple of deals, moves the open ones forward, and plants only the
 * touch points those events earned. These tests pin the properties that keep
 * that motion honest: the forced clock (an increment runs on demand, not when
 * the calendar allows it), the per-run intake override, and the deal-shape
 * variety that stops every deal from walking an identical pipeline.
 *
 * Note that a deal does NOT always move exactly one stage per period. Stages
 * are derived from elapsed fraction of the cycle, so a short deal skips some
 * and a stalled one holds still. See src/pipeline/shape.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { testConfig } from "./fixture.js";
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
  const cfg = testConfig();
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

test("an increment moves deals forward a slice at a time, never backwards", () => {
  const { cfg, world, trends } = freshWorld();
  const cohort = new CohortIndex(EMPTY_COHORT);
  const stages = cfg.world.pipeline.stages;

  // Watch EVERY deal, not just one. Tracking a single deal made this test
  // depend on which cycle length that deal happened to draw, so a real
  // regression could hide behind a lucky seed.
  advanceWorld(world, cfg, trends, START, forcedPeriods(clockAt(START, 0), 1), cohort, {
    newOppsPerPeriod: 6,
  });

  let clock = clockAt("2025-01-08", 1);
  let sawProgress = false;
  for (let week = 0; week < 12; week++) {
    const before = new Map(
      world.opportunities.map((o) => [
        o.id,
        {
          rank: stages.indexOf(o.stage),
          open: o.status === "open",
          arts: world.artifacts.filter((a) => a.dealId === o.id).length,
        },
      ]),
    );

    advanceWorld(world, cfg, trends, START, forcedPeriods(clock, 1), cohort, { newOppsPerPeriod: 0 });
    clock = clockAt(forcedPeriods(clock, 1)[0]!.end, clock.periodIndex + 1);

    for (const opp of world.opportunities) {
      const was = before.get(opp.id);
      if (!was || !was.open) continue;
      const after = stages.indexOf(opp.stage);
      assert.ok(after >= was.rank, `${opp.id} moved backwards`);
      if (after > was.rank) sawProgress = true;

      // A single period is still a SLICE of a deal's life, never its whole
      // paper trail, however far the stage pointer moved.
      const planted = world.artifacts.filter((a) => a.dealId === opp.id).length - was.arts;
      assert.ok(planted <= 5, `one increment planted ${planted} artifacts on ${opp.id}`);
    }
  }

  assert.ok(sawProgress, "no deal ever advanced a stage");
  for (const opp of world.opportunities) {
    assert.ok(opp.stageHistory.length >= 1, `${opp.id} recorded no history`);
  }
});

test("short cycles skip stages; long ones walk the full pipeline", () => {
  const { cfg, world, trends } = freshWorld();
  const cohort = new CohortIndex(EMPTY_COHORT);

  // 30 weeks of intake, so every archetype gets a chance to appear.
  let clock = clockAt(START, 0);
  for (let week = 0; week < 30; week++) {
    advanceWorld(world, cfg, trends, START, forcedPeriods(clock, 1), cohort, { newOppsPerPeriod: 3 });
    clock = clockAt(forcedPeriods(clock, 1)[0]!.end, clock.periodIndex + 1);
  }

  const closed = world.opportunities.filter((o) => o.status !== "open");
  assert.ok(closed.length > 20, "not enough closed deals to judge shape variety");

  const openStageCount = cfg.world.pipeline.stages.length - 1;
  const pathLengths = new Set(closed.map((o) => o.stageHistory.length));

  // The bug this replaces: with a uniform cycle draw, every deal of four weeks
  // or more produced the SAME five-entry history, so the pipeline looked
  // hard-coded. Real ones vary.
  assert.ok(pathLengths.size >= 3, `deals only ever took ${pathLengths.size} distinct path shapes`);
  assert.ok(
    closed.some((o) => o.stageHistory.length < openStageCount),
    "no deal ever skipped a stage",
  );
  assert.ok(
    closed.some((o) => o.stageHistory.length === openStageCount + 1),
    "no deal ever walked the full pipeline",
  );
});

test("a stalled deal goes quiet: consecutive periods in one stage, earning nothing", () => {
  const { cfg, world, trends } = freshWorld();
  const cohort = new CohortIndex(EMPTY_COHORT);

  let clock = clockAt(START, 0);
  const silentStreak = new Map<string, number>();
  const bestStreak = new Map<string, number>();

  for (let week = 0; week < 30; week++) {
    const before = new Map(
      world.opportunities.map((o) => [
        o.id,
        {
          stage: o.stage,
          open: o.status === "open",
          arts: world.artifacts.filter((a) => a.dealId === o.id).length,
        },
      ]),
    );
    advanceWorld(world, cfg, trends, START, forcedPeriods(clock, 1), cohort, { newOppsPerPeriod: 3 });
    clock = clockAt(forcedPeriods(clock, 1)[0]!.end, clock.periodIndex + 1);

    for (const opp of world.opportunities) {
      const was = before.get(opp.id);
      if (!was || !was.open || opp.status !== "open") continue;
      const quiet =
        opp.stage === was.stage && world.artifacts.filter((a) => a.dealId === opp.id).length === was.arts;
      const run = quiet ? (silentStreak.get(opp.id) ?? 0) + 1 : 0;
      silentStreak.set(opp.id, run);
      bestStreak.set(opp.id, Math.max(bestStreak.get(opp.id) ?? 0, run));
    }
  }

  // Before archetypes, progression was a pure function of elapsed fraction, so
  // a deal could never genuinely go dark. Now some do.
  const longest = Math.max(...bestStreak.values());
  assert.ok(longest >= 3, `longest silent stretch was ${longest} periods; expected a real stall`);
});
