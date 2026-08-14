/**
 * `npm run sf:purge` collects every way of deleting demo-world data from
 * Salesforce in one place. ALL modes are DRY-RUN BY DEFAULT: they print exactly
 * what they would delete and exit; pass `--confirm` to execute. Deleted rows
 * land in the org's Recycle Bin, where Salesforce keeps them for 15 days.
 *
 *   npm run sf:purge -- --noncohort [--confirm] [--keep-ledger-ids]
 *       Shrink the org to the cohort: delete demo records whose opportunity is
 *       not in `state/cohort.json`, leaving them intact in the ledger where they
 *       still ground the statistics. After a real run the purged records' stored
 *       Salesforce ids are cleared so the next reconcile treats them as
 *       never-pushed (skip that write-back with `--keep-ledger-ids`).
 *
 *   npm run sf:purge -- --sample [--confirm]
 *       Remove Salesforce's OWN seeded sample data (the "Edge Communications"
 *       Accounts etc. a fresh Developer Edition ships with). Only touches
 *       records where `Demo_World_Id__c` is NULL. Never the engine's records.
 *
 *   npm run sf:purge -- --activities [--opp=opp-027] [--confirm]
 *       Delete the activity records (Tasks + transcript Files) for demo
 *       opportunities and clear their stored ids in the ledger, so the next
 *       `apply -- --reconcile` re-inserts them with backdated CreatedDates.
 *
 *   npm run sf:purge -- --all [--confirm]
 *       Delete every demo-world record (Opportunities, Contacts, Accounts and
 *       their Files) so a freshly-regenerated ledger reloads cleanly. Matches
 *       `Demo_World_Id__c != null`, so it works even after the local ledger has
 *       been regenerated. Non-demo data is never touched.
 *
 * Safety model: the engine's records all carry `Demo_World_Id__c` (the ledger id
 * verbatim). `--noncohort`/`--activities`/`--all` only touch rows where it is
 * set; `--sample` only rows where it is NULL. Nothing is ever matched by name.
 */

import { SalesforceClient } from "../src/connectors/salesforce/client.js";
import { loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { loadCohort, CohortIndex } from "../src/cohort.js";

const argv = process.argv.slice(2);
const confirm = argv.includes("--confirm");
const keepLedgerIds = argv.includes("--keep-ledger-ids");
const oppArg = argv.find((a) => a.startsWith("--opp="))?.slice("--opp=".length);
const v = "59.0";

/** Deal touch points that reconcile to the Salesforce activity timeline. */
const ACTIVITY_KINDS = ["call_transcript", "ae_note", "email_exchange"];

interface DemoRecord {
  Id: string;
  Name?: string;
  CaseNumber?: string;
  Demo_World_Id__c?: string;
}

/** Every record matching a SOQL filter, paginated. */
async function records(
  sf: SalesforceClient,
  sobject: string,
  where: string,
  fields = "Id, Name",
): Promise<DemoRecord[]> {
  const out: DemoRecord[] = [];
  const res = await sf.query<DemoRecord>(`SELECT ${fields} FROM ${sobject} WHERE ${where}`);
  out.push(...res.records);
  let next = (res as unknown as { nextRecordsUrl?: string }).nextRecordsUrl;
  while (next) {
    const page = (await sf.request("GET", next)) as { records: DemoRecord[]; nextRecordsUrl?: string };
    out.push(...page.records);
    next = page.nextRecordsUrl;
  }
  return out;
}

/** ContentDocument ids for files linked to the given records (chunked IN). */
async function contentDocumentIdsOf(sf: SalesforceClient, linkedIds: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (let i = 0; i < linkedIds.length; i += 200) {
    const inClause = linkedIds
      .slice(i, i + 200)
      .map((id) => `'${id}'`)
      .join(",");
    if (!inClause) continue;
    const res = await sf.query<{ ContentDocumentId: string }>(
      `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN (${inClause})`,
    );
    for (const r of res.records) ids.add(r.ContentDocumentId);
  }
  return [...ids];
}

/** Task ids logged against the given opportunities (paginated, chunked IN). */
async function taskIdsFor(sf: SalesforceClient, oppIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < oppIds.length; i += 200) {
    const inClause = oppIds
      .slice(i, i + 200)
      .map((id) => `'${id}'`)
      .join(",");
    if (!inClause) continue;
    out.push(...(await records(sf, "Task", `WhatId IN (${inClause})`, "Id")).map((r) => r.Id));
  }
  return out;
}

