/**
 * Reconcile the pipeline (Accounts, Contacts, Opportunities) into Salesforce.
 * Idempotent: the ledger stores each record's salesforceId, so re-runs update.
 *
 * NOT YET WIRED. Skipped at runtime until SF_* credentials exist. The code is
 * complete so it activates the moment the org is provisioned.
 */

import { hasEnv } from "../../util/env.js";
import { readText, repoPath, fileExists } from "../../util/fs.js";
import type { World, Artifact, Opportunity } from "../../ledger/schema.js";
import { Ledger } from "../../ledger/ledger.js";
import {
  type Connector,
  type ReconcileOptions,
  type ReconcileStats,
  emptyStats,
  disabledStats,
} from "../types.js";
import type { Config } from "../../config/schema.js";
import { CohortIndex } from "../../cohort.js";
import { SalesforceClient, sfStageFor } from "./client.js";
import { stageDateFields as configStageDateFields } from "../../pipeline/stages.js";
import { ensureAeUsers } from "./users.js";
import { standardFirmographics } from "./firmographics.js";

/**
 * Deal touch points that reconcile to the Salesforce activity timeline.
 *
 * NOTE: `call_transcript` is deliberately ABSENT. Transcripts go to Google Drive
 * only (src/connectors/drive/reconcile.ts). The downstream product ingests them through its watched-folder
 * connector, and its Salesforce adapter never reads Task/ContentVersion anyway,
 * so pushing them here bought nothing and burned the org's ~5 MB data cap on
 * ContentVersion blobs. AE notes and email threads stay on the timeline: they
 * make the org look right when a human is shown the Salesforce UI.
 */
const ACTIVITY_KINDS: Artifact["kind"][] = ["ae_note", "email_exchange"];

// NOTE: we deliberately do NOT set the audit field CreatedDate on inserted
// activities. It requires the org-level "Set Audit Fields upon Record Creation"
// toggle (off in this org), and even when present it did not actually backdate
// Task/ContentVersion records. The activity timeline is driven by ActivityDate
// (set below), which needs no special permission, so the timeline still lands
// on the historical touch-point date.

