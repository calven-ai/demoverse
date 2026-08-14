/**
 * `npm run apply` is the period entrypoint. See DESIGN.md §12–13.
 *
 * Two phases, by design (the generation-request protocol):
 *
 *   Phase 1 (default): advance the deterministic world to "now", plan the prose
 *     artifacts, advance the clock, and EMIT grounded generation requests under
 *     state/requests/<periodIndex>/. The driving agent then fills the results.
 *
 *   Phase 2 (--ingest): read the filled results, validate + file them into the
 *     ledger (content store), and optionally --reconcile into the external
 *     systems. Writes a run report to runs/<date>-report.md.
 *
 * Flags:
 *   --backfill     intent flag for the first big run (advance from start to now)
 *   --ingest       phase 2: ingest filled results (+ optional --reconcile)
 *   --reconcile    push the ledger into Salesforce/Drive/Slack (idempotent)
 *   --dry-run      compute + print, but make no writes (ledger or external)
 *   --nudge="..."  Tier-3 per-run nudge; echoed back per DESIGN §11
 *   --sf-limit=N   Salesforce smoke batch: push only the first N accounts (+
 *                  their contacts/opps). Idempotent; later runs fill the rest.
 *   --backfill-touchpoints  retroactively plan the full sales-cycle touch points
 *                  (transcripts, AE notes, emails, Slack, win-loss) for EXISTING
 *                  deals, then emit their generation requests.
 *   --backfill-stage-history  one-time migration: rebuild `stageHistory` for
 *                  deals that predate the field, by replaying the engine's own
 *                  deterministic stage schedule. Verifies the replay against
 *                  every stored close date and refuses to save on any drift.
 *   --opp=<id>     scope --backfill-touchpoints / --ingest / --reconcile to a
 *                  single opportunity (its account, contacts, deal + activities).
 *   --next=N       read-only: list the next N opportunities that still need a
 *                  detail layer (no artifacts yet, or planned-but-unfilled ones).
 *                  Machine-parseable, one per line:
 *                  oppId<TAB>status<TAB>accountName<TAB>untouched|planned:K
 *   --weeks=N      force N period(s) forward from simNow even when the world is
 *                  already current. This is the on-demand "live increment" (see
 *                  `npm run pipeline`). Without it, apply only generates the
 *                  periods the real calendar has actually produced.
 *   --new-opps=N   one-off override of how many deals each advanced period
 *                  creates. The standing rate stays in state/trends.json.
 *   --refill=<artifactId>  reset ONE generated artifact back to `planned` and
 *                  re-emit its prompt, so a bad result can be regenerated during
 *                  the lint-fix loop. Refuses if the artifact (or any of its
 *                  messages/emails) already carries an external id. That would
 *                  duplicate records in Salesforce/Slack.
 */