async function deleteAll(
  sf: SalesforceClient,
  ids: string[],
): Promise<{ ok: number; fail: number; errors: string[] }> {
  let ok = 0,
    fail = 0;
  const errors: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = (await sf.request(
      "DELETE",
      `/services/data/v${v}/composite/sobjects?ids=${chunk.join(",")}&allOrNone=false`,
    )) as { id: string; success: boolean; errors: { message?: string }[] }[];
    for (const r of res ?? []) {
      if (r.success) ok++;
      else {
        fail++;
        if (errors.length < 5) errors.push(r.errors?.[0]?.message ?? "unknown error");
      }
    }
  }
  return { ok, fail, errors };
}

function report(label: string, count: number): void {
  console.log(`  ${label}: ${count} record(s)${confirm ? "" : " would be deleted"}`);
}

async function execDelete(sf: SalesforceClient, label: string, ids: string[]): Promise<void> {
  if (!confirm) return report(label, ids.length);
  if (ids.length === 0) return console.log(`  ${label}: none`);
  const { ok, fail, errors } = await deleteAll(sf, ids);
  console.log(`  ${label}: deleted ${ok}${fail ? `, failed ${fail} (${errors.join("; ")})` : ""}`);
}

async function connect(): Promise<SalesforceClient> {
  const sf = SalesforceClient.fromEnv();
  await sf.login();
  console.log(
    `✓ connected to ${sf.getInstanceUrl()}${confirm ? "" : "   [DRY RUN: nothing will be deleted]"}\n`,
  );
  return sf;
}

/** `--all` deletes every demo-world record. */
async function purgeAll(): Promise<void> {
  const sf = await connect();
  // Attached transcript Files first: delete the ContentDocument (its versions +
  // links cascade). Deal Tasks cascade with their parent Opportunity below.
  const opps = await records(sf, "Opportunity", "Demo_World_Id__c != null");
  await execDelete(
    sf,
    "ContentDocument",
    await contentDocumentIdsOf(
      sf,
      opps.map((r) => r.Id),
    ),
  );
  // Children before parents (Account delete cascades, but be explicit).
  await execDelete(
    sf,
    "Opportunity",
    opps.map((r) => r.Id),
  );
  for (const sobject of ["Contact", "Account"]) {
    const rows = await records(sf, sobject, "Demo_World_Id__c != null");
    await execDelete(
      sf,
      sobject,
      rows.map((r) => r.Id),
    );
  }
}

/** `--sample` removes Salesforce's own seeded sample data (Demo_World_Id__c IS NULL). */
async function purgeSample(): Promise<void> {
  const sf = await connect();
  // Child → parent order. Case first: seeded cases hang off sample contacts and
  // Salesforce refuses to delete a contact that still has one. Case has no
  // Demo_World_Id__c (the engine never creates one), so it is filtered by its
  // parents instead. Leads and Campaigns are seeded too but deliberately LEFT
  // ALONE: nothing blocks on them and the CRM adapter never reads them.
  const objects: { name: string; where: string; fields?: string }[] = [
    {
      name: "Case",
      where: "Account.Demo_World_Id__c = null AND Contact.Demo_World_Id__c = null",
      fields: "Id, CaseNumber",
    },
    { name: "Opportunity", where: "Demo_World_Id__c = null" },
    { name: "Contact", where: "Demo_World_Id__c = null" },
    { name: "Account", where: "Demo_World_Id__c = null" },
  ];
  let total = 0;
  const found: { name: string; rows: DemoRecord[] }[] = [];
  for (const { name, where, fields } of objects) {
    const rows = await records(sf, name, where, fields ?? "Id, Name");
    found.push({ name, rows });
    total += rows.length;
    console.log(`${name.padEnd(12)} ${rows.length} sample record(s)`);
    for (const r of rows.slice(0, 8)) console.log(`   · ${r.Name ?? r.CaseNumber ?? r.Id}`);
    if (rows.length > 8) console.log(`   … +${rows.length - 8} more`);
  }
  if (total === 0) {
    console.log("\n✓ No sample data present. The org holds demo-world records only.");
    return;
  }
  if (!confirm) {
    console.log(`\n(dry-run) ${total} record(s) would be deleted. Re-run with --confirm to delete.`);
    return;
  }
  console.log(`\nDeleting ${total} record(s)…`);
  let deleted = 0;
  const failures: string[] = [];
  for (const { name, rows } of found) {
    for (const row of rows) {
      try {
        await sf.request("DELETE", `/services/data/v${v}/sobjects/${name}/${row.Id}`);
        deleted++;
      } catch (e) {
        // A child row already removed by a parent cascade is not a failure.
        const msg = (e as Error).message;
        if (/ENTITY_IS_DELETED|NOT_FOUND/i.test(msg)) continue;
        failures.push(`${name} ${row.Name ?? row.CaseNumber ?? row.Id}: ${msg}`);
      }
    }
  }
  console.log(`✓ deleted ${deleted} record(s)`);
  if (failures.length) {
    console.log(`⚠ ${failures.length} failure(s):`);
    for (const f of failures.slice(0, 10)) console.log(`   ✗ ${f}`);
    process.exitCode = 1;
  }
}