export async function reconcileSalesforce(
  world: World,
  cfg: Config,
  opts: ReconcileOptions,
): Promise<ReconcileStats> {
  if (!cfg.connectors.salesforce.enabled) return disabledStats("salesforce");
  const stats = emptyStats("salesforce");
  const ledger = new Ledger(world);

  // Scope: the Salesforce cohort first. The ledger holds the full multi-hundred
  // deal history for statistical grounding, but only cohort members are meant to
  // exist in the org (see src/cohort.ts). An unselected cohort passes everything,
  // so this is a no-op until `npm run cohort:select` has run.
  const cohort = opts.cohort ?? new CohortIndex();
  let accounts = world.accounts;
  let contacts = world.contacts;
  let opportunities = world.opportunities;
  if (cohort.active) {
    opportunities = opportunities.filter((o) => cohort.has(o.id));
    const acctIds = new Set(opportunities.map((o) => o.accountId));
    accounts = accounts.filter((a) => acctIds.has(a.id));
    const keepContacts = new Set(opportunities.flatMap((o) => o.contactIds));
    contacts = contacts.filter((c) => keepContacts.has(c.id));
    stats.note = `cohort: ${opportunities.length} opps / ${accounts.length} accounts / ${contacts.length} contacts`;
  }
  if (opts.oppId) {
    const opp = world.opportunities.find((o) => o.id === opts.oppId);
    if (!opp) {
      stats.note = `opportunity ${opts.oppId} not found in ledger`;
      return stats;
    }
    // A non-member must never reach the org, even when named explicitly. That
    // is exactly how the org drifted back above its intended size before.
    if (!cohort.has(opp.id)) {
      stats.note = `opportunity ${opp.id} is not in the Salesforce cohort, skipped`;
      return stats;
    }
    opportunities = [opp];
    accounts = world.accounts.filter((a) => a.id === opp.accountId);
    const cset = new Set(opp.contactIds);
    contacts = world.contacts.filter((c) => cset.has(c.id));
    stats.note = `single opportunity: ${opp.id} (${accounts.length} account / ${contacts.length} contacts)`;
  } else if (opts.limit) {
    // Smoke-batch cap applies WITHIN the cohort, never outside it.
    accounts = accounts.slice(0, opts.limit);
    const acctIds = new Set(accounts.map((a) => a.id));
    contacts = contacts.filter((c) => acctIds.has(c.accountId));
    opportunities = opportunities.filter((o) => acctIds.has(o.accountId));
    stats.note = `smoke batch: ${accounts.length} accounts / ${contacts.length} contacts / ${opportunities.length} opps`;
  }
  const total = accounts.length + contacts.length + opportunities.length;

  if (!hasEnv("SF_USERNAME", "SF_PASSWORD")) {
    stats.disabled = true;
    stats.note = "Salesforce not provisioned (.env SF_* absent), skipped";
    stats.skipped = total;
    return stats;
  }

  if (opts.dryRun) {
    stats.note = `dry-run${opts.limit ? ` (${stats.note})` : ""}`;
    stats.skipped = total;
    return stats;
  }

  const client = SalesforceClient.fromEnv();
  await client.login();

  // AE users: ensure each deal-owning IC has a real Salesforce User (so the
  // opportunity can be OWNED by its AE). Stamps rep.external.salesforceId.
  const users = await ensureAeUsers(client, world);
  if (users.created) {
    stats.note = `${stats.note ? stats.note + "; " : ""}AE users: +${users.created} created, ${users.reused} reused`;
  }

  // Accounts
  for (const acct of accounts) {
    try {
      // NOTE: we deliberately do NOT push the derived ICP fit (acct.icpScore/
      // icpTier). The downstream product re-derives it from the raw firmographics below
      // (ICP guardrail). Only raw inputs are reconciled.
      const id = await client.upsert(
        "Account",
        {
          Name: acct.name,
          Website: acct.domain,
          Industry: acct.industry,
          Demo_World_Id__c: acct.id,
          Company_Size__c: acct.size,
          Employee_Band__c: acct.employeeBand,
          Revenue_Band__c: acct.revenueBand,
          Funding_Stage__c: acct.fundingStage,
          Region__c: acct.region,
          Triggers__c: acct.triggers.join("; "),
          Tech_Stack__c: acct.techStack.join("; "),
          // Standard fields the downstream product always imports and derives size/bands/region
          // from, a representative point inside each band (firmographics.ts).
          ...standardFirmographics(acct, cfg.world.segments.region_countries),
        },
        acct.external.salesforceId,
      );
      if (acct.external.salesforceId) stats.updated++;
      else stats.created++;
      acct.external.salesforceId = id;
    } catch (e) {
      stats.errors.push({ entity: acct.id, message: (e as Error).message });
    }
  }

  // Contacts
  for (const contact of contacts) {
    try {
      const acct = ledger.account(contact.accountId);
      const [first, ...rest] = contact.name.split(" ");
      const id = await client.upsert(
        "Contact",
        {
          FirstName: first,
          LastName: rest.join(" ") || first,
          Title: contact.title,
          Email: contact.email,
          AccountId: acct.external.salesforceId,
          Demo_World_Id__c: contact.id,
          Buying_Role__c: contact.buyingRole,
          Seniority__c: contact.seniority ?? "",
        },
        contact.external.salesforceId,
      );
      if (contact.external.salesforceId) stats.updated++;
      else stats.created++;
      contact.external.salesforceId = id;
    } catch (e) {
      stats.errors.push({ entity: contact.id, message: (e as Error).message });
    }
  }

  // Opportunities
  const oppFields = await opportunityFieldNames(client);
  const stageFieldByStage = configStageDateFields(cfg);
  const allStageFields = Object.values(stageFieldByStage);
  const missingStageFields = allStageFields.filter((f) => !oppFields.has(f));
  if (missingStageFields.length > 0) {
    stats.note = `${stats.note ? stats.note + "; " : ""}stage-date fields absent in org (${missingStageFields.length}/${allStageFields.length}), skipped`;
  }
  for (const opp of opportunities) {
    try {
      const acct = ledger.account(opp.accountId);
      // Owned by the AE (IC); the AE's manager carries the team rollup. Modeled
      // as custom fields rather than SF OwnerId (fake reps aren't SF users).
      const rep = ledger.rep(opp.ownerRepId);
      const manager = rep.managerId ? ledger.rep(rep.managerId) : undefined;
      const fields: Record<string, unknown> = {
        Name: opp.name,
        AccountId: acct.external.salesforceId,
        Account_Executive__c: rep.name,
        AE_Email__c: rep.email,
        Sales_Manager__c: manager?.name ?? "",
        Amount: opp.amount,
        StageName: sfStageFor(cfg.connectors.salesforce.stage_map, opp.stage, opp.status),
        CloseDate: opp.closeDate ?? opp.createdDate,
        // Realistic per-deal creation instant. SF's native audit CreatedDate can't
        // be backdated on update, so the demo's true creation date lives here.
        Original_Created_Date__c: opp.createdAt ?? `${opp.createdDate}T12:00:00Z`,
        Demo_World_Id__c: opp.id,
        Tier__c: opp.tier,
        Billing_Term__c: opp.billingTerm,
        Complexity__c: opp.complexity,
        Competitors__c: opp.competitors.join("; "),
        Win_Loss_Reason__c: opp.winLossReason ?? "",
        AE_Believed_Loss_Reason__c: opp.repLossReason ?? "",
        Price_Feedback__c: opp.priceFeedback ?? "",
        Product_Feedback__c: opp.productFeedback.join("; "),
        Tech_Stack_Requirements__c: opp.techStackRequirements.join("; "),
        Win_Loss_Mode__c: opp.winLossMode,
        // When the deal entered each stage, the raw material for time-in-stage
        // and pipeline-velocity analysis. Omitted while the org lacks the fields.
        ...stageDateValues(opp, stageFieldByStage, oppFields),
      };
      // Own the deal by the AE's real Salesforce User (if provisioned).
      if (rep.external.salesforceId) fields.OwnerId = rep.external.salesforceId;
      const id = await client.upsert("Opportunity", fields, opp.external.salesforceId);
      if (opp.external.salesforceId) stats.updated++;
      else stats.created++;
      opp.external.salesforceId = id;
    } catch (e) {
      stats.errors.push({ entity: opp.id, message: (e as Error).message });
    }
  }

  // Buying group → OpportunityContactRole (the per-deal contact join).
  await reconcileContactRoles(client, ledger, opportunities, stats);

  // Deal touch points → Salesforce activity timeline.
  await reconcileActivities(client, world, ledger, stats, new Set(opportunities.map((o) => o.id)));

  return stats;
}

