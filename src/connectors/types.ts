/**
 * The connector contract. A connector pushes the desired ledger state into one
 * external system via idempotent upserts and must:
 *
 *  - no-op with `disabled: true` when it is switched off in
 *    `config/connectors.yaml` or its credentials are absent from the env;
 *  - honor `opts.dryRun` (compute + report, write nothing);
 *  - honor the cohort gate (`opts.cohort`), so only member deals reach the world;
 *  - record external ids on the ledger so re-runs update instead of duplicate.
 *
 * Registration lives in `./registry.ts`; the orchestrator (`src/reconcile.ts`)
 * runs connectors in registry order.
 */

import type { World } from "../ledger/schema.js";
import type { Config } from "../config/schema.js";
import type { CohortIndex } from "../cohort.js";

export interface ReconcileOptions {
  /** When true, compute and log intended actions but make no external writes. */
  dryRun: boolean;
  /**
   * CRM smoke-batch cap: push only the first N accounts (and only the
   * contacts/opportunities belonging to them). Undefined = push everything.
   */
  limit?: number;
  /**
   * Scope every system to a single opportunity (its account + contacts + the deal
   * itself + that deal's touch-point artifacts). Used for the one-opportunity
   * end-to-end test before a full backfill. Takes precedence over `limit`.
   */
  oppId?: string;
  /**
   * Cohort gate. The membership list every target filters through (see
   * src/cohort.ts). Loaded from state/cohort.json when omitted; pass it
   * explicitly to share one index across all connectors, or to override it in
   * tests. An unselected cohort passes everything.
   */
  cohort?: CohortIndex;
}

export interface ReconcileStats {
  system: string;
  created: number;
  updated: number;
  skipped: number;
  errors: { entity: string; message: string }[];
  /** True if the system was skipped entirely (disabled or credentials absent). */
  disabled?: boolean;
  note?: string;
}

export function emptyStats(system: string): ReconcileStats {
  return { system, created: 0, updated: 0, skipped: 0, errors: [] };
}

export interface Connector {
  /** Stable identifier; matches the connector's key in `config/connectors.yaml`. */
  name: string;
  reconcile(world: World, cfg: Config, opts: ReconcileOptions): Promise<ReconcileStats>;
}

/** The uniform "switched off in config" no-op. */
export function disabledStats(system: string, skipped = 0): ReconcileStats {
  return {
    ...emptyStats(system),
    disabled: true,
    skipped,
    note: `disabled in config/connectors.yaml, skipped`,
  };
}
