/**
 * Connector registry contract tests: registry order (CRMs before file/chat
 * systems), config-driven enable/disable, credential no-ops, and full mapping
 * coverage for every destination-bound artifact kind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config/load.js";
import { emptyWorld } from "../src/ledger/ledger.js";
import { allConnectors } from "../src/connectors/registry.js";
import { reconcileAll } from "../src/reconcile.js";
import { DRIVE_FILE_KINDS, SLACK_KINDS } from "../src/connectors/kinds.js";
import { disabledStats } from "../src/connectors/types.js";
import type { Config } from "../src/config/schema.js";

const cfg = loadConfig();

function withConnectors(overrides: Partial<Config["connectors"]>): Config {
  return { ...cfg, connectors: { ...cfg.connectors, ...overrides } };
}

test("registry order runs CRMs before Drive before Slack", () => {
  const names = allConnectors().map((c) => c.name);
  assert.deepEqual(names, ["salesforce", "hubspot", "drive", "slack"]);
});

test("every destination-bound artifact kind has a connectors.yaml mapping", () => {
  for (const kind of DRIVE_FILE_KINDS) {
    assert.ok(cfg.connectors.drive.folders[kind], `drive.folders missing ${kind}`);
  }
  for (const kind of SLACK_KINDS) {
    assert.ok(cfg.connectors.slack.channels[kind], `slack.channels missing ${kind}`);
  }
});

test("every open pipeline stage has a Salesforce stage mapping", () => {
  for (const stage of cfg.world.pipeline.stages) {
    if (stage === "Closed") continue;
    assert.ok(cfg.connectors.salesforce.stage_map[stage], `stage_map missing ${stage}`);
  }
});

test("a disabled connector no-ops with disabled stats and writes nothing", async () => {
  const off = withConnectors({
    salesforce: { ...cfg.connectors.salesforce, enabled: false },
    hubspot: { enabled: false },
    drive: { ...cfg.connectors.drive, enabled: false },
    slack: { ...cfg.connectors.slack, enabled: false },
  });
  const world = emptyWorld("connector-test");
  const stats = await reconcileAll(world, off, { dryRun: false });
  assert.equal(stats.length, 4);
  for (const s of stats) {
    assert.equal(s.disabled, true, `${s.system} should be disabled`);
    assert.equal(s.created + s.updated, 0);
    assert.match(s.note ?? "", /disabled in config/);
  }
});

test("an enabled connector without credentials or work reports cleanly (no throw)", async () => {
  // Empty world + enabled connectors: each must either no-op on "nothing to
  // do" or on absent credentials. Neither may attempt a network call.
  const world = emptyWorld("connector-test-2");
  const stats = await reconcileAll(world, cfg, { dryRun: true });
  for (const s of stats) {
    assert.equal(s.errors.length, 0, `${s.system} errored: ${JSON.stringify(s.errors)}`);
    assert.equal(s.created + s.updated, 0);
  }
});

test("disabledStats carries the system name and skip note", () => {
  const s = disabledStats("example");
  assert.equal(s.system, "example");
  assert.equal(s.disabled, true);
  assert.match(s.note ?? "", /disabled/);
});
