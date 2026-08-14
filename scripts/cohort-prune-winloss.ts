/**
 * `npm run cohort:prune-winloss` thins win-loss artifacts down to a target rate.
 *
 * Win-loss is meant to be SCARCE. A real team does not run an exit interview or
 * a survey on every closed deal, so a demo org where all 45 closed deals carry
 * one reads as generated the moment anyone browses the Drive folder. The signal
 * is worth more when its absence is also information: `config/world.yaml`'s
 * `winloss.mode_mix` sets the rate, this script brings an ALREADY-GENERATED
 * cohort back in line after that rate is lowered.
 *
 * It is the counterpart to `cohort:prune-slack`: same shape, same caution.
 *
 * Selection is deterministic (seeded on the cohort + target) and keeps the
 * won/lost balance of the surviving set proportional to the deals that have an
 * artifact today. Thinning therefore does not quietly bias the win-loss corpus
 * toward losses, which would skew everything the downstream product derives
 * from it.
 *
 * For every deal that loses its artifact the script also flips the opportunity's
 * `winLossMode` to `none`, so the ledger explains its own absence and a later
 * `apply --backfill-touchpoints` does not simply plant it again. That field is
 * mirrored to Salesforce as `Win_Loss_Mode__c`, so re-reconcile the affected
 * opportunities afterwards (the script prints the command).
 *
 *   npm run cohort:prune-winloss                    # report only
 *   npm run cohort:prune-winloss -- --keep=15       # report against a target
 *   npm run cohort:prune-winloss -- --keep=15 --confirm
 *
 * Drive files are moved to the trash (recoverable for 30 days), never a
 * permanent delete. Artifacts carrying an external id in any OTHER system are
 * refused outright rather than orphaned.
 */

