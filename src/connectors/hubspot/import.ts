/**
 * HubSpot CRM import: companies, contacts, deals, and their associations.
 *
 * This does not join the weekly reconciler. It is a separate, explicitly-scoped
 * push into a dedicated HubSpot test account for connector development. Three
 * scopes are supported:
 *   - "pilot"       a small bounded sample (the original connector smoke test)
 *   - "opportunity" one opportunity + its account + its buying-group contacts
 *   - "all"         every account, contact, and opportunity in the ledger
 *
 * Target companies are REAL accounts (name/domain preserved as-is) — see
 * `docs/repo-universe.md` / config/world.yaml `prospects`. Contacts and deals
 * are synthetic: contact emails are replaced with non-deliverable addresses,
 * and every record carries a `demo_world_notice` property saying so. Names —
 * company, contact and deal — are never decorated with a marker; they mirror
 * the ledger exactly, as they do in Salesforce. Records are upserted by the
 * unique `demo_world_id` property, so reruns update rather than duplicate.
 *
 * Activities (calls, notes, emails) and owner provisioning are intentionally
 * out of scope — see the plan this module implements.
 */

import type { Account, Contact, Opportunity, Rep, World } from "../../ledger/schema.js";
import { Ledger } from "../../ledger/ledger.js";
import {
  flattenBatchErrors,
  type HubSpotClient,
  type HubSpotObjectType,
  type HubSpotPipeline,
} from "./client.js";

export type HubSpotScope =
  | { kind: "pilot"; accountLimit: number; dealsPerAccount: number }
  | { kind: "opportunity"; oppId: string }
  | { kind: "all" };

export interface HubSpotDataset {
  accounts: Account[];
  contacts: Contact[];
  opportunities: Opportunity[];
}

export interface HubSpotImportStats {
  companies: { created: number; updated: number };
  contacts: { created: number; updated: number };
  deals: { created: number; updated: number };
  associations: number;
  errors: { entity: string; message: string }[];
}

export type HubSpotImportProgress = (message: string) => void;

const emptyStats = (): HubSpotImportStats => ({
  companies: { created: 0, updated: 0 },
  contacts: { created: 0, updated: 0 },
  deals: { created: 0, updated: 0 },
  associations: 0,
  errors: [],
});

function sortedById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/** Select the dataset to import for a given scope. Never mutates the ledger. */
export function selectHubSpotDataset(world: World, scope: HubSpotScope): HubSpotDataset {
  if (scope.kind === "all") {
    return {
      accounts: sortedById(world.accounts),
      contacts: sortedById(world.contacts),
      opportunities: sortedById(world.opportunities),
    };
  }

  if (scope.kind === "opportunity") {
    const opportunity = world.opportunities.find((o) => o.id === scope.oppId);
    if (!opportunity) throw new Error(`--opp: opportunity ${scope.oppId} not found in the ledger`);
    const account = world.accounts.find((a) => a.id === opportunity.accountId);
    if (!account) throw new Error(`--opp: account ${opportunity.accountId} for ${opportunity.id} not found`);
    const contactIdSet = new Set(opportunity.contactIds);
    const contacts = sortedById(world.contacts.filter((c) => contactIdSet.has(c.id)));
    return { accounts: [account], contacts, opportunities: [opportunity] };
  }

  // Bounded pilot: a deterministic mix of open/won/lost deals from the first
  // accounts that have pipeline, restricted to those deals' buying groups.
  if (!Number.isInteger(scope.accountLimit) || scope.accountLimit < 1 || scope.accountLimit > 10) {
    throw new Error("--accounts must be an integer from 1 to 10");
  }
  if (!Number.isInteger(scope.dealsPerAccount) || scope.dealsPerAccount < 1 || scope.dealsPerAccount > 10) {
    throw new Error("--deals-per-account must be an integer from 1 to 10");
  }

  const byAccount = new Map<string, Opportunity[]>();
  for (const opportunity of sortedById(world.opportunities)) {
    const list = byAccount.get(opportunity.accountId) ?? [];
    list.push(opportunity);
    byAccount.set(opportunity.accountId, list);
  }

  const accounts = sortedById(world.accounts)
    .filter((account) => (byAccount.get(account.id)?.length ?? 0) > 0)
    .slice(0, scope.accountLimit);

  const opportunities: Opportunity[] = [];
  for (const account of accounts) {
    const available = byAccount.get(account.id) ?? [];
    const selected: Opportunity[] = [];
    for (const status of ["open", "won", "lost"] as const) {
      const match = available.find(
        (opportunity) => opportunity.status === status && !selected.includes(opportunity),
      );
      if (match) selected.push(match);
      if (selected.length === scope.dealsPerAccount) break;
    }
    for (const opportunity of available) {
      if (selected.length === scope.dealsPerAccount) break;
      if (!selected.includes(opportunity)) selected.push(opportunity);
    }
    opportunities.push(...selected);
  }

  const contactIds = new Set(opportunities.flatMap((opportunity) => opportunity.contactIds));
  const contacts = sortedById(world.contacts.filter((contact) => contactIds.has(contact.id)));
  return { accounts, contacts, opportunities };
}

