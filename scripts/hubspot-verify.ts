/**
 * Verify a prior `hubspot:import`. Batch-reads every `demo_world_id` this
 * scope would import, diffs properties, and (by default) checks the
 * contact→company / deal→company / deal→contact associations. Read-only.
 * Exits non-zero if anything is missing or mismatched.
 *
 *   npm run hubspot:verify -- --opp=opp-042
 *   npm run hubspot:verify -- --all
 *   npm run hubspot:verify -- --all --no-associations   # properties only (fast)
 */

import { HubSpotClient } from "../src/connectors/hubspot/client.js";
import { selectHubSpotDataset, type HubSpotScope } from "../src/connectors/hubspot/import.js";
import { verifyHubSpotDataset } from "../src/connectors/hubspot/verify.js";
import { loadWorld } from "../src/ledger/ledger.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

function integerArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}

function resolveScope(): HubSpotScope {
  const all = process.argv.includes("--all");
  const opp = arg("opp");
  if (all && opp) throw new Error("Pass either --all or --opp=<id>, not both");
  if (all) return { kind: "all" };
  if (opp) return { kind: "opportunity", oppId: opp };
  return {
    kind: "pilot",
    accountLimit: integerArg("accounts", 3),
    dealsPerAccount: integerArg("deals-per-account", 3),
  };
}

async function main(): Promise<void> {
  const scope = resolveScope();
  const checkAssociations = !process.argv.includes("--no-associations");
  const maxAssociationChecks = arg("max-association-checks")
    ? Number(arg("max-association-checks"))
    : undefined;

  const world = loadWorld();
  const dataset = selectHubSpotDataset(world, scope);
  console.log(
    `Verifying ${dataset.accounts.length} companies, ${dataset.contacts.length} contacts, ` +
      `${dataset.opportunities.length} deals${checkAssociations ? " + associations" : " (properties only)"}...`,
  );

  const client = HubSpotClient.fromEnv();
  const report = await verifyHubSpotDataset(client, world, dataset, {
    checkAssociations,
    maxAssociationChecks,
    onProgress: (message) => console.log(`  … ${message}`),
  });

  console.log("\nVerification summary:");
  console.log(
    `  checked companies=${report.checked.companies} contacts=${report.checked.contacts} ` +
      `deals=${report.checked.deals} associations=${report.checked.associations}`,
  );
  console.log(`  issues=${report.issues.length}`);
  for (const issue of report.issues) console.log(`    ✗ [${issue.kind}] ${issue.entity}: ${issue.message}`);

  if (report.issues.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("\nAll checked records and associations match the ledger. ✓");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
