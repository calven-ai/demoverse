/**
 * `npm run sf:stage-fields` — create the per-stage entry-date custom fields on
 * Opportunity, and grant the running user's profile read/write on them.
 *
 * The field list is DERIVED from `config/world.yaml pipeline.stages` via
 * `stageDateFields()` (src/pipeline/stages.ts) — the same function the
 * reconciler writes through — so the provisioning script and the engine can
 * never disagree about a field's name, and the org can be rebuilt from this
 * repo rather than from memory.
 *
 * Uses the Tooling API — the REST *data* API cannot create schema. Creating a
 * CustomField does NOT grant field-level security, so a freshly created field is
 * invisible (and unwritable) even to a System Administrator until FLS is set;
 * this script does both, then verifies the field is actually writable.
 *
 * Idempotent: fields that already exist are left alone.
 */

import { SalesforceClient } from "../src/connectors/salesforce/client.js";
import { env } from "../src/util/env.js";
import { loadConfig } from "../src/config/load.js";
import { stageDateFields, CLOSED_STAGE } from "../src/pipeline/stages.js";

const API = "v59.0";

const FIELDS: { name: string; label: string; description: string }[] = Object.entries(
  stageDateFields(loadConfig()),
).map(([stage, name]) => ({
  name,
  label: name.replace(/__c$/, "").replace(/_/g, " "),
  description:
    stage === CLOSED_STAGE
      ? "Date the deal closed (won or lost). Set by the demo-world engine."
      : `Date the deal entered ${stage}. Set by the demo-world engine.`,
}));

async function main(): Promise<void> {
  const client = SalesforceClient.fromEnv();
  await client.login();

  // What already exists?
  const described = await client.request<{ fields: { name: string }[] }>(
    "GET",
    `/services/data/${API}/sobjects/Opportunity/describe`,
  );
  const existing = new Set((described?.fields ?? []).map((f) => f.name));

  const missing = FIELDS.filter((f) => !existing.has(f.name));
  if (missing.length === 0) {
    console.log(`✓ all ${FIELDS.length} stage-date fields already exist on Opportunity.`);
  } else {
    console.log(`Creating ${missing.length} field(s) on Opportunity…`);
    for (const f of missing) {
      await client.request("POST", `/services/data/${API}/tooling/sobjects/CustomField`, {
        FullName: `Opportunity.${f.name}`,
        Metadata: { label: f.label, type: "Date", description: f.description, required: false },
      });
      console.log(`  + ${f.name}`);
    }
  }

  // Field-level security: a Tooling-created field is not readable or writable by
  // ANY profile until permissions are granted — including the admin that made it.
  const me = await client.query<{ ProfileId: string }>(
    `SELECT ProfileId FROM User WHERE Username = '${env("SF_USERNAME", true)!.replace(/'/g, "\\'")}'`,
  );
  const profileId = me.records[0]?.ProfileId;
  if (!profileId) throw new Error("could not resolve the running user's ProfileId");

  let granted = 0;
  for (const f of FIELDS) {
    const field = `Opportunity.${f.name}`;
    const already = await client.query<{ Id: string }>(
      `SELECT Id FROM FieldPermissions WHERE ParentId IN (SELECT Id FROM PermissionSet WHERE ProfileId = '${profileId}') AND Field = '${field}'`,
    );
    if (already.totalSize > 0) continue;
    const ps = await client.query<{ Id: string }>(
      `SELECT Id FROM PermissionSet WHERE ProfileId = '${profileId}' LIMIT 1`,
    );
    const parentId = ps.records[0]?.Id;
    if (!parentId) throw new Error("no owning PermissionSet for the profile");
    try {
      await client.upsert("FieldPermissions", {
        ParentId: parentId,
        SobjectType: "Opportunity",
        Field: field,
        PermissionsRead: true,
        PermissionsEdit: true,
      });
      granted++;
    } catch (e) {
      console.log(`  ⚠ FLS for ${f.name}: ${(e as Error).message}`);
    }
  }
  if (granted) console.log(`✓ granted read/write on ${granted} field(s)`);

  // Verify: describe again and confirm every field is present AND updateable.
  const after = await client.request<{ fields: { name: string; updateable: boolean }[] }>(
    "GET",
    `/services/data/${API}/sobjects/Opportunity/describe`,
  );
  const byName = new Map((after?.fields ?? []).map((f) => [f.name, f]));
  let ok = true;
  for (const f of FIELDS) {
    const got = byName.get(f.name);
    if (!got) {
      console.log(`✗ ${f.name} still absent`);
      ok = false;
    } else if (!got.updateable) {
      console.log(`✗ ${f.name} present but NOT writable (field-level security)`);
      ok = false;
    }
  }
  if (ok) {
    console.log("\n✓ all 5 stage-date fields exist and are writable.");
    console.log("  Next: `npm run apply -- --ingest --reconcile` to populate them.");
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