/** `--noncohort` shrinks the org to the cohort; ledger keeps everything. */
async function purgeNoncohort(): Promise<void> {
  const cohortFile = loadCohort();
  if (cohortFile.members.length === 0) {
    console.error("No cohort selected. Run `npm run cohort:select` first.");
    console.error("Refusing to purge: without a cohort every demo record would qualify for deletion.");
    process.exit(1);
  }
  const cohort = new CohortIndex(cohortFile);
  const world = loadWorld();

  // Accounts to keep = those carrying a cohort opportunity. Contacts cascade
  // with their account, so they need no separate decision.
  const keepAccountIds = new Set(world.opportunities.filter((o) => cohort.has(o.id)).map((o) => o.accountId));

  const sf = await connect();
  const demoWhere = "Demo_World_Id__c != null";
  const fields = "Id, Name, Demo_World_Id__c";
  const [opps, accts, contacts] = await Promise.all([
    records(sf, "Opportunity", demoWhere, fields),
    records(sf, "Account", demoWhere, fields),
    records(sf, "Contact", demoWhere, fields),
  ]);

  const doomedOpps = opps.filter((r) => !cohort.has(r.Demo_World_Id__c!));
  const doomedAccts = accts.filter((r) => !keepAccountIds.has(r.Demo_World_Id__c!));
  const doomedAcctLedgerIds = new Set(doomedAccts.map((r) => r.Demo_World_Id__c!));
  const contactAccount = new Map(world.contacts.map((c) => [c.id, c.accountId]));
  const doomedContacts = contacts.filter((r) => {
    const acctId = contactAccount.get(r.Demo_World_Id__c!);
    return acctId !== undefined && doomedAcctLedgerIds.has(acctId);
  });
  const docIds = await contentDocumentIdsOf(
    sf,
    doomedOpps.map((r) => r.Id),
  );

  console.log(`Cohort: ${cohort.size} opportunities across ${keepAccountIds.size} accounts.\n`);
  console.log(
    `In the org now      Opportunity ${opps.length} · Account ${accts.length} · Contact ${contacts.length}`,
  );
  console.log(
    `To delete           Opportunity ${doomedOpps.length} · Account ${doomedAccts.length} · Contact ${doomedContacts.length} · ContentDocument ${docIds.length}`,
  );
  console.log(
    `To remain           Opportunity ${opps.length - doomedOpps.length} · Account ${accts.length - doomedAccts.length} · Contact ${contacts.length - doomedContacts.length}`,
  );
  console.log(
    `\nTasks (activity timeline) and OpportunityContactRole rows cascade with their parent Opportunity.\n`,
  );

  const sample = doomedAccts.slice(0, 15).map((r) => `${r.Demo_World_Id__c} ${r.Name ?? ""}`);
  console.log(`Accounts to delete (first ${sample.length} of ${doomedAccts.length}):`);
  for (const s of sample) console.log(`  ${s}`);
  if (doomedAccts.length > sample.length) console.log(`  … +${doomedAccts.length - sample.length} more`);

  // Safety rail: the cohort must actually survive. If the arithmetic says we are
  // about to empty the org, something is wrong with the match and we stop.
  const survivingOpps = opps.length - doomedOpps.length;
  if (survivingOpps < cohort.size) {
    console.error(
      `\n✗ Refusing to proceed: only ${survivingOpps} opportunities would survive but the cohort has ${cohort.size}.`,
    );
    console.error(`  Some cohort members are missing from the org. Reconcile them before purging.`);
    process.exit(1);
  }

  if (!confirm) {
    console.log(`\n[dry run] Nothing deleted. Re-run with --confirm to execute.`);
    return;
  }

  console.log(`\nDeleting…`);
  if (docIds.length > 0) await execDelete(sf, "ContentDocument", docIds);
  await execDelete(
    sf,
    "Opportunity",
    doomedOpps.map((r) => r.Id),
  );
  await execDelete(
    sf,
    "Contact",
    doomedContacts.map((r) => r.Id),
  );
  await execDelete(
    sf,
    "Account",
    doomedAccts.map((r) => r.Id),
  );

  // Write back: a purged record has no Salesforce identity any more. Leaving a
  // stale id would make the next reconcile PATCH a deleted row.
  if (!keepLedgerIds) {
    const goneOpps = new Set(doomedOpps.map((r) => r.Demo_World_Id__c!));
    const goneAccts = new Set(doomedAccts.map((r) => r.Demo_World_Id__c!));
    const goneContacts = new Set(doomedContacts.map((r) => r.Demo_World_Id__c!));
    let cleared = 0;
    for (const o of world.opportunities)
      if (goneOpps.has(o.id) && o.external.salesforceId) {
        delete o.external.salesforceId;
        cleared++;
      }
    for (const a of world.accounts)
      if (goneAccts.has(a.id) && a.external.salesforceId) {
        delete a.external.salesforceId;
        cleared++;
      }
    for (const c of world.contacts)
      if (goneContacts.has(c.id) && c.external.salesforceId) {
        delete c.external.salesforceId;
        cleared++;
      }
    // Artifacts logged against a deleted opportunity lose their Task/File ids too.
    for (const art of world.artifacts) {
      if (!art.dealId || !goneOpps.has(art.dealId)) continue;
      if (art.external.salesforceId) {
        delete art.external.salesforceId;
        cleared++;
      }
      if (art.external.salesforceContentDocumentId) {
        delete art.external.salesforceContentDocumentId;
        cleared++;
      }
      for (const m of art.emails ?? [])
        if (m.salesforceId) {
          delete m.salesforceId;
          cleared++;
        }
    }
    saveWorld(world);
    console.log(`\n✓ ledger: cleared ${cleared} stale Salesforce id(s) on purged records.`);
  }

  console.log(`\nDone. Deleted rows sit in the org's Recycle Bin for 15 days.`);
  console.log(`Verify with: npm run cohort`);
}

