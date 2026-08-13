/**
 * `npm run lint` — coherence linter entrypoint. See DESIGN.md §15.
 *
 * Runs structural integrity + cross-system coherence checks over the ledger and
 * exits non-zero if any errors are found (CI / pre-commit friendly).
 *
 * Flags:
 *   --sample=N     limit cross-system checks to N random closed deals (default: all)
 *   --opp=<id>     scope cross-system checks to a single deal (structural checks
 *                  still cover the whole ledger — they're cheap)
 *   --repetition   also run the cross-deal repetition detector (warn-only):
 *                  flags distinctive phrases recurring across many deals so they
 *                  can be promoted into config/prose.yaml banned_phrases
 */

import { loadConfig } from "../src/config/load.js";
import { loadWorld } from "../src/ledger/ledger.js";
import { lint, formatFindings } from "../src/lint.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

function main(): void {
  const cfg = loadConfig();
  const world = loadWorld();
  const sample = Number(arg("sample") ?? "0") || 0;
  const oppId = arg("opp");
  const repetition = process.argv.includes("--repetition");

  const result = lint(world, cfg, sample, { oppId, repetition });
  console.log(formatFindings(result));
  if (result.errors > 0) process.exit(1);
}

main();