/**
 * Real target companies keep their real name/domain — the operator's own ICP research
 * (see config/world.yaml `prospects`). Only the pipeline layered on top (deals,
 * contacts) is synthetic, and that is called out on every record.
 */
const companyNotice =
  "Real target account tracked by the Demo-World pipeline generator. The deal and contact data on this record is synthetic, generated for CRM-connector testing.";
const fabricatedNotice = "Clearly-fabricated demo data, generated for isolated CRM-connector testing.";

export function companyProperties(account: Account): Record<string, string> {
  return {
    name: account.name,
    domain: account.domain,
    demo_world_notice: companyNotice,
    demo_world_source: account.source ?? "synthetic",
    demo_world_industry: account.industry,
    demo_world_company_size: account.size,
    demo_world_employee_band: account.employeeBand,
    demo_world_revenue_band: account.revenueBand,
    demo_world_funding_stage: account.fundingStage,
    demo_world_region: account.region,
    demo_world_triggers: account.triggers.join("; "),
    demo_world_tech_stack: account.techStack.join("; "),
  };
}

export function contactProperties(contact: Contact): Record<string, string> {
  const [first, ...rest] = contact.name.trim().split(/\s+/);
  return {
    firstname: first || "Demo",
    lastname: rest.join(" ") || "Contact",
    // Contacts are synthetic people even on a real-account company record —
    // never emit a source-lookalike or deliverable address (DESIGN §18).
    email: `${contact.id}@example.com`,
    jobtitle: contact.title,
    demo_world_notice: fabricatedNotice,
    demo_world_buying_role: contact.buyingRole,
    demo_world_seniority: contact.seniority ?? "",
  };
}

function isoDate(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toISOString();
}

function originalCreatedAt(opportunity: Opportunity): string {
  return new Date(opportunity.createdAt ?? `${opportunity.createdDate}T12:00:00.000Z`).toISOString();
}

function stageIsClosed(stage: HubSpotPipeline["stages"][number]): boolean {
  return stage.metadata?.isClosed === "true" || /^closed\b/i.test(stage.label);
}

export function hubSpotStageFor(opportunity: Opportunity, pipeline: HubSpotPipeline): string {
  const stages = pipeline.stages
    .filter((stage) => !stage.archived)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  if (stages.length === 0) throw new Error(`HubSpot pipeline "${pipeline.label}" has no active stages`);

  if (opportunity.status === "won") {
    return (
      (
        stages.find((stage) => /won/i.test(stage.label)) ??
        stages.find((stage) => Number(stage.metadata?.probability) === 1)
      )?.id ?? stages[stages.length - 1]!.id
    );
  }
  if (opportunity.status === "lost") {
    return (
      (
        stages.find((stage) => /lost/i.test(stage.label)) ??
        stages.find((stage) => stageIsClosed(stage) && Number(stage.metadata?.probability) === 0)
      )?.id ?? stages[stages.length - 1]!.id
    );
  }

  const openStages = stages.filter((stage) => !stageIsClosed(stage));
  if (openStages.length === 0) return stages[0]!.id;
  const sourceStage = ["Discovery", "Evaluation", "Proposal", "Negotiation"].indexOf(opportunity.stage);
  const ratio = Math.max(0, sourceStage) / 3;
  return openStages[Math.round(ratio * (openStages.length - 1))]!.id;
}