/** `--activities` resets Tasks + Files so reconcile re-inserts them backdated. */
async function purgeActivities(): Promise<void> {
  const world = loadWorld();
  const opps = world.opportunities.filter((o) => o.external.salesforceId && (!oppArg || o.id === oppArg));
  if (oppArg && opps.length === 0) {
    throw new Error(`Opportunity ${oppArg} not found or never reconciled to Salesforce.`);
  }
  const oppIds = opps.map((o) => o.external.salesforceId!);
  const scopeIds = new Set(opps.map((o) => o.id));
  console.log(`Scope: ${oppArg ?? "all"} → ${oppIds.length} opportunity(ies)\n`);

  const sf = await connect();
  // Transcript Files first (delete the ContentDocument → versions + links cascade).
  await execDelete(sf, "ContentDocument", await contentDocumentIdsOf(sf, oppIds));
  await execDelete(sf, "Task", await taskIdsFor(sf, oppIds));

  // Clear stored ids on the in-scope activity artifacts so reconcile re-inserts.
  let cleared = 0;
  for (const art of world.artifacts) {
    if (!ACTIVITY_KINDS.includes(art.kind) || !art.dealId || !scopeIds.has(art.dealId)) continue;
    if (art.external.salesforceId) {
      art.external.salesforceId = undefined;
      cleared++;
    }
    if (art.external.salesforceContentDocumentId) {
      art.external.salesforceContentDocumentId = undefined;
      cleared++;
    }
    for (const m of art.emails ?? []) {
      if (m.salesforceId) {
        m.salesforceId = undefined;
        cleared++;
      }
    }
  }
  if (!confirm) console.log(`\n  ledger: ${cleared} stored id(s) would be cleared`);
  else {
    saveWorld(world);
    console.log(`\n  ledger: cleared ${cleared} stored id(s) and saved`);
  }

  console.log(
    `\nDone.${confirm ? " Now run: npm run apply -- --reconcile" : " Re-run with --confirm to execute."}`,
  );
}

async function main(): Promise<void> {
  if (argv.includes("--noncohort")) return purgeNoncohort();
  if (argv.includes("--sample")) return purgeSample();
  if (argv.includes("--activities")) return purgeActivities();
  if (argv.includes("--all")) return purgeAll();
  console.log("Usage: npm run sf:purge -- <mode> [--confirm]");
  console.log("  --noncohort [--keep-ledger-ids]   shrink the org to the cohort");
  console.log("  --sample                          remove Salesforce's own seeded sample data");
  console.log("  --activities [--opp=opp-NNN]      reset activity Tasks/Files for re-insert");
  console.log("  --all                             delete every demo-world record");
  console.log("All modes are dry-run by default; add --confirm to execute.");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
