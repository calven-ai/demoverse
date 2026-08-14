/**
 * Deal-shape tests.
 *
 * The property under test is that the pipeline has TAILS. A world where every
 * deal lands inside one band reads as generated: before archetypes existed,
 * cycle length was a uniform draw over `avg_sales_cycle_weeks`, which (because
 * stages are derived from elapsed fraction) made every deal of four weeks or
 * more produce an identical stage history.
 *
 * These tests assert the distribution has a mode in the middle and populated
 * edges, that the stall really does freeze the stage clock, and that the whole
 * thing stays a pure function of (seed, oppId, cfg), which is what
 * `backfillStageHistory` relies on to replay a deal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { testConfig } from "./fixture.js";
import { emptyWorld } from "../src/ledger/ledger.js";
import { dealShape, stageForElapsed, totalWeeks, isThin } from "../src/pipeline/shape.js";
import { openStages } from "../src/pipeline/stages.js";

const SAMPLE = 4000;

function shapes(seed = "shape-test") {
  const cfg = testConfig();
  const world = emptyWorld(seed);
  return Array.from({ length: SAMPLE }, (_, i) => dealShape(world, cfg, `opp-${i}`));
}

test("dealShape is a pure function of (seed, oppId, cfg)", () => {
  const cfg = testConfig();
  const world = emptyWorld("purity");
  for (const id of ["opp-1", "opp-97", "opp-1234"]) {
    assert.deepEqual(dealShape(world, cfg, id), dealShape(world, cfg, id));
  }
  // A different seed must give a different world, or the salt is not being used.
  const other = emptyWorld("purity-2");
  const a = Array.from({ length: 50 }, (_, i) => totalWeeks(dealShape(world, cfg, `opp-${i}`)));
  const b = Array.from({ length: 50 }, (_, i) => totalWeeks(dealShape(other, cfg, `opp-${i}`)));
  assert.notDeepEqual(a, b);
});

test("the body clusters at the mode of avg_sales_cycle_weeks", () => {
  const cfg = testConfig();
  const [lo, hi] = cfg.world.pipeline.avg_sales_cycle_weeks;
  const mode = Math.round((lo + hi) / 2);
  const standard = shapes().filter((s) => s.archetype === "standard");

  const counts = new Map<number, number>();
  for (const s of standard) counts.set(s.cycleWeeks, (counts.get(s.cycleWeeks) ?? 0) + 1);

  // Every standard deal stays inside the configured band...
  for (const s of standard) {
    assert.ok(s.cycleWeeks >= lo && s.cycleWeeks <= hi, `standard deal outside band: ${s.cycleWeeks}`);
    assert.equal(s.stallWeeks, 0);
  }
  // ...and the midpoint is the most common length, which a uniform draw would
  // not give us. That peak is the whole difference from the old behavior.
  const peak = [...counts].sort((x, y) => y[1] - x[1])[0]![0];
  assert.equal(peak, mode, `expected the mode at ${mode} weeks, got ${peak}`);
  assert.ok(
    (counts.get(mode) ?? 0) > (counts.get(lo) ?? 0) * 2,
    "the mode should be clearly more common than the band edges",
  );
});

test("both tails are populated: some deals close in a week, some grind for a quarter", () => {
  const cfg = testConfig();
  const outliers = cfg.world.pipeline.cycle_outliers;
  const all = shapes();

  const fast = all.filter((s) => s.archetype === "fast");
  const slog = all.filter((s) => s.archetype === "slog");
  const stalled = all.filter((s) => s.archetype === "stalled");

  // Each tail is rare but must actually exist; a tail that never fires is the
  // bug this whole change is about.
  for (const [name, group, rate] of [
    ["fast", fast, outliers.fast.rate],
    ["slog", slog, outliers.slog.rate],
    ["stalled", stalled, outliers.stalled.rate],
  ] as const) {
    const share = group.length / SAMPLE;
    assert.ok(group.length > 0, `${name} deals never occurred`);
    assert.ok(
      Math.abs(share - rate) < 0.02,
      `${name} share ${share.toFixed(3)} is far from the configured ${rate}`,
    );
  }

  for (const s of fast) {
    assert.ok(s.cycleWeeks >= outliers.fast.weeks[0] && s.cycleWeeks <= outliers.fast.weeks[1]);
    assert.ok(isThin(s), "a fast deal should be planted thin");
  }
  for (const s of slog) {
    assert.ok(s.cycleWeeks >= outliers.slog.weeks[0] && s.cycleWeeks <= outliers.slog.weeks[1]);
  }
  for (const s of stalled) {
    assert.ok(s.stallWeeks >= outliers.stalled.stall_weeks[0]);
    assert.ok(s.stallWeeks <= outliers.stalled.stall_weeks[1]);
    assert.ok(totalWeeks(s) > s.cycleWeeks, "a stall must add calendar time");
  }

  // Deals reach well outside the configured band in both directions.
  const [lo, hi] = cfg.world.pipeline.avg_sales_cycle_weeks;
  assert.ok(
    all.some((s) => totalWeeks(s) < lo),
    "nothing ever closed faster than the band",
  );
  assert.ok(
    all.some((s) => totalWeeks(s) > hi + 4),
    "nothing ever ran well past the band",
  );
});

test("a stall freezes the stage clock, holding a deal in one stage for weeks", () => {
  const cfg = testConfig();
  const stages = openStages(cfg);
  const shape = {
    archetype: "stalled" as const,
    cycleWeeks: 6,
    stallWeeks: 4,
    stallAfterIdx: 1,
  };
  const spanDays = totalWeeks(shape) * 7;

  const walk = Array.from({ length: totalWeeks(shape) }, (_, w) =>
    stageForElapsed(cfg, (w + 1) * 7, spanDays, shape),
  );

  // Never regresses.
  for (let i = 1; i < walk.length; i++) {
    assert.ok(
      stages.indexOf(walk[i]!) >= stages.indexOf(walk[i - 1]!),
      `stage went backwards: ${walk.join(" > ")}`,
    );
  }
  // The whole point: some stage is held for several consecutive weeks. Since
  // touch points are only planted on stage ENTRY, those weeks are silent.
  const longestRun = walk.reduce(
    (acc, s, i) =>
      i > 0 && s === walk[i - 1]
        ? { cur: acc.cur + 1, max: Math.max(acc.max, acc.cur + 1) }
        : { cur: 1, max: Math.max(acc.max, 1) },
    { cur: 1, max: 1 },
  ).max;
  assert.ok(longestRun >= 4, `expected a multi-week silent stretch, saw runs of ${longestRun}`);
});

test("with no stall, stageForElapsed matches the plain elapsed-fraction mapping", () => {
  const cfg = testConfig();
  const shape = { archetype: "standard" as const, cycleWeeks: 6, stallWeeks: 0, stallAfterIdx: 0 };
  const stages = openStages(cfg);
  const spanDays = 42;
  for (let d = 1; d <= spanDays; d++) {
    const idx = Math.max(0, Math.min(stages.length - 1, Math.floor((d / spanDays) * stages.length)));
    assert.equal(stageForElapsed(cfg, d, spanDays, shape), stages[idx]);
  }
});