import { loadConfig } from "../src/config/load.js";
import { loadWorld, saveWorld, Ledger } from "../src/ledger/ledger.js";
import { loadClock, saveClock, pendingPeriods, forcedPeriods, driftPeriods } from "../src/clock.js";
import { loadTrends } from "../src/trends.js";
import { advanceWorld, backfillTouchpoints, backfillStageHistory } from "../src/generation/advance.js";
import { buildRequest } from "../src/generation/prompts.js";
import { emitRequests } from "../src/generation/requests.js";
import { ingestResults } from "../src/generation/ingest.js";
import { reconcileAll, formatStats } from "../src/reconcile.js";
import { validateWorldStages } from "../src/pipeline/stages.js";
import { renderRunReport } from "../src/report.js";
import { todayISO } from "../src/util/date.js";
import { writeText, repoPath } from "../src/util/fs.js";
import { readActiveDirectives } from "../src/directives.js";
import { CohortIndex, loadCohort, saveCohort, enroll } from "../src/cohort.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const ingest = flag("ingest");
  const reconcile = flag("reconcile");
  const nudge = arg("nudge");
  const sfLimitArg = arg("sf-limit");
  const sfLimit = sfLimitArg ? Number(sfLimitArg) : undefined;
  const oppId = arg("opp");
  const backfillTp = flag("backfill-touchpoints");
  const nextArg = arg("next");
  const refillId = arg("refill");
  const weeksArg = arg("weeks");
  const newOppsArg = arg("new-opps");
  const newOppsPerPeriod = newOppsArg !== undefined ? Number(newOppsArg) : undefined;
  if (newOppsPerPeriod !== undefined && (!Number.isInteger(newOppsPerPeriod) || newOppsPerPeriod < 0)) {
    throw new Error(`--new-opps must be a non-negative integer (got "${newOppsArg}")`);
  }

  const cfg = loadConfig();
  const world = loadWorld();
  const clock = loadClock();
  const trends = loadTrends();
  // A live world must speak the configured stage vocabulary. Fail loudly, early.
  validateWorldStages(world, cfg);

  // --- --next=N: list opportunities that still need a detail layer ----------
  // Read-only. "Needs work" = no artifacts at all (untouched), or has artifacts
  // still `planned` (planted but unfilled). Those reappear here so a crashed
  // batch resumes cleanly. Ordered by opp id for a stable, deterministic queue.
  if (nextArg !== undefined) {
    const n = Number(nextArg) || 10;
    const artCount = new Map<string, number>();
    const plannedCount = new Map<string, number>();
    for (const a of world.artifacts) {
      if (!a.dealId) continue;
      artCount.set(a.dealId, (artCount.get(a.dealId) ?? 0) + 1);
      if (a.status === "planned") plannedCount.set(a.dealId, (plannedCount.get(a.dealId) ?? 0) + 1);
    }
    const ledger = new Ledger(world);
    // Cohort gate: the ledger holds far more deals than the demo org should
    // ever show, so the backfill queue walks cohort members only. Without this
    // `/backfill-opps` would happily generate a detail layer for deals that are
    // never going to leave the repo.
    const cohort = new CohortIndex();
    const pending = world.opportunities
      .filter((o) => cohort.has(o.id))
      .filter((o) => (artCount.get(o.id) ?? 0) === 0 || (plannedCount.get(o.id) ?? 0) > 0)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, n);
    for (const o of pending) {
      const planned = plannedCount.get(o.id) ?? 0;
      const state = (artCount.get(o.id) ?? 0) === 0 ? "untouched" : `planned:${planned}`;
      console.log(`${o.id}\t${o.status}\t${ledger.account(o.accountId).name}\t${state}`);
    }
    if (pending.length === 0) console.log("(no opportunities need a detail layer)");
    return;
  }

  // --- --backfill-stage-history: rebuild stage timelines for old deals ------
  // One-time migration for deals created before `stageHistory` existed. Replays
  // the engine's own schedule (deterministic), verifies the replay against each
  // deal's stored close date, and refuses to save if anything drifted.
  if (flag("backfill-stage-history")) {
    const { updated, skipped, mismatches } = backfillStageHistory(world, cfg, clock.startDate, clock.simNow);
    console.log(`Stage history: rebuilt ${updated} deal(s), ${skipped} already had one.`);
    if (mismatches.length > 0) {
      console.log(`\n✗ ${mismatches.length} replay mismatch(es). NOT saving:`);
      for (const m of mismatches.slice(0, 10)) console.log(`   ${m}`);
      if (mismatches.length > 10) console.log(`   … +${mismatches.length - 10} more`);
      process.exitCode = 1;
      return;
    }
    if (dryRun) {
      console.log("(dry-run) replay verified against every stored close date. No writes made.");
      return;
    }
    saveWorld(world);
    console.log("✓ replay verified against every stored close date; ledger saved.");
    console.log("  Next: `npm run apply -- --ingest --reconcile` to push the stage dates to Salesforce.");
    return;
  }

  // --- --refill=<artifactId>: reset one artifact for regeneration -----------
  // The lint-fix escape hatch: ingest only touches `planned` artifacts and the
  // ledger is never hand-edited, so this is the sanctioned way to regenerate a
  // bad result. Refuses once anything external exists (would duplicate records).
  if (refillId) {
    const art = world.artifacts.find((a) => a.id === refillId);
    if (!art) throw new Error(`--refill: no artifact ${refillId} in the ledger`);
    if (art.status === "planned") {
      console.log(`${refillId} is already planned. Fill its result and re-run --ingest.`);
      return;
    }
    const hasExternal =
      art.status === "reconciled" ||
      Boolean(
        art.external.salesforceId ||
        art.external.salesforceContentDocumentId ||
        art.external.driveFileId ||
        art.external.slackThreadTs,
      ) ||
      (art.messages ?? []).some((m) => m.ts) ||
      (art.emails ?? []).some((m) => m.salesforceId);
    if (hasExternal) {
      throw new Error(
        `--refill: ${refillId} already has external records (status=${art.status}). Regenerating would duplicate them. Refusing.`,
      );
    }
    delete art.messages;
    delete art.emails;
    delete art.contentHash;
    art.status = "planned";
    if (dryRun) {
      console.log(`(dry-run) would reset ${refillId} to planned and re-emit its prompt. No writes made.`);
      return;
    }
    saveWorld(world);
    const ctx = { config: cfg, ledger: new Ledger(world), seed: world.seed };
    const dir = emitRequests(clock.periodIndex, [buildRequest(ctx, art)]);
    console.log(`✓ ${refillId} reset to planned; prompt re-emitted → ${dir.replace(repoPath() + "/", "")}/`);
    console.log(
      `  Rewrite its result file, then \`npm run apply -- --ingest${art.dealId ? ` --opp=${art.dealId}` : ""}\`.`,
    );
    return;
  }

  // The engine echoes back how it resolved any directive/nudge before applying.
  const active = readActiveDirectives();
  if (active.length > 0) {
    console.log("Active directives (Tier 2) in force:");
    for (const d of active) console.log(`  • ${d}`);
  }
  if (nudge)
    console.log(
      `\nResolving Tier-3 nudge → "${nudge}"\n  (applied to this period's prose generation only; not remembered)\n`,
    );

  // --- Phase 2: ingest filled results --------------------------------------
  if (ingest) {
    const planned = world.artifacts.filter((a) => a.status === "planned" && (!oppId || a.dealId === oppId));
    const ctx = { config: cfg, ledger: new Ledger(world), seed: world.seed };
    const requests = planned.map((a) => buildRequest(ctx, a));
    const report = ingestResults(world, cfg, clock.periodIndex, requests);
    console.log(
      `Ingest: filled=${report.filled.length} pending=${report.pending.length} invalid=${report.invalid.length}`,
    );
    for (const inv of report.invalid) console.log(`  ⚠ ${inv.artifactId}: ${inv.reason}`);

    let stats;
    if (!dryRun) saveWorld(world);
    if (reconcile) {
      if (oppId) console.log(`Reconcile scoped to a single opportunity: ${oppId}.`);
      else if (sfLimit)
        console.log(`Salesforce smoke batch: first ${sfLimit} account(s) + their contacts/opps.`);
      stats = await reconcileAll(world, cfg, { dryRun, limit: sfLimit, oppId });
      console.log("\nReconcile:\n" + formatStats(stats));
      if (!dryRun) saveWorld(world);
    }

    const stillPending = world.artifacts.filter((a) => a.status === "planned").length;
    const date = todayISO();
    const md = renderRunReport({
      date,
      nudge,
      periods: [],
      world,
      cfg,
      trends,
      startDate: clock.startDate,
      simNow: clock.simNow,
      reconcile: stats,
      pendingArtifacts: stillPending,
    });
    if (!dryRun) writeText(repoPath("runs", `${date}-report.md`), md);
    console.log(`\n${dryRun ? "(dry-run) " : ""}Run report → runs/${date}-report.md`);
    if (stillPending > 0)
      console.log(`Note: ${stillPending} artifact(s) still need generation. Fill them and re-run --ingest.`);
    return;
  }

  // --- Phase 1b: backfill touch points for existing deal(s) ----------------
  // Retroactively plants the full sales-cycle touch-point set on deals that were
  // already advanced/closed (the live engine only plants them going forward).
  if (backfillTp) {
    const ctx = { config: cfg, ledger: new Ledger(world), seed: world.seed };
    if (dryRun) {
      const clone = structuredClone(world);
      const { plannedArtifactIds } = backfillTouchpoints(clone, cfg, oppId, clock.simNow);
      console.log(
        `(dry-run) would plan ${plannedArtifactIds.length} touch-point artifact(s)${oppId ? ` for ${oppId}` : " across all deals"}. No writes made.`,
      );
      return;
    }
    const { plannedArtifactIds } = backfillTouchpoints(world, cfg, oppId, clock.simNow);
    saveWorld(world);
    const stillPlanned = world.artifacts.filter(
      (a) => a.status === "planned" && (!oppId || a.dealId === oppId),
    );
    const requests = stillPlanned.map((a) => buildRequest(ctx, a));
    const dir = emitRequests(clock.periodIndex, requests);
    console.log(
      `✓ planned ${plannedArtifactIds.length} touch-point artifact(s)${oppId ? ` for ${oppId}` : " across all deals"}`,
    );
    console.log(`✓ emitted ${requests.length} generation request(s) → ${dir.replace(repoPath() + "/", "")}/`);
    console.log("\nNext:");
    console.log("  1. Fill each request under that folder (results/<id>.md | .json).");
    console.log(
      `  2. Run \`npm run apply -- --ingest --reconcile${oppId ? ` --opp=${oppId}` : ""}\` to file + push.`,
    );
    console.log("  3. Run `npm run lint` to verify coherence.");
    return;
  }

  // --- Phase 1: advance + emit requests ------------------------------------
  const today = todayISO();
  // --weeks=N forces the increment; without it the real calendar decides how
  // many periods are owed. Forcing is the normal path for `npm run pipeline`:
  // the operator moves the pipeline when they want it to move.
  const forced = weeksArg !== undefined ? Math.max(1, Number(weeksArg) || 1) : 0;
  const periods = forced > 0 ? forcedPeriods(clock, forced) : pendingPeriods(clock, today);
  if (periods.length === 0) {
    console.log(`World already current (simNow=${clock.simNow}, today=${today}). Nothing to advance.`);
    console.log("  To run an increment anyway: `npm run pipeline` (or `npm run apply -- --weeks=1`).");
    return;
  }
  const lastEnd = periods[periods.length - 1]!.end;
  if (forced > 0) {
    console.log(`Forced increment: ${periods.length} period(s) from ${clock.simNow} → ${lastEnd}`);
    const driftAfter = driftPeriods({ ...clock, simNow: lastEnd }, today);
    if (driftAfter > 0) {
      console.log(
        `  ⚠ the world will sit ${driftAfter} ${clock.period}(s) ahead of the real calendar (today=${today}).`,
      );
      console.log(
        "    Records this run creates carry those future dates. Let real time catch up before forcing more.",
      );
    }
  } else {
    console.log(
      `${flag("backfill") ? "Backfill" : "Advancing"}: ${periods.length} period(s) from ${clock.simNow} → ${today}`,
    );
  }
  if (newOppsPerPeriod !== undefined) {
    console.log(
      `Resolving --new-opps=${newOppsPerPeriod} → each advanced period creates exactly ${newOppsPerPeriod} deal(s)` +
        ` (standing rate in state/trends.json is untouched).`,
    );
  }

  if (dryRun) {
    // Advance a clone so we can preview without mutating state.
    const clone = structuredClone(world);
    const result = advanceWorld(clone, cfg, trends, clock.startDate, periods, undefined, {
      newOppsPerPeriod,
    });
    const totals = result.summaries.reduce(
      (acc, s) => ({
        newOpps: acc.newOpps + s.newOpps,
        won: acc.won + s.won,
        lost: acc.lost + s.lost,
        artifacts: acc.artifacts + s.artifactsPlanned,
      }),
      { newOpps: 0, won: 0, lost: 0, artifacts: 0 },
    );
    console.log(
      `(dry-run) would create ${totals.newOpps} opps, close ${totals.won} won / ${totals.lost} lost, plan ${totals.artifacts} artifacts. No writes made.`,
    );
    return;
  }

  const result = advanceWorld(world, cfg, trends, clock.startDate, periods, undefined, { newOppsPerPeriod });

  // Advance the clock to the last generated boundary.
  const last = periods[periods.length - 1]!;
  clock.simNow = last.end;
  clock.periodIndex = last.index;
  clock.lastRunAt = new Date().toISOString();
  saveWorld(world);
  saveClock(clock);

  // Enroll this run's new deals in the Salesforce cohort as `weekly` members.
  // They get the full detail layer, Slack included. Deliberately AFTER
  // saveWorld: cohort.json must never name a deal the ledger did not keep.
  const cohort = loadCohort();
  if (cohort.members.length > 0 && result.enrolled.length > 0) {
    const added = enroll(cohort, result.enrolled, todayISO());
    if (added > 0) {
      saveCohort(cohort);
      console.log(
        `\nCohort: enrolled ${added} new deal(s) as 'weekly' (Slack included). ${cohort.members.length} members total.`,
      );
    }
  }

  // Emit generation requests for THIS increment's touch points only.
  //
  // Not every `planned` artifact in the ledger: the world carries a standing
  // backlog of artifacts planned for deals nobody intends to fill (deals outside
  // the cohort, planted before the cohort gate existed), and re-emitting all of
  // them would bury a ten-artifact increment in a two-hundred-request bundle.
  // Leftovers are not lost. They keep their own earlier bundle on disk, and
  // `--ingest` still files any of them that get filled.
  const plantedThisRun = new Set(result.plannedArtifactIds);
  const emitting = world.artifacts.filter((a) => a.status === "planned" && plantedThisRun.has(a.id));
  const ctx = { config: cfg, ledger: new Ledger(world), seed: world.seed };
  const requests = emitting.map((a) => buildRequest(ctx, a));
  const dir = emitRequests(clock.periodIndex, requests);
  const backlog = world.artifacts.filter((a) => a.status === "planned" && !plantedThisRun.has(a.id)).length;

  const totalNew = result.summaries.reduce((n, s) => n + s.newOpps, 0);
  const totalWon = result.summaries.reduce((n, s) => n + s.won, 0);
  const totalLost = result.summaries.reduce((n, s) => n + s.lost, 0);
  console.log(
    `✓ advanced ${periods.length} period(s): +${totalNew} opps, ${totalWon} won / ${totalLost} lost`,
  );
  console.log(`✓ emitted ${requests.length} generation request(s) → ${dir.replace(repoPath() + "/", "")}/`);

  // Per-deal breakdown of THIS run's touch points. The living increment plants
  // a handful of artifacts spread over many deals (not a full detail layer on
  // one), so the operator (or `npm run pipeline`, which dispatches one filler
  // per deal) needs them grouped by opportunity, not as a flat list.
  const plantedIds = new Set(result.plannedArtifactIds);
  const byDeal = new Map<string, string[]>();
  for (const a of world.artifacts) {
    if (!plantedIds.has(a.id)) continue;
    const key = a.dealId ?? "(workspace)";
    byDeal.set(key, [...(byDeal.get(key) ?? []), `${a.id}:${a.kind}`]);
  }
  if (byDeal.size > 0) {
    const led = new Ledger(world);
    console.log(`\nTouch points planted this increment (${plantedIds.size} across ${byDeal.size} deal(s)):`);
    for (const [dealId, arts] of [...byDeal].sort((a, b) => a[0].localeCompare(b[0]))) {
      const opp = world.opportunities.find((o) => o.id === dealId);
      const label = opp
        ? `${led.account(opp.accountId).name} (${opp.stage}/${opp.status})`
        : "workspace-level (not tied to one deal)";
      console.log(`  ${dealId}\t${label}\t${arts.join(" ")}`);
    }
  }

  if (backlog > 0) {
    console.log(
      `\nNote: ${backlog} older planned artifact(s) are NOT in this bundle (earlier periods' leftovers).`,
    );
  }

  console.log("\nNext:");
  console.log("  1. Fill each request: read state/requests/<idx>/<id>.prompt.md, write the result to");
  console.log("     state/requests/<idx>/results/<id>.md (markdown) or .json (slack messages).");
  console.log("  2. Run `npm run apply -- --ingest --reconcile` to file + push everything.");
  console.log("  3. Run `npm run lint` to verify cross-system coherence.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
