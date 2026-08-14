/**
 * Reversible cleanup of a HubSpot test account: finds every company, contact,
 * and deal that carries a `demo_world_id` (i.e. every record this engine could
 * have created) and archives it (the HubSpot recycling bin keeps it restorable
 * for 90 days). Strictly scoped to `demo_world_id`-tagged records; never touches
 * anything else in the portal.
 *
 * Defaults to a dry-run (list + count only). Pass --confirm to actually archive.
 *
 *   npm run hubspot:purge                # dry-run: list what would be archived
 *   npm run hubspot:purge -- --confirm    # actually archive
 */

import { HubSpotClient, type HubSpotObjectType } from "../src/connectors/hubspot/client.js";

const OBJECT_TYPES: HubSpotObjectType[] = ["deals", "contacts", "companies"]; // children before parents

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const client = HubSpotClient.fromEnv();

  const found = new Map<HubSpotObjectType, { id: string; demoWorldId: string }[]>();
  for (const objectType of OBJECT_TYPES) {
    const results = await client.searchByHasProperty(objectType, "demo_world_id", ["demo_world_id"]);
    found.set(
      objectType,
      results.map((record) => ({ id: record.id, demoWorldId: record.properties.demo_world_id ?? "" })),
    );
  }

  console.log(`${confirm ? "Archiving" : "(dry-run) Would archive"} demo_world_id-tagged records:`);
  let total = 0;
  for (const objectType of OBJECT_TYPES) {
    const records = found.get(objectType) ?? [];
    total += records.length;
    console.log(`  ${objectType}: ${records.length}`);
    for (const record of records.slice(0, 20))
      console.log(`    • ${record.demoWorldId} (hubspot id ${record.id})`);
    if (records.length > 20) console.log(`    … and ${records.length - 20} more`);
  }

  if (total === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!confirm) {
    console.log(`\n${total} record(s) would be archived. Rerun with --confirm to actually archive them.`);
    return;
  }

  for (const objectType of OBJECT_TYPES) {
    const records = found.get(objectType) ?? [];
    if (records.length === 0) continue;
    await client.batchArchive(
      objectType,
      records.map((record) => record.id),
    );
    console.log(`Archived ${records.length} ${objectType}.`);
  }
  console.log(`\nDone. ${total} record(s) archived (restorable from HubSpot's recycling bin for 90 days).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