/**
 * Per-stage entry-date custom fields on Opportunity. Salesforce's own
 * `OpportunityHistory` cannot carry this: it is system-generated, so every
 * transition would be stamped with the reconcile time instead of the simulated
 * date. Typical CRM adapters do not read that object anyway.
 *
 * Create these in Setup as **Date** fields on Opportunity. Until they exist the
 * reconciler simply omits them (see `opportunityFieldNames`), so this is safe to
 * ship ahead of the org change.
 */
// Stage-date fields are derived from config: see stageDateFields() in src/pipeline/stages.ts.

/** The Opportunity fields this org actually has, used to skip absent ones. */
async function opportunityFieldNames(client: SalesforceClient): Promise<Set<string>> {
  const described = await client.request<{ fields: { name: string }[] }>(
    "GET",
    "/services/data/v59.0/sobjects/Opportunity/describe",
  );
  return new Set((described?.fields ?? []).map((f) => f.name));
}

/** Stage-entry dates for one deal, limited to fields the org defines. */
function stageDateValues(
  opp: Opportunity,
  fieldByStage: Record<string, string>,
  available: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of opp.stageHistory) {
    const field = fieldByStage[entry.stage];
    if (field && available.has(field)) out[field] = entry.date;
  }
  return out;
}

/** SOQL `IN (…)` lists have a practical length cap. Chunk well under it. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Link each deal's buying group to its opportunity via OpportunityContactRole.
 *
 * This is the join a CRM adapter resolves the deal's primary contact through, and the only
 * place the PER-DEAL buying group is visible to it: Contact.AccountId says who
 * works at the company, not who was in THIS deal. Without these rows the
 * persona, multi-threading and "we win when PMM is in the room" stories cannot
 * be derived at all.
 *
 * Idempotent without storing ids: existing (opportunity, contact) pairs are read
 * back from the org and only missing rows are inserted. `Role` carries the
 * engine's configured buying-role vocabulary VERBATIM. The standard OCR Role
 * picklist is unrestricted in this org, so the exact enum survives the round trip
 * rather than being flattened onto Salesforce's own shorter list.
 */
async function reconcileContactRoles(
  client: SalesforceClient,
  ledger: Ledger,
  opportunities: Opportunity[],
  stats: ReconcileStats,
): Promise<void> {
  const withSfId = opportunities.filter((o) => o.external.salesforceId);
  if (withSfId.length === 0) return;

  // Read back what already exists so re-runs never duplicate a role row.
  const existing = new Map<string, { id: string; isPrimary: boolean }>();
  for (const group of chunk(withSfId, 200)) {
    const inList = group.map((o) => `'${o.external.salesforceId}'`).join(",");
    const rows = await client.query<{
      Id: string;
      OpportunityId: string;
      ContactId: string;
      IsPrimary: boolean;
    }>(
      `SELECT Id, OpportunityId, ContactId, IsPrimary FROM OpportunityContactRole WHERE OpportunityId IN (${inList})`,
    );
    for (const r of rows.records)
      existing.set(`${r.OpportunityId}|${r.ContactId}`, { id: r.Id, isPrimary: r.IsPrimary });
  }

  let created = 0;
  for (const opp of withSfId) {
    const oppSfId = opp.external.salesforceId!;
    for (const contactId of opp.contactIds) {
      try {
        const contactSfId = ledger.contact(contactId).external.salesforceId;
        if (!contactSfId) {
          stats.skipped++;
          continue;
        }
        const isPrimary = contactId === opp.primaryContactId;
        const prior = existing.get(`${oppSfId}|${contactSfId}`);
        if (prior) {
          // Only correction needed: the primary flag drifted (or was never set).
          if (prior.isPrimary !== isPrimary) {
            await client.upsert("OpportunityContactRole", { IsPrimary: isPrimary }, prior.id);
            stats.updated++;
          }
          continue;
        }
        await client.upsert("OpportunityContactRole", {
          OpportunityId: oppSfId,
          ContactId: contactSfId,
          Role: ledger.contact(contactId).buyingRole,
          IsPrimary: isPrimary,
        });
        stats.created++;
        created++;
      } catch (e) {
        stats.errors.push({ entity: `${opp.id}/${contactId}`, message: (e as Error).message });
      }
    }
  }
  if (created) {
    stats.note = `${stats.note ? stats.note + "; " : ""}contact roles: +${created}`;
  }
}

