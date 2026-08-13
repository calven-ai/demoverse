/**
 * `npm run cohort:prune-slack` — drop UNFILLED Slack artifacts from seed cohort
 * members.
 *
 * Deals backfilled before the cohort existed were planted with Slack threads,
 * #competitive questions and #win-loss post-mortems. Seed members never post to
 * Slack, so any of those still sitting at `planned` is work that would be
 * requested, written and then never published — and, worse, keeps its deal
 * showing up in the `apply --next` queue forever, so `/backfill-opps` can never
 * report the cohort finished.
 *
 * Only `planned` artifacts are removed. Ones already GENERATED keep their prose:
 * it cost tokens to write, it is valid content, and it stays in the repo in case
 * a deal is later promoted to `weekly`. Anything carrying an external id is
 * refused outright — that would orphan a live Slack message.
 *
 *   npm run cohort:prune-slack              # report only
 *   npm run cohort:prune-slack -- --confirm # remove them
 */

import { loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { loadCohort, CohortIndex, isSlackKind } from "../src/cohort.js";

const confirm = process.argv.includes("--confirm");

const cohortFile = loadCohort();
if (cohortFile.members.length === 0) {
  console.error("No cohort selected — run `npm run cohort:select` first.");
  process.exit(1);
}
const cohort = new CohortIndex(cohortFile);
const world = loadWorld();

const doomed = world.artifacts.filter(
  (a) => a.dealId && !cohort.allowsSlack(a.dealId) && isSlackKind(a.kind) && a.status === "planned",
);
const kept = world.artifacts.filter(
  (a) => a.dealId && !cohort.allowsSlack(a.dealId) && isSlackKind(a.kind) && a.status !== "planned",
);

// Never strand a published message.
const published = doomed.filter((a) => a.external.slackThreadTs || a.external.slackChannel);
if (published.length > 0) {
  console.error(`✗ ${published.length} artifact(s) carry a Slack id despite being 'planned' — refusing.`);
  for (const a of published.slice(0, 5)) console.error(`   ${a.id} ${a.kind} ${a.dealId}`);
  process.exit(1);
}

const byKind: Record<string, number> = {};
for (const a of doomed) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

console.log(`Seed cohort members carry ${doomed.length + kept.length} Slack artifact(s):\n`);
console.log(
  `  unfilled (to remove) : ${doomed.length}  ${
    Object.entries(byKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ") || "—"
  }`,
);
console.log(`  already written (keep): ${kept.length}  — prose retained, simply never published`);

const deals = [...new Set(doomed.map((a) => a.dealId))];
if (doomed.length > 0) {
  console.log(
    `\n  affects ${deals.length} deal(s): ${deals.slice(0, 10).join(", ")}${deals.length > 10 ? " …" : ""}`,
  );
}

if (doomed.length === 0) {
  console.log(`\nNothing to prune.`);
  process.exit(0);
}

if (!confirm) {
  console.log(`\n[dry run] Re-run with --confirm to remove them.`);
  process.exit(0);
}

const remove = new Set(doomed.map((a) => a.id));
world.artifacts = world.artifacts.filter((a) => !remove.has(a.id));
saveWorld(world);
console.log(`\n✓ removed ${remove.size} unfilled Slack artifact(s). Verify with: npm run apply -- --next=5`);
