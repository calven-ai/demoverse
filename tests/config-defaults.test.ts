/**
 * The shipped templates are the spec. Every Zod default must agree with what
 * config/templates/world.yaml actually sets, or an operator who trims a key
 * (or an agent that "simplifies" the YAML during /setup) silently gets a
 * different world from the one the docs describe.
 *
 * This drifted once already: `generate.ae_notes` and `generate.emails`
 * defaulted to false while the template set both true, and
 * `generate.internal_collateral` defaulted the other way around.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { WorldConfigSchema } from "../src/config/schema.js";
import { readYaml, repoPath } from "../src/util/fs.js";
import { TEST_CONFIG_DIR, testConfig } from "./fixture.js";

/** The template, re-parsed with one whole block deleted. */
function withoutBlock(block: string): Record<string, unknown> {
  const raw = readYaml<Record<string, unknown>>(repoPath(TEST_CONFIG_DIR, "world.yaml"));
  const { [block]: _dropped, ...rest } = raw;
  const parsed = WorldConfigSchema.safeParse(rest);
  assert.ok(parsed.success, `world.yaml without "${block}" should still parse: ${parsed.error}`);
  return parsed.data[block as keyof typeof parsed.data] as Record<string, unknown>;
}

for (const block of ["generate", "detail"] as const) {
  test(`world.yaml "${block}" defaults match the shipped template`, () => {
    const fromTemplate = testConfig().world[block] as Record<string, unknown>;
    const fromDefaults = withoutBlock(block);
    assert.deepEqual(
      fromDefaults,
      fromTemplate,
      `src/config/schema.ts defaults for "${block}" disagree with config/templates/world.yaml. ` +
        `Omitting the block must produce the documented world, so change the schema, not the template.`,
    );
  });
}
