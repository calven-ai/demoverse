/**
 * Provision the custom properties used by the bounded HubSpot test-data import.
 *
 *   npm run hubspot:setup
 *   npm run hubspot:setup -- --dry-run
 */

import { HubSpotClient } from "../src/connectors/hubspot/client.js";
import { ensureHubSpotSchema } from "../src/connectors/hubspot/schema.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("HubSpot schema dry-run (no credentials or writes required):");
    await ensureHubSpotSchema(undefined, { dryRun: true, log: console.log });
    return;
  }

  const client = HubSpotClient.fromEnv();
  console.log("Provisioning HubSpot demo-world properties:");
  const result = await ensureHubSpotSchema(client, { log: console.log });
  console.log(`\nDone. created=${result.created} existing=${result.existing}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
