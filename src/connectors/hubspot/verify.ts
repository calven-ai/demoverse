/**
 * Verify a HubSpot import: batch-read every imported `demo_world_id`, diff its
 * properties against what the importer would write today, and (optionally)
 * confirm the contact→company / deal→company / deal→contact associations
 * exist. Never writes anything.
 */

import type { World } from "../../ledger/schema.js";
import { Ledger } from "../../ledger/ledger.js";
import type { HubSpotClient } from "./client.js";
import { companyProperties, contactProperties, dealProperties, type HubSpotDataset } from "./import.js";

export interface HubSpotVerifyIssue {
  entity: string;
  kind: "missing" | "mismatch" | "missing-association";
  message: string;
}

export interface HubSpotVerifyReport {
  checked: { companies: number; contacts: number; deals: number; associations: number };
  issues: HubSpotVerifyIssue[];
}

export interface HubSpotVerifyOptions {
  checkAssociations?: boolean;
  /** Cap the number of live association checks (properties checks are always exhaustive). */
  maxAssociationChecks?: number;
  onProgress?: (message: string) => void;
}

async function forEachLimited<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
}

export async function verifyHubSpotDataset(
  client: HubSpotClient,
  world: World,
  dataset: HubSpotDataset,
  options: HubSpotVerifyOptions = {},
): Promise<HubSpotVerifyReport> {
  const onProgress = options.onProgress ?? (() => undefined);
  const ledger = new Ledger(world);
  const issues: HubSpotVerifyIssue[] = [];
  const checked = { companies: 0, contacts: 0, deals: 0, associations: 0 };

  const companyIdByLedgerId = new Map<string, string>();
  if (dataset.accounts.length > 0) {
    const properties = Object.keys(companyProperties(dataset.accounts[0]!));
    const result = await client.batchRead(
      "companies",
      dataset.accounts.map((account) => account.id),
      properties,
      "demo_world_id",
    );
    const byLedgerId = new Map(
      result.results.map((record) => [record.properties.demo_world_id ?? "", record]),
    );
    for (const account of dataset.accounts) {
      checked.companies++;
      const record = byLedgerId.get(account.id);
      if (!record) {
        issues.push({ entity: account.id, kind: "missing", message: "company not found in HubSpot" });
        continue;
      }
      companyIdByLedgerId.set(account.id, record.id);
      for (const [key, expected] of Object.entries(companyProperties(account))) {
        const actual = record.properties[key] ?? "";
        if (actual !== expected) {
          issues.push({
            entity: account.id,
            kind: "mismatch",
            message: `company.${key}: expected "${expected}", got "${actual}"`,
          });
        }
      }
    }
  }
  onProgress(`companies checked: ${checked.companies}`);

  const contactIdByLedgerId = new Map<string, string>();
  if (dataset.contacts.length > 0) {
    const properties = Object.keys(contactProperties(dataset.contacts[0]!));
    const result = await client.batchRead(
      "contacts",
      dataset.contacts.map((contact) => contact.id),
      properties,
      "demo_world_id",
    );
    const byLedgerId = new Map(
      result.results.map((record) => [record.properties.demo_world_id ?? "", record]),
    );
    for (const contact of dataset.contacts) {
      checked.contacts++;
      const record = byLedgerId.get(contact.id);
      if (!record) {
        issues.push({ entity: contact.id, kind: "missing", message: "contact not found in HubSpot" });
        continue;
      }
      contactIdByLedgerId.set(contact.id, record.id);
      for (const [key, expected] of Object.entries(contactProperties(contact))) {
        const actual = record.properties[key] ?? "";
        if (actual !== expected) {
          issues.push({
            entity: contact.id,
            kind: "mismatch",
            message: `contact.${key}: expected "${expected}", got "${actual}"`,
          });
        }
      }
    }
  }
  onProgress(`contacts checked: ${checked.contacts}`);

  const dealIdByLedgerId = new Map<string, string>();
  if (dataset.opportunities.length > 0) {
    const pipelines = (await client.dealPipelines()).filter((pipeline) => !pipeline.archived);
    const pipeline =
      pipelines.find((candidate) => candidate.id === "default") ??
      pipelines.sort((a, b) => a.displayOrder - b.displayOrder)[0];
    if (!pipeline) throw new Error("HubSpot has no active deal pipeline");

    const expectedByOppId = new Map<string, Record<string, string>>();
    for (const opportunity of dataset.opportunities) {
      try {
        const owner = ledger.rep(opportunity.ownerRepId);
        const manager = owner.managerId ? ledger.rep(owner.managerId) : undefined;
        expectedByOppId.set(opportunity.id, dealProperties(opportunity, owner, manager, pipeline));
      } catch (error) {
        issues.push({ entity: opportunity.id, kind: "mismatch", message: (error as Error).message });
      }
    }
    const properties = Object.keys([...expectedByOppId.values()][0] ?? {});
    if (properties.length > 0) {
      const result = await client.batchRead(
        "deals",
        [...expectedByOppId.keys()],
        properties,
        "demo_world_id",
      );
      const byLedgerId = new Map(
        result.results.map((record) => [record.properties.demo_world_id ?? "", record]),
      );
      for (const [oppId, expected] of expectedByOppId) {
        checked.deals++;
        const record = byLedgerId.get(oppId);
        if (!record) {
          issues.push({ entity: oppId, kind: "missing", message: "deal not found in HubSpot" });
          continue;
        }
        dealIdByLedgerId.set(oppId, record.id);
        for (const [key, expectedValue] of Object.entries(expected)) {
          // HubSpot round-trips datetimes in a different string format than we send.
          if (key === "closedate" || key === "demo_world_original_created_at") continue;
          const actual = record.properties[key] ?? "";
          if (actual !== expectedValue) {
            issues.push({
              entity: oppId,
              kind: "mismatch",
              message: `deal.${key}: expected "${expectedValue}", got "${actual}"`,
            });
          }
        }
      }
    }
  }
  onProgress(`deals checked: ${checked.deals}`);

  if (options.checkAssociations ?? true) {
    const cap = options.maxAssociationChecks ?? Infinity;

    await forEachLimited(dataset.opportunities, 5, async (opportunity) => {
      if (checked.associations >= cap) return;
      const dealId = dealIdByLedgerId.get(opportunity.id);
      if (!dealId) return;
      checked.associations++;
      const record = await client.getWithAssociations("deals", dealId, ["companies", "contacts"]);
      const companyId = companyIdByLedgerId.get(opportunity.accountId);
      const associatedCompanyIds = new Set((record?.associations?.companies?.results ?? []).map((r) => r.id));
      if (companyId && !associatedCompanyIds.has(companyId)) {
        issues.push({
          entity: opportunity.id,
          kind: "missing-association",
          message: `deal→company association missing (account ${opportunity.accountId})`,
        });
      }
      const associatedContactIds = new Set((record?.associations?.contacts?.results ?? []).map((r) => r.id));
      for (const sourceContactId of opportunity.contactIds) {
        const contactId = contactIdByLedgerId.get(sourceContactId);
        if (contactId && !associatedContactIds.has(contactId)) {
          issues.push({
            entity: opportunity.id,
            kind: "missing-association",
            message: `deal→contact association missing (contact ${sourceContactId})`,
          });
        }
      }
    });
    onProgress(`deal associations checked: ${Math.min(checked.associations, dataset.opportunities.length)}`);

    await forEachLimited(dataset.contacts, 5, async (contact) => {
      if (checked.associations >= cap) return;
      const contactId = contactIdByLedgerId.get(contact.id);
      const companyId = companyIdByLedgerId.get(contact.accountId);
      if (!contactId || !companyId) return;
      checked.associations++;
      const record = await client.getWithAssociations("contacts", contactId, ["companies"]);
      const associatedCompanyIds = new Set((record?.associations?.companies?.results ?? []).map((r) => r.id));
      if (!associatedCompanyIds.has(companyId)) {
        issues.push({
          entity: contact.id,
          kind: "missing-association",
          message: `contact→company association missing (account ${contact.accountId})`,
        });
      }
    });
    onProgress(`association checks completed: ${checked.associations}`);
  }

  return { checked, issues };
}
