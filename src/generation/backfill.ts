/**
 * Retroactive planners — replay a deal's stage history and plant its whole
 * sales-cycle touch-point set on demand. Split from advance.ts.
 */

import { Rng } from "../util/rng.js";
import { addWeeks, daysBetween, isBefore, type ISODate } from "../util/date.js";
import type { Config } from "../config/schema.js";
import { CohortIndex } from "../cohort.js";
import { Ledger } from "../ledger/ledger.js";
import type { World } from "../ledger/schema.js";
import { openStages, stageForFraction, stageRank } from "../pipeline/stages.js";
import { closeTarget } from "./advance.js";
import { planArtifact, artifactDetail, planDealTouchpoints, type PlanFn } from "./touchpoints.js";

/**
 * Rebuild `stageHistory` for deals created before the field existed.
 *
 * This REPLAYS the engine's own schedule rather than inventing dates: the cycle
 * length is a pure function of the seed and the deal id (`cycleWeeks`), the
 * stage boundaries sit at fixed fractions of that cycle (`stageForFraction`),
 * and transitions are only ever evaluated on a period boundary. Walking the
 * same weekly boundaries from `startDate` therefore reproduces exactly the
 * transitions the original run would have recorded.
 *
 * Deals that already carry a history are left untouched, so this is safe to
 * re-run. The returned `mismatches` are the integrity check: a replayed close
 * date that disagrees with the stored `closeDate` (or a final stage that
 * disagrees with `stage`) means the replay drifted from the original run and
 * the result must not be trusted.
 */
export function backfillStageHistory(
  world: World,
  cfg: Config,
  startDate: ISODate,
  simNow: ISODate,
): { updated: number; skipped: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let updated = 0;
  let skipped = 0;

  for (const opp of world.opportunities) {
    if (opp.stageHistory.length > 0) {
      skipped++;
      continue;
    }
    const history: { stage: string; date: ISODate }[] = [{ stage: "Discovery", date: opp.createdDate }];
    const target = closeTarget(world, cfg, opp);
    let stage = "Discovery";
    let closedOn: ISODate | undefined;

    // Same (start, end] weekly boundaries the clock hands to advanceWorld.
    let cursor = startDate;
    // Guard against a pathological loop; 520 periods = the clock's own cap.
    for (let guard = 0; guard < 520; guard++) {
      const end = addWeeks(cursor, 1);
      // Only periods the clock has actually generated exist. Stepping past
      // simNow would advance open deals a stage further than the real run did.
      if (isBefore(simNow, end)) break;
      cursor = end;
      if (isBefore(end, opp.createdDate)) continue; // deal not created yet
      if (!isBefore(end, target)) {
        closedOn = end;
        break;
      }
      const frac = daysBetween(opp.createdDate, end) / Math.max(1, daysBetween(opp.createdDate, target));
      const newStage = stageForFraction(openStages(cfg), frac);
      if (newStage !== stage && stageRank(openStages(cfg), newStage) > stageRank(openStages(cfg), stage)) {
        stage = newStage;
        history.push({ stage, date: end });
      }
    }

    if (opp.status === "open") {
      if (stage !== opp.stage) mismatches.push(`${opp.id}: replayed stage ${stage} ≠ stored ${opp.stage}`);
    } else {
      if (!closedOn) {
        mismatches.push(`${opp.id}: decided deal never reached its close boundary in replay`);
      } else {
        if (opp.closeDate && closedOn !== opp.closeDate) {
          mismatches.push(`${opp.id}: replayed close ${closedOn} ≠ stored ${opp.closeDate}`);
        }
        history.push({ stage: "Closed", date: opp.closeDate ?? closedOn });
      }
    }

    opp.stageHistory = history;
    updated++;
  }
  return { updated, skipped, mismatches };
}

export function backfillTouchpoints(
  world: World,
  cfg: Config,
  oppId: string | undefined,
  horizonDate: ISODate,
  /** Cohort gate; loaded from state/cohort.json when omitted. Pass an empty
   *  CohortIndex to plant the full set regardless of membership (tests). */
  cohortIndex?: CohortIndex,
): { plannedArtifactIds: string[] } {
  const ledger = new Ledger(world);
  const targets = oppId ? [ledger.opportunity(oppId)] : [...world.opportunities];
  const plannedArtifactIds: string[] = [];
  const planned: PlanFn = (a) => {
    const art = planArtifact(world, a);
    art.detailLevel = artifactDetail(cfg, art.kind);
    plannedArtifactIds.push(art.id);
  };
  // Slack is decided per deal by cohort membership, not globally: the one-time
  // `seed` backfill posts nothing (its volume would bury the handful of live
  // threads that are the point of the Slack story), while deals added week by
  // week get the full layer. Deciding this at PLANTING time — not just at push
  // time — means no prose is ever generated for a destination it cannot reach.
  const cohort = cohortIndex ?? new CohortIndex();
  for (const opp of targets) {
    if (world.artifacts.some((a) => a.dealId === opp.id)) continue; // already backfilled
    const rng = new Rng(`${world.seed}|backfill|${opp.id}`);
    planDealTouchpoints(world, cfg, ledger, opp, horizonDate, planned, rng, cohort.allowsSlack(opp.id));
  }
  return { plannedArtifactIds };
}