import { google } from "googleapis";
import { rm } from "node:fs/promises";
import { env } from "../src/util/env.js";
import { loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { loadCohort, CohortIndex } from "../src/cohort.js";
import { Rng } from "../src/util/rng.js";
import { repoPath } from "../src/util/fs.js";

const WINLOSS_KINDS = ["survey", "interview"] as const;

const confirm = process.argv.includes("--confirm");
const keepArg = process.argv.find((a) => a.startsWith("--keep="));
const targetKeep = keepArg ? Number(keepArg.split("=")[1]) : NaN;
const restoreArg = process.argv.find((a) => a.startsWith("--restore="));

const cohortFile = loadCohort();
if (cohortFile.members.length === 0) {
  console.error("No cohort selected. Run `npm run cohort:select` first.");
  process.exit(1);
}
const cohort = new CohortIndex(cohortFile);
const world = loadWorld();

/**
 * Undo a `none` flip on one deal. Needed because a prune can be wrong in a way
 * only the linter sees afterwards. A Slack-enabled member's win/loss signal can
 * then exist nowhere. Re-plant with `apply --backfill-touchpoints` afterwards.
 */
if (restoreArg) {
  const oppId = restoreArg.split("=")[1]!;
  const opp = world.opportunities.find((o) => o.id === oppId);
  if (!opp) {
    console.error(`✗ unknown opportunity ${oppId}.`);
    process.exit(1);
  }
  if (opp.winLossMode !== "none") {
    console.error(`✗ ${oppId} is already winLossMode=${opp.winLossMode}. Nothing to restore.`);
    process.exit(1);
  }
  const mode = new Rng(`restore-winloss:${oppId}`).float() < 0.4 ? "interview" : "survey";
  console.log(`${oppId}: winLossMode none → ${mode}`);
  if (!confirm) {
    console.log(`\n[dry run] Re-run with --confirm to apply.`);
    process.exit(0);
  }
  opp.winLossMode = mode;
  saveWorld(world);
  console.log(`\n✓ restored. Now re-plant it: npm run apply -- --backfill-touchpoints --opp=${oppId}`);
  process.exit(0);
}

const byDeal = new Map<string, typeof world.artifacts>();
for (const a of world.artifacts) {
  if (!a.dealId) continue;
  const list = byDeal.get(a.dealId) ?? [];
  list.push(a);
  byDeal.set(a.dealId, list);
}

/**
 * Closed cohort deals that currently carry a survey or interview.
 *
 * Slack-enabled (`weekly`) members are excluded: for them a `none`-mode close is
 * not "no win-loss signal at all" but "the signal moved to a #win-loss post",
 * which this script does not plant. Flipping one to `none` here would strip the
 * artifact and leave the deal with no win/loss signal in any system. That is a
 * lint error, and a real hole in the story. Seed members carry no Slack, so
 * `none` genuinely means none, which is the case this script is for.
 */
const holders = world.opportunities
  .filter((o) => cohort.has(o.id) && o.stage === "Closed" && !cohort.allowsSlack(o.id))
  .map((o) => ({
    opp: o,
    artifacts: (byDeal.get(o.id) ?? []).filter((a) => (WINLOSS_KINDS as readonly string[]).includes(a.kind)),
  }))
  .filter((h) => h.artifacts.length > 0);

const closedCohort = world.opportunities.filter((o) => cohort.has(o.id) && o.stage === "Closed").length;

if (holders.length === 0) {
  console.log("No closed cohort deal carries a win-loss artifact. Nothing to prune.");
  process.exit(0);
}

const won = holders.filter((h) => h.opp.status === "won");
const lost = holders.filter((h) => h.opp.status !== "won");

console.log(
  `Win-loss coverage: ${holders.length} of ${closedCohort} closed cohort deals (${pct(holders.length, closedCohort)})`,
);
console.log(`  won  ${won.length}   lost ${lost.length}`);

if (!Number.isFinite(targetKeep)) {
  console.log(
    `\nPass --keep=<n> to thin to a target (config/world.yaml winloss.mode_mix sets the rate for FUTURE deals).`,
  );
  process.exit(0);
}
if (targetKeep < 0 || targetKeep > holders.length) {
  console.error(`\n✗ --keep must be between 0 and ${holders.length}.`);
  process.exit(1);
}

// Deterministic: same cohort + same target always selects the same survivors.
const rng = new Rng(`prune-winloss:${cohortFile.members.length}:${targetKeep}`);

// Unfilled artifacts go first. Prose that has already been written cost tokens
// and is valid content, and its Drive file is live. Dropping a `planned`
// placeholder instead costs nothing and spares an unnecessary delete. Same
// principle as cohort:prune-slack.
const unfilled = holders.filter((h) => h.artifacts.every((a) => a.status === "planned"));
const generated = holders.filter((h) => !unfilled.includes(h));
const toRemove = holders.length - targetKeep;

let doomed: typeof holders;
if (toRemove <= unfilled.length) {
  doomed = pick(unfilled, toRemove, rng);
} else {
  // Every unfilled one goes, then thin the generated set proportionally.
  const stillNeeded = targetKeep;
  const gWon = generated.filter((h) => h.opp.status === "won");
  const gLost = generated.filter((h) => h.opp.status !== "won");
  const gKeepWon = Math.min(gWon.length, Math.round(stillNeeded * (gWon.length / generated.length)));
  const gKeepLost = Math.min(gLost.length, stillNeeded - gKeepWon);
  const keptGen = new Set(
    [...pick(gWon, gKeepWon, rng), ...pick(gLost, gKeepLost, rng)].map((h) => h.opp.id),
  );
  doomed = [...unfilled, ...generated.filter((h) => !keptGen.has(h.opp.id))];
}
const doomedArtifacts = doomed.flatMap((h) => h.artifacts);

// Never strand a record in a system this script does not clean up.
const foreign = doomedArtifacts.filter((a) => {
  const e = (a.external ?? {}) as Record<string, unknown>;
  return Object.entries(e).some(([k, v]) => v && !/^drive/i.test(k));
});
if (foreign.length > 0) {
  console.error(`\n✗ ${foreign.length} artifact(s) carry a non-Drive external id. Refusing to orphan them.`);
  for (const a of foreign.slice(0, 5))
    console.error(`   ${a.id} ${a.kind} ${a.dealId} ${JSON.stringify(a.external)}`);
  process.exit(1);
}

const inDrive = doomedArtifacts.filter((a) => a.external?.driveFileId);

const survWon = holders.filter((h) => !doomed.includes(h) && h.opp.status === "won").length;
console.log(
  `\nTarget: keep ${targetKeep} (${pct(targetKeep, closedCohort)} of closed cohort deals, ${survWon} won / ${targetKeep - survWon} lost)`,
);
console.log(
  `Remove: ${doomedArtifacts.length} artifact(s) across ${doomed.length} deal(s); ${inDrive.length} have a Drive file to trash\n`,
);
for (const h of doomed) {
  const kinds = h.artifacts.map((a) => `${a.id}:${a.kind}(${a.status})`).join(" ");
  console.log(`  ${h.opp.id}  ${h.opp.status.padEnd(4)}  ${kinds}`);
}

if (!confirm) {
  console.log(`\n[dry run] Re-run with --keep=${targetKeep} --confirm to apply.`);
  process.exit(0);
}

// 1. Drive. Trash the files, never permanently delete them.
const auth = new google.auth.GoogleAuth({
  keyFile: env("GOOGLE_APPLICATION_CREDENTIALS", true)!,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });
let trashed = 0;
const failures: string[] = [];
for (const a of inDrive) {
  try {
    await drive.files.update({
      fileId: a.external!.driveFileId!,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    trashed++;
  } catch (err) {
    failures.push(`${a.id}: ${(err as Error).message}`);
  }
}
if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} Drive file(s) failed to trash. Ledger left untouched so this stays re-runnable:`,
  );
  for (const f of failures.slice(0, 5)) console.error(`   ${f}`);
  process.exit(1);
}

// 2. Local prose. The artifact is gone, so its content file should not linger.
for (const a of doomedArtifacts) {
  if (a.contentPath) await rm(repoPath(a.contentPath), { force: true });
}

// 3. Ledger. Drop the artifacts and record WHY each deal now has none.
const remove = new Set(doomedArtifacts.map((a) => a.id));
world.artifacts = world.artifacts.filter((a) => !remove.has(a.id));
const doomedDeals = new Set(doomed.map((h) => h.opp.id));
for (const o of world.opportunities) {
  if (doomedDeals.has(o.id)) o.winLossMode = "none";
}
saveWorld(world);

console.log(`\n✓ trashed ${trashed} Drive file(s) (recoverable for 30 days)`);
console.log(`✓ removed ${remove.size} artifact(s); ${doomedDeals.size} deal(s) set to winLossMode=none`);
console.log(`\nNext: push the winLossMode change to Salesforce's Win_Loss_Mode__c:`);
console.log(
  `  ${[...doomedDeals]
    .map((id) => `npm run apply -- --reconcile --opp=${id}`)
    .slice(0, 2)
    .join("\n  ")}${doomedDeals.size > 2 ? "\n  … (all listed above)" : ""}`,
);

function pick<T>(pool: T[], n: number, rng: Rng): T[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, n);
}

function pct(n: number, total: number): string {
  return total === 0 ? "n/a" : `${Math.round((100 * n) / total)}%`;
}
