/**
 * Import CRM structure (companies, contacts, deals, associations — no
 * activities) into a dedicated HubSpot test account.
 *
 *   npm run hubspot:import -- --dry-run                       # bounded pilot preview (no writes)
 *   npm run hubspot:import                                     # bounded pilot (3 companies × 3 deals)
 *   npm run hubspot:import -- --accounts=5 --deals-per-account=5
 *   npm run hubspot:import -- --opp=opp-042                    # one opportunity + its account/contacts
 *   npm run hubspot:import -- --all --dry-run                  # full-ledger preflight (no writes)
 *   npm run hubspot:import -- --all                             # full-ledger import
 *
 * `--all` is never the implicit default — it must be passed explicitly. Every
 * record is upserted by its unique `demo_world_id`, so reruns (including a
 * `--all` after a `--opp=` pilot) update existing records instead of
 * duplicating them.
 */

import { HubSpotClient } from "../src/connectors/hubspot/client.js";
import {
  importHubSpotDataset,
  selectHubSpotDataset,
  type HubSpotScope,
} from "../src/connectors/hubspot/import.js";
import { ensureHubSpotSchema } from "../src/connectors/hubspot/schema.js";
import { loadWorld } from "../src/ledger/ledger.js";
import { repoPath, writeJson } from "../src/util/fs.js";

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
  const accountsGiven = arg("accounts") !== undefined || arg("deals-per-account") !== undefined;
  if (all && opp) throw new Error("Pass either --all or --opp=<id>, not both");
  if (all && accountsGiven)
    throw new Error("--all imports every account; --accounts/--deals-per-account do not apply");
  if (opp && accountsGiven)
    throw new Error("--opp imports one opportunity; --accounts/--deals-per-account do not apply");
  if (all) return { kind: "all" };
  if (opp) return { kind: "opportunity", oppId: opp };
  return {
    kind: "pilot",
    accountLimit: integerArg("accounts", 3),
    dealsPerAccount: integerArg("deals-per-account", 3),
  };
}

function describeScope(scope: HubSpotScope): string {
  if (scope.kind === "all") return "the FULL ledger (every account, contact, and opportunity)";
  if (scope.kind === "opportunity") return `opportunity ${scope.oppId} (its account + buying-group contacts)`;
  return `a bounded pilot (${scope.accountLimit} accounts × up to ${scope.dealsPerAccount} deals each)`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const scope = resolveScope();
  const world = loadWorld();
  const dataset = selectHubSpotDataset(world, scope);

  console.log(`Scope: ${describeScope(scope)}`);
  console.log(
    `${dryRun ? "(dry-run) Would import" : "Importing"} ${dataset.accounts.length} companies, ` +
      `${dataset.contacts.length} contacts, and ${dataset.opportunities.length} deals.`,
  );
  if (dataset.accounts.length <= 20 || scope.kind !== "all") {
    for (const account of dataset.accounts) console.log(`  • ${account.id}: ${account.name}`);
  }
  if (dryRun) {
    console.log("No HubSpot API calls or local writes made.");
    return;
  }

  const client = HubSpotClient.fromEnv();
  try {
    const info = await client.accountInfo();
    if (info) console.log(`\nDestination: https://${info.uiDomain}/home?portalId=${info.portalId}`);
  } catch {
    // Account-info is a nice-to-have (needs settings.account.read); never block the import on it.
  }

  console.log("\nVerifying HubSpot custom properties:");
  const schema = await ensureHubSpotSchema(client, { log: console.log });
  console.log(`Schema ready: created=${schema.created} existing=${schema.existing}`);

  const startedAt = new Date().toISOString();
  console.log("\nImporting:");
  const stats = await importHubSpotDataset(client, world, dataset, (message) =>
    console.log(`  … ${message}`),
  );
  const completedAt = new Date().toISOString();

  console.log("\nHubSpot import summary:");
  console.log(`  companies    created=${stats.companies.created} updated=${stats.companies.updated}`);
  console.log(`  contacts     created=${stats.contacts.created} updated=${stats.contacts.updated}`);
  console.log(`  deals        created=${stats.deals.created} updated=${stats.deals.updated}`);
  console.log(`  associations created=${stats.associations}`);
  console.log(`  errors       ${stats.errors.length}`);
  for (const error of stats.errors) console.log(`    ✗ ${error.entity}: ${error.message}`);

  const reportPath = repoPath("runs", `hubspot-import-${startedAt.slice(0, 19).replace(/[:]/g, "")}.json`);
  writeJson(reportPath, {
    startedAt,
    completedAt,
    scope,
    counts: {
      accounts: dataset.accounts.length,
      contacts: dataset.contacts.length,
      opportunities: dataset.opportunities.length,
    },
    stats,
  });
  console.log(`\nRun report: ${reportPath}`);

  if (stats.errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
