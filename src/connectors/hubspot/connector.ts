/**
 * HubSpot as a registered CRM connector, structure only (companies, contacts,
 * deals, associations; no activity timeline or files). Wraps the deterministic
 * importer (./import.ts), which is also drivable standalone via
 * `npm run hubspot:import`.
 *
 * Disabled by default in `config/connectors.yaml`: most operators run one CRM,
 * and the standalone scripts remain the primary path for seeding a dedicated
 * connector-test portal.
 */

import type { World } from "../../ledger/schema.js";
import type { Config } from "../../config/schema.js";
import { hasEnv } from "../../util/env.js";
import {
  type Connector,
  type ReconcileOptions,
  type ReconcileStats,
  emptyStats,
  disabledStats,
} from "../types.js";
import { CohortIndex } from "../../cohort.js";
import { HubSpotClient } from "./client.js";
import { selectHubSpotDataset, importHubSpotDataset, type HubSpotDataset } from "./import.js";

export async function reconcileHubspot(
  world: World,
  cfg: Config,
  opts: ReconcileOptions,
): Promise<ReconcileStats> {
  if (!cfg.connectors.hubspot.enabled) return disabledStats("hubspot");
  const stats = emptyStats("hubspot");

  // Same gate as every destination: only cohort members leave the repo.
  const cohort = opts.cohort ?? new CohortIndex();
  const scope = opts.oppId
    ? ({ kind: "opportunity", oppId: opts.oppId } as const)
    : ({ kind: "all" } as const);
  const full = selectHubSpotDataset(world, scope);
  const dataset: HubSpotDataset = cohort.active
    ? (() => {
        const opportunities = full.opportunities.filter((o) => cohort.has(o.id));
        const acctIds = new Set(opportunities.map((o) => o.accountId));
        const keepContacts = new Set(opportunities.flatMap((o) => o.contactIds));
        return {
          accounts: full.accounts.filter((a) => acctIds.has(a.id)),
          contacts: full.contacts.filter((c) => keepContacts.has(c.id)),
          opportunities,
        };
      })()
    : full;
  const total = dataset.accounts.length + dataset.contacts.length + dataset.opportunities.length;
  if (opts.oppId && dataset.opportunities.length === 0) {
    stats.note = `opportunity ${opts.oppId} not found or not in the cohort, skipped`;
    return stats;
  }

  if (!hasEnv("HUBSPOT_ACCESS_TOKEN")) {
    stats.disabled = true;
    stats.note = "HubSpot credentials absent (.env), skipped";
    stats.skipped = total;
    return stats;
  }

  if (opts.dryRun) {
    stats.note = `dry-run (${dataset.accounts.length} companies / ${dataset.contacts.length} contacts / ${dataset.opportunities.length} deals)`;
    stats.skipped = total;
    return stats;
  }

  const client = HubSpotClient.fromEnv();
  const result = await importHubSpotDataset(client, world, dataset);
  for (const bucket of [result.companies, result.contacts, result.deals]) {
    stats.created += bucket.created;
    stats.updated += bucket.updated;
  }
  stats.errors.push(...result.errors);
  stats.note = "structure only (companies/contacts/deals + associations)";
  return stats;
}

export const hubspotConnector: Connector = { name: "hubspot", reconcile: reconcileHubspot };
