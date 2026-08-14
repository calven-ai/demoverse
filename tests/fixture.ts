/**
 * Shared test fixtures.
 *
 * Tests load the SHIPPED TEMPLATES, never `config/`. Two reasons:
 *
 *   1. A fresh clone has no `config/*.yaml` at all (only `config/templates/`),
 *      so `npm test` has to work without an operator first configuring a world.
 *   2. An operator who HAS configured a world would otherwise run the shipped
 *      suite against their own YAML. The golden snapshot and the CRM-vocabulary
 *      oracle are pinned to the templates, so their tests would go red for
 *      reasons unrelated to whatever they changed.
 *
 * Treat `config/templates/*.yaml` as the spec these tests assert against.
 */

import { loadConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";

/** Repo-relative config directory the whole suite reads from. */
export const TEST_CONFIG_DIR = "config/templates";

let cached: Config | undefined;

/** The shipped template config, parsed once per test process. */
export function testConfig(): Config {
  if (!cached) cached = loadConfig(TEST_CONFIG_DIR);
  return cached;
}
