/**
 * `npm run assign-use-cases` backfills the primary use case onto deals that
 * predate the field, and rename them "<Account> - <Use Case>".
 *
 * Two assignment paths, because the ledger holds two kinds of deal:
 *
 *   Deals WITH prose already written. Their transcripts, notes and emails exist
 *     and are not being regenerated, so the use case is inferred FROM that prose
 *     by keyword match (config/use-cases.yaml `keywords`). The label then
 *     describes what the deal actually discusses instead of contradicting it.
 *     Where the prose is genuinely ambiguous it falls through to the weighted
 *     draw, and the report says which deals those were.
 *
 *   Deals with no prose yet. These take the ordinary competitor-weighted draw,
 *     identical to what a live run would have produced (`pickUseCase`), so
 *     backfilled and freshly-generated deals are statistically
 *     indistinguishable.
 *
 * Deterministic: seeded on the world seed + deal id, so re-running is stable.
 * Idempotent: deals that already carry a use case are left alone unless
 * `--reassign` is passed, and renaming splits an existing suffix off first so a
 * second run can never produce "Acme - CI - CI".
 *
 *   npm run assign-use-cases              # report only
 *   npm run assign-use-cases -- --confirm # write
 *   npm run assign-use-cases -- --confirm --reassign   # redo every deal
 */

import { loadConfig } from "../src/config/load.js";
import { loadWorld, saveWorld, Ledger } from "../src/ledger/ledger.js";
import { loadCohort, CohortIndex } from "../src/cohort.js";
import {
  pickUseCase,
  allocateUseCases,
  opportunityName,
  splitOpportunityName,
  useCases,
} from "../src/use-cases.js";
import { Rng } from "../src/util/rng.js";
import { readText, repoPath, fileExists } from "../src/util/fs.js";
import type { World, Opportunity } from "../src/ledger/schema.js";

const confirm = process.argv.includes("--confirm");
const reassign = process.argv.includes("--reassign");

const cfg = loadConfig();
const world = loadWorld();
const ledger = new Ledger(world);
const cohort = new CohortIndex(loadCohort());