/**
 * Attach each generated deal touch point to its opportunity in Salesforce:
 *  - ae_note         → a logged Task (the note body in the Description)
 *  - email_exchange  → one Email Task per message
 *
 * Transcripts are NOT handled here. See the ACTIVITY_KINDS note above.
 *
 * Create-once: a logged activity is immutable, so anything that already carries a
 * stored id (artifact.external.salesforceId / a per-email EmailMessage.salesforceId)
 * is skipped. This keeps re-runs duplicate-free AND avoids PATCHing read-only Task
 * fields like TaskSubtype. Does NOT change artifact.status for ae_note. That also
 * reconciles to Drive, which owns the status flip. email_exchange reconciles ONLY
 * here, so once every message carries a salesforceId the artifact is marked
 * reconciled.
 */
async function reconcileActivities(
  client: SalesforceClient,
  world: World,
  ledger: Ledger,
  stats: ReconcileStats,
  dealIds: Set<string>,
): Promise<void> {
  const arts = world.artifacts.filter(
    (a) => ACTIVITY_KINDS.includes(a.kind) && a.status !== "planned" && a.dealId && dealIds.has(a.dealId),
  );
  let tasks = 0;
  for (const art of arts) {
    try {
      const opp = ledger.opportunity(art.dealId!);
      const oppSfId = opp.external.salesforceId;
      if (!oppSfId) {
        stats.skipped++;
        continue;
      }
      const rep = ledger.rep(opp.ownerRepId);
      const ownerId = rep.external.salesforceId;
      const primaryWho = opp.primaryContactId
        ? ledger.contact(opp.primaryContactId).external.salesforceId
        : undefined;

      if (art.kind === "email_exchange") {
        const emails = art.emails ?? [];
        for (const m of emails) {
          if (m.salesforceId) continue; // already logged
          const who = m.contactId ? ledger.contact(m.contactId).external.salesforceId : primaryWho;
          const fields: Record<string, unknown> = {
            Subject: (m.subject || "Email").slice(0, 255),
            Description: `From: ${m.from}\nTo: ${m.to.join(", ")}\n\n${m.body}`.slice(0, 32000),
            ActivityDate: m.date || art.date,
            Status: "Completed",
            TaskSubtype: "Email",
            WhatId: oppSfId,
          };
          if (who) fields.WhoId = who;
          if (ownerId) fields.OwnerId = ownerId;
          m.salesforceId = await client.upsert("Task", fields);
          stats.created++;
          tasks++;
        }
        // Salesforce is this kind's only destination. Fully logged means reconciled.
        if (emails.length > 0 && emails.every((m) => m.salesforceId)) art.status = "reconciled";
        continue;
      }

      // ae_note → a single Task carrying the note body (create-once).
      const content =
        art.contentPath && fileExists(repoPath(art.contentPath)) ? readText(repoPath(art.contentPath)) : "";
      if (!art.external.salesforceId) {
        const fields: Record<string, unknown> = {
          Subject: art.title.slice(0, 255),
          Description: (content || art.title).slice(0, 32000),
          ActivityDate: art.date,
          Status: "Completed",
          WhatId: oppSfId,
        };
        if (primaryWho) fields.WhoId = primaryWho;
        if (ownerId) fields.OwnerId = ownerId;
        art.external.salesforceId = await client.upsert("Task", fields);
        stats.created++;
        tasks++;
      }
    } catch (e) {
      stats.errors.push({ entity: art.id, message: (e as Error).message });
    }
  }
  if (tasks) {
    stats.note = `${stats.note ? stats.note + "; " : ""}activities: +${tasks} task(s)`;
  }
}

export const salesforceConnector: Connector = { name: "salesforce", reconcile: reconcileSalesforce };
