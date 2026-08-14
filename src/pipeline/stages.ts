/**
 * Pipeline stages, config-driven. `config/world.yaml pipeline.stages` is the
 * single source of truth; the simulation, the CRM stage/date-field mapping and
 * the org-provisioning script all derive from it here.
 *
 * The terminal stage is always `Closed` (refined to won/lost by deal status);
 * every stage before it is an open stage a deal progresses through.
 */

import type { Config } from "../config/schema.js";
import type { World } from "../ledger/schema.js";

export const CLOSED_STAGE = "Closed";

/** The open (non-closed) stages, in pipeline order. */
export function openStages(cfg: Config): string[] {
  return cfg.world.pipeline.stages.filter((s) => s !== CLOSED_STAGE);
}

/** Map elapsed-fraction of the sales cycle to an open stage. */
export function stageForFraction(stages: string[], frac: number): string {
  const idx = Math.max(0, Math.min(stages.length - 1, Math.floor(frac * stages.length)));
  return stages[idx]!;
}

/** Position of a stage in pipeline order; past-the-end for Closed/unknown. */
export function stageRank(stages: string[], stage: string): number {
  const idx = stages.indexOf(stage);
  return idx === -1 ? stages.length : idx;
}

/**
 * The Salesforce datetime custom field recording when a deal entered a stage.
 * Derived by convention (`Stage_<Stage>_At__c`), so the reconciler and the
 * provisioning script (`npm run sf:stage-fields`) can never disagree about a
 * field's name.
 */
export function stageDateField(stage: string): string {
  return `Stage_${stage.replace(/\W+/g, "_")}_At__c`;
}

/** All stage-date fields for a config: every open stage plus Closed. */
export function stageDateFields(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const stage of [...openStages(cfg), CLOSED_STAGE]) out[stage] = stageDateField(stage);
  return out;
}

/**
 * Guard: a live world must speak the configured stage vocabulary. A renamed
 * stage on a world that already has deals is operator error (records would
 * silently stop matching), so catch it loudly before anything runs.
 */
export function validateWorldStages(world: World, cfg: Config): void {
  const known = new Set([...openStages(cfg), CLOSED_STAGE]);
  const offenders = new Map<string, number>();
  for (const opp of world.opportunities) {
    if (!known.has(opp.stage)) offenders.set(opp.stage, (offenders.get(opp.stage) ?? 0) + 1);
  }
  if (offenders.size > 0) {
    const list = [...offenders].map(([s, n]) => `"${s}" (${n} deal${n === 1 ? "" : "s"})`).join(", ");
    throw new Error(
      `state/world.json contains stages not in config/world.yaml pipeline.stages: ${list}. ` +
        `Restore the stage list (renaming stages on a live world is not supported) or migrate the ledger first.`,
    );
  }
}