/** All prose attached to a deal: file-backed markdown plus inline emails/messages. */
function proseFor(world: World, dealId: string): string {
  const parts: string[] = [];
  for (const a of world.artifacts) {
    if (a.dealId !== dealId || a.status === "planned") continue;
    if (a.contentPath && fileExists(repoPath(a.contentPath))) parts.push(readText(repoPath(a.contentPath)));
    for (const m of a.emails ?? []) parts.push(`${m.subject}\n${m.body}`);
    for (const m of a.messages ?? []) parts.push(m.text);
    parts.push(a.title);
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Score each use case by keyword hits. Longer keywords are worth more, since
 * "battle card" is far stronger evidence than "copy", so a single specific
 * phrase outweighs several generic ones.
 */
function inferFromProse(prose: string): { name: string; score: number; runnerUp: number } | undefined {
  if (!prose) return undefined;
  const scored = useCases(cfg)
    .map((uc) => {
      let score = 0;
      for (const kw of uc.keywords) {
        const needle = kw.toLowerCase();
        // Word-boundary matched so a short keyword cannot hit inside a longer
        // unrelated word. Longer phrases score higher: "battle card" is real
        // evidence, a single common noun is not.
        const re = new RegExp(
          `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
          "g",
        );
        const hits = prose.match(re)?.length ?? 0;
        score += hits * Math.max(1, needle.split(" ").length);
      }
      return { name: uc.name, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  if (top.score === 0) return undefined;
  return { name: top.name, score: top.score, runnerUp: scored[1]?.score ?? 0 };
}

interface Change {
  opp: Opportunity;
  account: string;
  useCase: string;
  via: "prose" | "quota" | "weighted";
  confidence?: string;
  oldName: string;
  newName: string;
}

const changes: Change[] = [];
let skipped = 0;

// Pass 1: infer from prose wherever prose exists. These are immovable. The
// label must not contradict transcripts we are not regenerating.
const inferences = new Map<string, ReturnType<typeof inferFromProse>>();
const todo: Opportunity[] = [];
for (const opp of world.opportunities) {
  if (opp.useCase && !reassign) {
    skipped++;
    continue;
  }
  const inferred = inferFromProse(proseFor(world, opp.id));
  if (inferred) inferences.set(opp.id, inferred);
  todo.push(opp);
}

// Pass 2: the COHORT gets quota-based allocation so every use case is
// represented well enough for the product to say something about it. The rest of the
// ledger draws independently. It never leaves the repo, so it only has to look
// natural, and an independent draw is the more honest model of reality.
const cohortUnassigned = todo.filter((o) => cohort.has(o.id) && !inferences.has(o.id));
const preassigned: Record<string, number> = {};
for (const o of todo) {
  if (!cohort.has(o.id)) continue;
  const inf = inferences.get(o.id);
  if (inf) preassigned[inf.name] = (preassigned[inf.name] ?? 0) + 1;
}
const allocated = allocateUseCases(
  cfg,
  cohortUnassigned.map((o) => ({ id: o.id, competitors: o.competitors })),
  preassigned,
);

for (const opp of todo) {
  const account = ledger.account(opp.accountId);
  const rng = new Rng(`${world.seed}|use-case|${opp.id}`);

  const inferred = inferences.get(opp.id);
  const useCase = inferred?.name ?? allocated.get(opp.id) ?? pickUseCase(cfg, opp.competitors, rng);
  const via: Change["via"] = inferred ? "prose" : allocated.has(opp.id) ? "quota" : "weighted";
  // Report how decisive the prose was, so a weak match is visible rather than
  // presented with the same confidence as an obvious one.
  const confidence = inferred
    ? inferred.runnerUp === 0
      ? "clear"
      : inferred.score >= inferred.runnerUp * 2
        ? "strong"
        : "narrow"
    : undefined;

  const { account: baseName } = splitOpportunityName(opp.name);
  changes.push({
    opp,
    account: account.name,
    useCase,
    via,
    confidence,
    oldName: opp.name,
    newName: opportunityName(baseName || account.name, useCase),
  });
}

// --- report -----------------------------------------------------------------
const dist: Record<string, number> = {};
const cohortDist: Record<string, number> = {};
for (const c of changes) {
  dist[c.useCase] = (dist[c.useCase] ?? 0) + 1;
  if (cohort.has(c.opp.id)) cohortDist[c.useCase] = (cohortDist[c.useCase] ?? 0) + 1;
}

console.log(`Use-case assignment: ${changes.length} deal(s) to update, ${skipped} already assigned\n`);
console.log(`Distribution (all ledger deals / cohort only):`);
for (const uc of useCases(cfg)) {
  console.log(
    `  ${uc.name.padEnd(26)} ${String(dist[uc.name] ?? 0).padStart(4)}  /  ${String(cohortDist[uc.name] ?? 0).padStart(2)}`,
  );
}

const fromProse = changes.filter((c) => c.via === "prose");
console.log(`\nInferred from existing prose: ${fromProse.length} deal(s)`);
for (const c of fromProse) {
  console.log(`  ${c.opp.id}  ${c.newName}   [${c.confidence}]`);
}

// Competitor x use-case cross-tab: proves the skew landed without collapsing
// any bucket to a single competitor.
console.log(`\nCohort cross-tab (competitor x use case):`);
const competitors = cfg.competitors.competitors.map((c) => c.name);
console.log(`  ${"".padEnd(26)}${competitors.map((c) => c.slice(0, 10).padStart(11)).join("")}`);
for (const uc of useCases(cfg)) {
  const row = competitors.map((comp) => {
    const n = changes.filter(
      (c) => cohort.has(c.opp.id) && c.useCase === uc.name && c.opp.competitors.includes(comp),
    ).length;
    return String(n).padStart(11);
  });
  console.log(`  ${uc.name.padEnd(26)}${row.join("")}`);
}

if (!confirm) {
  console.log(`\n[report only] Re-run with --confirm to write. Sample renames:`);
  for (const c of changes.filter((x) => cohort.has(x.opp.id)).slice(0, 8)) {
    console.log(`   ${c.oldName}  ->  ${c.newName}`);
  }
  process.exit(0);
}

for (const c of changes) {
  c.opp.useCase = c.useCase;
  c.opp.name = c.newName;
}

// Artifacts snapshot the deal's facts at planning time. Ones still `planned`
// have not been written yet, so their grounding must pick up the use case or the
// prompt would omit the very theme the prose is supposed to lead with.
let regrounded = 0;
for (const a of world.artifacts) {
  if (!a.dealId || a.status !== "planned") continue;
  const opp = world.opportunities.find((o) => o.id === a.dealId);
  if (!opp?.useCase) continue;
  a.grounding = { ...a.grounding, useCase: opp.useCase };
  regrounded++;
}

saveWorld(world);
console.log(`\n✓ assigned ${changes.length} use case(s); re-grounded ${regrounded} planned artifact(s).`);
console.log(`  Push the new names with: npm run apply -- --ingest --reconcile`);
