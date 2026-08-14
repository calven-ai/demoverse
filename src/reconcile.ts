/**
 * Reconcile orchestrator. See docs/architecture.md#connectors.
 *
 * Pushes the desired ledger state into the external systems via idempotent
 * upserts, running the registered connectors in registry order (CRMs first, so
 * accounts exist before Drive groups files under them). Each connector
 * independently no-ops when it is disabled in `config/connectors.yaml` or its
 * credentials are absent. The rest still run.
 */

import type { World } from "./ledger/schema.js";
import type { Config } from "./config/schema.js";
import { type ReconcileOptions, type ReconcileStats } from "./connectors/types.js";
import { allConnectors } from "./connectors/registry.js";
import { CohortIndex } from "./cohort.js";

export async function reconcileAll(
  world: World,
  cfg: Config,
  opts: ReconcileOptions,
): Promise<ReconcileStats[]> {
  // One cohort index for all systems, so a mid-run edit to cohort.json cannot
  // make two destinations disagree about who is a member.
  const scoped: ReconcileOptions = { ...opts, cohort: opts.cohort ?? new CohortIndex() };
  const results: ReconcileStats[] = [];
  for (const connector of allConnectors()) {
    results.push(await connector.reconcile(world, cfg, scoped));
  }
  return results;
}

export function formatStats(all: ReconcileStats[]): string {
  return all
    .map((s) => {
      const head = `${s.system.padEnd(11)} ${s.disabled ? "[skipped]" : ""}`;
      const body = `created=${s.created} updated=${s.updated} skipped=${s.skipped} errors=${s.errors.length}`;
      const note = s.note ? `  (${s.note})` : "";
      // Surface the actual failures (capped). An autonomous loop needs to see them.
      const errLines = s.errors.slice(0, 5).map((e) => `\n      ✗ ${e.entity}: ${e.message}`);
      const more = s.errors.length > 5 ? `\n      … +${s.errors.length - 5} more` : "";
      return `  ${head} ${body}${note}${errLines.join("")}${more}`;
    })
    .join("\n");
}

export type { ReconcileOptions, ReconcileStats };
