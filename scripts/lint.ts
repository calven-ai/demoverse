/**
 * `npm run lint` is the coherence linter entrypoint. See docs/architecture.md#verification-the-coherence-linter.
 *
 * Runs structural integrity + cross-system coherence checks over the ledger and
 * exits non-zero if any errors are found (CI / pre-commit friendly).
 *
 * Flags are documented in USAGE below (`npm run lint -- --help`).
 */

import { loadConfig } from "../src/config/load.js";
import { loadWorld } from "../src/ledger/ledger.js";
import { lint, formatFindings } from "../src/lint.js";
import { arg, flag, helpIfRequested, type Usage } from "../src/util/cli.js";

const USAGE: Usage = {
  usage: "npm run lint -- [flags]",
  summary: "Coherence linter: proves the CRM record, the prose and the chatter tell one story.",
  flags: [
    {
      name: "--sample=N",
      desc: "Limit cross-system checks to N random closed deals (default: all).",
    },
    {
      name: "--opp=<id>",
      desc: [
        "Scope cross-system checks to a single deal. Structural checks still",
        "cover the whole ledger; they are cheap.",
      ],
    },
    {
      name: "--repetition",
      desc: [
        "Also run the cross-deal repetition detector (warn-only). Flags",
        "distinctive phrases recurring across many deals, so they can be",
        "promoted into config/prose.yaml banned_phrases.",
      ],
    },
    { name: "--help, -h", desc: "Show this help." },
  ],
  examples: [
    { cmd: "npm run lint", desc: "Full pass. Exits non-zero on any error finding." },
    { cmd: "npm run lint -- --opp=opp-042", desc: "Check one deal during the fix loop." },
    { cmd: "npm run lint -- --repetition", desc: "Hunt for phrases that have gone stale across deals." },
  ],
  notes: [
    "Fix an error by regenerating the artifact, never by hand-editing world.json:",
    "  npm run apply -- --refill=<artifactId>   then re-fill and re-ingest.",
  ],
};

function main(): void {
  helpIfRequested(USAGE);
  const cfg = loadConfig();
  const world = loadWorld();
  const sample = Number(arg("sample") ?? "0") || 0;
  const oppId = arg("opp");
  const repetition = flag("repetition");

  const result = lint(world, cfg, sample, { oppId, repetition });
  console.log(formatFindings(result));
  if (result.errors > 0) process.exit(1);
}

main();