export function dealProperties(
  opportunity: Opportunity,
  owner: Rep,
  manager: Rep | undefined,
  pipeline: HubSpotPipeline,
): Record<string, string> {
  return {
    // The deal name mirrors the ledger exactly (same as the Salesforce
    // reconciler): no marker prefix. A prefix is user-visible text that a CRM
    // connector reads as part of the deal's identity, so the "this is synthetic"
    // signal lives in the structured `demo_world_notice` property below instead.
    dealname: opportunity.name,
    amount: String(opportunity.amount),
    pipeline: pipeline.id,
    dealstage: hubSpotStageFor(opportunity, pipeline),
    closedate: isoDate(opportunity.closeDate ?? opportunity.createdDate),
    demo_world_notice: fabricatedNotice,
    demo_world_source_stage: opportunity.stage,
    demo_world_source_status: opportunity.status,
    demo_world_tier: opportunity.tier,
    demo_world_billing_term: opportunity.billingTerm,
    demo_world_complexity: opportunity.complexity,
    demo_world_competitors: opportunity.competitors.join("; "),
    demo_world_win_loss_reason: opportunity.winLossReason ?? "",
    demo_world_ae_loss_reason: opportunity.repLossReason ?? "",
    demo_world_price_feedback: opportunity.priceFeedback ?? "",
    demo_world_product_feedback: opportunity.productFeedback.join("; "),
    demo_world_tech_requirements: opportunity.techStackRequirements.join("; "),
    demo_world_win_loss_mode: opportunity.winLossMode,
    demo_world_account_executive: owner.name,
    demo_world_ae_email: owner.email,
    demo_world_sales_manager: manager?.name ?? "",
    demo_world_original_created_at: originalCreatedAt(opportunity),
  };
}

function countUpsert(stats: { created: number; updated: number }, wasNew: boolean | undefined): void {
  if (wasNew) stats.created++;
  else stats.updated++;
}

/**
 * Import in strict dependency order — companies, contacts, deals, then
 * contact→company / deal→company / deal→contact associations — so an object
 * type is never associated before it exists. If an entire phase fails outright
 * (every record in it errored, most likely a credentials/schema/pipeline
 * problem rather than bad data), subsequent phases are skipped rather than
 * hammering the API pointlessly; partial per-record failures are logged and
 * that record's dependents are skipped individually.
 */
