/**
 * Stage-history tests.
 *
 * `stageHistory` is the raw material for time-in-stage / pipeline-velocity
 * analysis, and the backfill REPLAYS the engine's own schedule rather than
 * inventing dates. The property that matters is that a replay of an
 * already-advanced world reproduces exactly what the live run recorded. These
 * tests advance a world, wipe the histories, replay, and compare.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config/load.js";
import { emptyWorld } from "../src/ledger/ledger.js";
import { buildReps } from "../src/sales-team.js";
import { seedTrendsFromConfig } from "../src/trends.js";
import { advanceWorld, backfillStageHistory } from "../src/generation/advance.js";
import { addWeeks } from "../src/util/date.js";
import type { Period } from "../src/clock.js";

const START = "2025-01-01";

function advancedWorld(weeks: number) {
  const cfg = loadConfig();
  const world = emptyWorld("stage-history-test");
  world.reps = buildReps(cfg.salesTeam);
  const trends = seedTrendsFromConfig(cfg, START);

  const periods: Period[] = [];
  let cursor = START;
  for (let i = 1; i <= weeks; i++) {
    const end = addWeeks(cursor, 1);
    periods.push({ index: i, start: cursor, end });
    cursor = end;
  }
  advanceWorld(world, cfg, trends, START, periods);
  return { cfg, world, simNow: cursor };
}

test("a live run records a stage history on every deal", () => {
  const { world } = advancedWorld(30);
  assert.ok(world.opportunities.length > 0, "no deals were generated");
  for (const opp of world.opportunities) {
    assert.ok(opp.stageHistory.length > 0, `${opp.id} has no stage history`);
    assert.equal(opp.stageHistory[0]!.stage, "Discovery");
    assert.equal(opp.stageHistory[0]!.date, opp.createdDate, `${opp.id} does not open on its created date`);
  }
});

test("stage history is monotonic and dated in order", () => {
  const { world } = advancedWorld(30);
  const rank = ["Discovery", "Evaluation", "Proposal", "Negotiation", "Closed"];
  for (const opp of world.opportunities) {
    for (let i = 1; i < opp.stageHistory.length; i++) {
      const prev = opp.stageHistory[i - 1]!;
      const cur = opp.stageHistory[i]!;
      assert.ok(
        rank.indexOf(cur.stage) > rank.indexOf(prev.stage),
        `${opp.id}: ${prev.stage} → ${cur.stage} not forward`,
      );
      assert.ok(cur.date >= prev.date, `${opp.id}: ${prev.date} → ${cur.date} goes backwards`);
    }
  }
});

test("a decided deal ends Closed on its close date", () => {
  const { world } = advancedWorld(30);
  const decided = world.opportunities.filter((o) => o.status !== "open");
  assert.ok(decided.length > 0, "no deals closed in the window");
  for (const opp of decided) {
    const last = opp.stageHistory[opp.stageHistory.length - 1]!;
    assert.equal(last.stage, "Closed", `${opp.id} does not end Closed`);
    assert.equal(last.date, opp.closeDate, `${opp.id} close date mismatch`);
  }
});

// The whole justification for the backfill: replaying the deterministic
// schedule must land on exactly what the live run wrote.
test("backfill reproduces the live run's history exactly", () => {
  const { cfg, world, simNow } = advancedWorld(30);
  const live = new Map(world.opportunities.map((o) => [o.id, JSON.stringify(o.stageHistory)]));

  for (const opp of world.opportunities) opp.stageHistory = [];
  const { updated, mismatches } = backfillStageHistory(world, cfg, START, simNow);

  assert.equal(mismatches.length, 0, `replay reported mismatches: ${mismatches.slice(0, 3).join("; ")}`);
  assert.equal(updated, world.opportunities.length);
  for (const opp of world.opportunities) {
    assert.equal(
      JSON.stringify(opp.stageHistory),
      live.get(opp.id),
      `${opp.id} replay differs from the live run`,
    );
  }
});

test("backfill leaves existing histories alone", () => {
  const { cfg, world, simNow } = advancedWorld(20);
  const before = JSON.stringify(world.opportunities.map((o) => o.stageHistory));
  const { updated, skipped } = backfillStageHistory(world, cfg, START, simNow);

  assert.equal(updated, 0);
  assert.equal(skipped, world.opportunities.length);
  assert.equal(JSON.stringify(world.opportunities.map((o) => o.stageHistory)), before);
});