export async function importHubSpotDataset(
  client: HubSpotClient,
  world: World,
  dataset: HubSpotDataset,
  onProgress: HubSpotImportProgress = () => undefined,
): Promise<HubSpotImportStats> {
  const stats = emptyStats();
  const ledger = new Ledger(world);

  const pipelines = (await client.dealPipelines()).filter((pipeline) => !pipeline.archived);
  const pipeline =
    pipelines.find((candidate) => candidate.id === "default") ??
    pipelines.sort((a, b) => a.displayOrder - b.displayOrder)[0];
  if (!pipeline) throw new Error("HubSpot has no active deal pipeline");

  const companyIds = new Map<string, string>();
  if (dataset.accounts.length > 0) {
    onProgress(`companies: upserting ${dataset.accounts.length}...`);
    const result = await client.batchUpsert(
      "companies",
      "demo_world_id",
      dataset.accounts.map((account) => ({ id: account.id, properties: companyProperties(account) })),
    );
    for (const item of result.results) {
      const sourceId = item.properties.demo_world_id;
      if (sourceId) {
        companyIds.set(sourceId, item.id);
        countUpsert(stats.companies, item.new);
      }
    }
    stats.errors.push(
      ...flattenBatchErrors(
        result.errors,
        dataset.accounts.map((account) => ({ id: account.id })),
      ),
    );
    onProgress(
      `companies: created=${stats.companies.created} updated=${stats.companies.updated} errors=${result.numErrors}`,
    );
    if (companyIds.size === 0) {
      throw new Error(
        `HubSpot rejected every company in this batch (${result.numErrors} error(s)) — aborting before contacts/deals. ` +
          "Check credentials, scopes, and that `hubspot:setup` has run.",
      );
    }
  }

  const contactIds = new Map<string, string>();
  if (dataset.contacts.length > 0) {
    onProgress(`contacts: upserting ${dataset.contacts.length}...`);
    const result = await client.batchUpsert(
      "contacts",
      "demo_world_id",
      dataset.contacts.map((contact) => ({ id: contact.id, properties: contactProperties(contact) })),
    );
    for (const item of result.results) {
      const sourceId = item.properties.demo_world_id;
      if (sourceId) {
        contactIds.set(sourceId, item.id);
        countUpsert(stats.contacts, item.new);
      }
    }
    stats.errors.push(
      ...flattenBatchErrors(
        result.errors,
        dataset.contacts.map((contact) => ({ id: contact.id })),
      ),
    );
    onProgress(
      `contacts: created=${stats.contacts.created} updated=${stats.contacts.updated} errors=${result.numErrors}`,
    );
  }

  const dealIds = new Map<string, string>();
  if (dataset.opportunities.length > 0) {
    onProgress(`deals: upserting ${dataset.opportunities.length}...`);
    const dealInputs: { id: string; properties: Record<string, string> }[] = [];
    for (const opportunity of dataset.opportunities) {
      try {
        const owner = ledger.rep(opportunity.ownerRepId);
        const manager = owner.managerId ? ledger.rep(owner.managerId) : undefined;
        dealInputs.push({
          id: opportunity.id,
          properties: dealProperties(opportunity, owner, manager, pipeline),
        });
      } catch (error) {
        stats.errors.push({ entity: opportunity.id, message: (error as Error).message });
      }
    }
    if (dealInputs.length > 0) {
      const result = await client.batchUpsert("deals", "demo_world_id", dealInputs);
      for (const item of result.results) {
        const sourceId = item.properties.demo_world_id;
        if (sourceId) {
          dealIds.set(sourceId, item.id);
          countUpsert(stats.deals, item.new);
        }
      }
      stats.errors.push(...flattenBatchErrors(result.errors, dealInputs));
    }
    onProgress(`deals: created=${stats.deals.created} updated=${stats.deals.updated}`);
  }

  // Associations: contact→company, deal→company, deal→contact. Records that
  // failed to upsert simply have no id in the map above and are skipped here
  // (already reported as an error), rather than aborting the whole pass.
  const contactCompanyPairs: { fromId: string; toId: string }[] = [];
  for (const contact of dataset.contacts) {
    const contactId = contactIds.get(contact.id);
    const companyId = companyIds.get(contact.accountId);
    if (contactId && companyId) contactCompanyPairs.push({ fromId: contactId, toId: companyId });
  }
  if (contactCompanyPairs.length > 0) {
    onProgress(`associations: contact→company (${contactCompanyPairs.length})...`);
    const result = await client.batchAssociateDefault("contacts", "companies", contactCompanyPairs);
    stats.associations += result.results.length;
    stats.errors.push(
      ...flattenBatchErrors(
        result.errors,
        contactCompanyPairs.map((pair) => ({ id: pair.fromId })),
      ),
    );
  }

  const dealCompanyPairs: { fromId: string; toId: string }[] = [];
  const dealContactPairs: { fromId: string; toId: string }[] = [];
  for (const opportunity of dataset.opportunities) {
    const dealId = dealIds.get(opportunity.id);
    if (!dealId) continue;
    const companyId = companyIds.get(opportunity.accountId);
    if (companyId) dealCompanyPairs.push({ fromId: dealId, toId: companyId });
    for (const sourceContactId of opportunity.contactIds) {
      const contactId = contactIds.get(sourceContactId);
      if (contactId) dealContactPairs.push({ fromId: dealId, toId: contactId });
    }
  }
  if (dealCompanyPairs.length > 0) {
    onProgress(`associations: deal→company (${dealCompanyPairs.length})...`);
    const result = await client.batchAssociateDefault("deals", "companies", dealCompanyPairs);
    stats.associations += result.results.length;
    stats.errors.push(
      ...flattenBatchErrors(
        result.errors,
        dealCompanyPairs.map((pair) => ({ id: pair.fromId })),
      ),
    );
  }
  if (dealContactPairs.length > 0) {
    onProgress(`associations: deal→contact (${dealContactPairs.length})...`);
    const result = await client.batchAssociateDefault("deals", "contacts", dealContactPairs);
    stats.associations += result.results.length;
    stats.errors.push(
      ...flattenBatchErrors(
        result.errors,
        dealContactPairs.map((pair) => ({ id: pair.fromId })),
      ),
    );
  }

  return stats;
}

export type { HubSpotObjectType };
