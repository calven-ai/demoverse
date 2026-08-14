/**
 * Coherence linter, a first-class, tested feature. See DESIGN.md §7.1, §15.
 *
 * Two layers:
 *  1. Structural integrity over the whole ledger (every opp references a real
 *     account/rep/contacts; competitors exist in config; artifacts point at real
 *     deals).
 *  2. Cross-system coherence over a sample of closed deals: each deal's generated
 *     Drive artifact (if any) and Slack thread must reference the SAME
 *     competitor(s) and the SAME win/loss reason recorded on the opportunity.
 */

import { readText, repoPath, fileExists } from "./util/fs.js";
import { Rng } from "./util/rng.js";
import type { Config } from "./config/schema.js";
import { Ledger } from "./ledger/ledger.js";
import { CohortIndex } from "./cohort.js";
import type { World, Artifact, Opportunity } from "./ledger/schema.js";

export interface LintFinding {
  severity: "error" | "warn" | "info";
  deal?: string;
  artifact?: string;
  message: string;
}

export interface LintResult {
  findings: LintFinding[];
  checkedDeals: number;
  errors: number;
  warnings: number;
}

const CONTENT_KINDS: Artifact["kind"][] = [
  "survey",
  "interview",
  "winloss_post",
  "slack_deal_thread",
  "ae_note",
  "email_exchange",
];

/** Kinds that always carry the closed outcome (and so must name the competitor). */
const FINAL_KINDS = new Set<Artifact["kind"]>(["survey", "interview", "winloss_post"]);

function artifactText(artifact: Artifact): string | null {
  if (artifact.messages && artifact.messages.length > 0) {
    return artifact.messages.map((m) => m.text).join("\n");
  }
  if (artifact.emails && artifact.emails.length > 0) {
    return artifact.emails.map((e) => `${e.subject}\n${e.body}`).join("\n");
  }
  if (artifact.contentPath && fileExists(repoPath(artifact.contentPath))) {
    return readText(repoPath(artifact.contentPath));
  }
  return null;
}

/**
 * Whether an artifact reflects the deal's CLOSED state. True for inherently
 * final kinds, or when its grounding snapshot carries a non-open outcome. Only
 * final artifacts are REQUIRED to name the competitor; an early-stage note/email
 * legitimately predates knowing it, so a miss there is a warning, not an error.
 */
function isFinalArtifact(artifact: Artifact): boolean {
  if (FINAL_KINDS.has(artifact.kind)) return true;
  const outcome = artifact.grounding.outcome as string | undefined;
  return outcome !== undefined && outcome !== "open";
}

function mentions(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export interface LintOptions {
  /** Scope Layer-2 coherence checks to a single deal (Layer 1 stays whole-ledger). */
  oppId?: string;
  /** Run the cross-deal repetition detector (warn-only) over all generated content. */
  repetition?: boolean;
}

/**
 * Run the linter. `sampleSize` limits cross-system checks to a random (seeded)
 * sample of closed deals; pass 0 to check all closed deals.
 */
export function lint(world: World, cfg: Config, sampleSize = 0, opts: LintOptions = {}): LintResult {
  const ledger = new Ledger(world);
  const findings: LintFinding[] = [];
  const competitorNames = new Set(cfg.competitors.competitors.map((c) => c.name));

  // --- Layer 1: structural integrity ---------------------------------------
  const accountIds = new Set(world.accounts.map((a) => a.id));
  const repIds = new Set(world.reps.map((r) => r.id));
  const contactIds = new Set(world.contacts.map((c) => c.id));
  const oppIds = new Set(world.opportunities.map((o) => o.id));

  // Buying roles are an open string in the ledger schema; the vocabulary is
  // owned by config/personas.yaml, so enforce membership here.
  const personaRoles = new Set(cfg.personas.personas.map((p) => p.role));
  for (const c of world.contacts) {
    if (!accountIds.has(c.accountId)) {
      findings.push({
        severity: "error",
        message: `contact ${c.id} references missing account ${c.accountId}`,
      });
    }
    if (!personaRoles.has(c.buyingRole)) {
      findings.push({
        severity: "error",
        message: `contact ${c.id} has buyingRole "${c.buyingRole}" not defined in config/personas.yaml`,
      });
    }
  }
  for (const o of world.opportunities) {
    if (!accountIds.has(o.accountId))
      findings.push({ severity: "error", deal: o.id, message: `missing account ${o.accountId}` });
    if (!repIds.has(o.ownerRepId))
      findings.push({ severity: "error", deal: o.id, message: `missing owner rep ${o.ownerRepId}` });
    for (const cid of o.contactIds) {
      if (!contactIds.has(cid))
        findings.push({ severity: "error", deal: o.id, message: `missing contact ${cid}` });
    }
    for (const comp of o.competitors) {
      if (!competitorNames.has(comp)) {
        findings.push({
          severity: "error",
          deal: o.id,
          message: `competitor "${comp}" not in competitors.yaml`,
        });
      }
    }
    // Lost deals must record a loss reason; wins carry no reason column
    // (the CRM contract has no win_reason; win rationale lives in win-loss surveys).
    if (o.status === "lost" && !o.winLossReason) {
      findings.push({ severity: "error", deal: o.id, message: `lost deal has no loss reason` });
    }
  }
  for (const a of world.artifacts) {
    if (a.dealId && !oppIds.has(a.dealId)) {
      findings.push({
        severity: "error",
        artifact: a.id,
        message: `artifact references missing deal ${a.dealId}`,
      });
    }
  }

  // --- Layer 2: cross-system coherence on closed deals ----------------------
  // Only cohort members are ever generated or published, so deals outside the
  // cohort have no prose by design and must not be reported as incoherent.
  // Otherwise the linter drowns in errors for deals nobody intends to fill.
  const cohort = new CohortIndex();
  let closed = ledger.closedDeals().filter((d) => cohort.has(d.id));
  if (opts.oppId) {
    closed = closed.filter((d) => d.id === opts.oppId);
  } else if (sampleSize > 0 && closed.length > sampleSize) {
    closed = new Rng(`${world.seed}|lint`).shuffle(closed).slice(0, sampleSize);
  }

  // Win-loss/slack artifacts only exist when their generation is switched on
  // (Batch 1 is CRM-only), so don't require artifacts the run never produced.
  const expectWinlossArtifacts = cfg.world.generate.winloss;
  for (const deal of closed) {
    // A `none`-mode deal carries its win/loss signal in a #win-loss Slack post.
    // Seed cohort members never post to Slack, so for them that artifact is not
    // merely missing. It was never plantable. Requiring it would be demanding
    // prose the engine is configured not to produce.
    checkDealCoherence(cfg, world, deal, findings, expectWinlossArtifacts && cohort.allowsSlack(deal.id));
  }

  checkEmDashes(world, findings);
  if (opts.repetition) checkRepetition(world, cfg, findings);

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  return { findings, checkedDeals: closed.length, errors, warnings };
}

// --- Em dashes in generated prose (warn-only) --------------------------------
//
// Nobody types an em dash into a CRM note. A corpus full of them is the loudest
// tell that the prose came out of a model, which is the one thing this engine
// exists to avoid. Warn rather than error: the artifact is otherwise coherent,
// and the fix is a refill, not a hand-edit.

const EM_DASH = /—/g; // prose-lint: allow-emdash (the needle itself)

function checkEmDashes(world: World, findings: LintFinding[]): void {
  for (const artifact of world.artifacts) {
    if (artifact.status === "planned") continue;
    const text = artifactText(artifact);
    if (!text) continue;
    const count = text.match(EM_DASH)?.length ?? 0;
    if (count === 0) continue;
    findings.push({
      severity: "warn",
      deal: artifact.dealId ?? undefined,
      artifact: artifact.id,
      message: `${count} em dash(es) in the prose. Rewrite those sentences: apply -- --refill=${artifact.id}`,
    });
  }
}

// --- Cross-deal repetition detector (warn-only) ------------------------------
//
// The generated prose is written deal-by-deal by an LLM, and LLMs converge on
// pet phrases ("the last mile", "stale battlecards"). Deterministic variety
// axes in the prompts reduce this, but the detector is the FEEDBACK LOOP: it
// surfaces distinctive word sequences that recur across many different deals so
// the operator can promote them into config/prose.yaml banned_phrases.
//
// Method: 6-word shingles over every deal-linked artifact's text, minus an
// exclusion set shingled from text that legitimately repeats (survey questions,
// product/competitor positioning copied from config into every prompt).

const SHINGLE_SIZE = 6;
const REPETITION_MIN_DEALS = 4;
const REPETITION_TOP = 10;

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function shinglesOf(text: string): string[] {
  const words = normalizeWords(text);
  const out: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    out.push(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return out;
}

/** Shingles from config text that legitimately recurs in every deal's artifacts. */
function exclusionShingles(cfg: Config): Set<string> {
  const sources: string[] = [];
  for (const survey of [cfg.surveys.win, cfg.surveys.loss]) {
    for (const g of survey.groups) {
      sources.push(g.title);
      for (const q of g.questions) {
        sources.push(q.prompt);
        for (const o of q.options ?? []) sources.push(o);
        for (const c of q.columns ?? []) sources.push(c);
      }
    }
  }
  const p = cfg.product;
  sources.push(p.positioning.one_liner, p.positioning.category, p.positioning.universe);
  for (const d of p.domains) {
    sources.push(d.summary);
    for (const a of d.agents) sources.push(a.name, a.value_prop, a.solves);
  }
  for (const m of p.pain_to_module) sources.push(m.pain, m.lead_with);
  for (const g of p.brand_guardrails) sources.push(g);
  for (const c of cfg.competitors.competitors) {
    sources.push(c.positioning);
    for (const r of c.typical_loss_reasons ?? []) sources.push(r);
  }
  const set = new Set<string>();
  const company = cfg.world.company.name;
  for (const s of sources) {
    for (const sh of shinglesOf(s.replace(/\{company\}/g, company))) set.add(sh);
  }
  return set;
}

/** True when two normalized shingles are overlapping windows of the same phrase. */
function overlaps(a: string, b: string): boolean {
  const wa = a.split(" ");
  const wb = b.split(" ");
  const window = SHINGLE_SIZE - 1;
  const joinA = wa.join(" ");
  const joinB = wb.join(" ");
  return (
    joinA.includes(wb.slice(0, window).join(" ")) ||
    joinA.includes(wb.slice(-window).join(" ")) ||
    joinB.includes(wa.slice(0, window).join(" ")) ||
    joinB.includes(wa.slice(-window).join(" "))
  );
}

/**
 * Drop structural lines (markdown headings, Date/Attendees/Stage headers) so the
 * detector flags repeated PROSE, not the transcript-header template every
 * artifact legitimately shares.
 */
function proseOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(#|\*\*|Date:|Attendees:|Stage:|Subject:)/i.test(line.trim()))
    .join("\n");
}

function checkRepetition(world: World, cfg: Config, findings: LintFinding[]): void {
  const excluded = exclusionShingles(cfg);
  const dealsByShingle = new Map<string, Set<string>>();
  for (const artifact of world.artifacts) {
    if (!artifact.dealId || artifact.status === "planned") continue;
    const text = artifactText(artifact);
    if (!text) continue;
    for (const sh of new Set(shinglesOf(proseOnly(text)))) {
      if (excluded.has(sh)) continue;
      let deals = dealsByShingle.get(sh);
      if (!deals) dealsByShingle.set(sh, (deals = new Set()));
      deals.add(artifact.dealId);
    }
  }
  const candidates = [...dealsByShingle.entries()]
    .filter(([, deals]) => deals.size >= REPETITION_MIN_DEALS)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const reported: string[] = [];
  for (const [shingle, deals] of candidates) {
    if (reported.length >= REPETITION_TOP) break;
    if (reported.some((r) => overlaps(r, shingle))) continue;
    reported.push(shingle);
    findings.push({
      severity: "warn",
      message: `repeated phrase across ${deals.size} deals: "${shingle}". Consider adding it to banned_phrases (config/prose.yaml)`,
    });
  }
}

/**
 * Does this artifact's prose actually orbit the deal's use case?
 *
 * Warn-level, and matched on the use case's KEYWORDS rather than its label,
 * because prose should say "our battle cards are three months stale", never
 * "our Competitive Intelligence use case". A miss usually means the generator
 * drifted back to a generic product pitch, which is precisely what makes every
 * deal read the same.
 */
function checkUseCaseLead(
  cfg: Config,
  deal: Opportunity,
  artifact: Artifact,
  text: string,
  findings: LintFinding[],
): void {
  if (!deal.useCase) return;
  const uc = cfg.useCases.use_cases.find((u) => u.name === deal.useCase);
  if (!uc || uc.keywords.length === 0) return;
  const lower = text.toLowerCase();
  const hit = uc.keywords.some((kw) => lower.includes(kw.toLowerCase())) || mentions(text, uc.name);
  if (!hit) {
    findings.push({
      severity: "warn",
      deal: deal.id,
      artifact: artifact.id,
      message: `does not lead with the deal's use case "${deal.useCase}"`,
    });
  }
}

function checkDealCoherence(
  cfg: Config,
  world: World,
  deal: Opportunity,
  findings: LintFinding[],
  expectWinlossArtifacts: boolean,
): void {
  const artifacts = world.artifacts.filter((a) => a.dealId === deal.id && CONTENT_KINDS.includes(a.kind));
  for (const artifact of artifacts) {
    if (artifact.status === "planned") {
      findings.push({
        severity: "warn",
        deal: deal.id,
        artifact: artifact.id,
        message: `${artifact.kind} not yet generated (no content to check)`,
      });
      continue;
    }
    const text = artifactText(artifact);
    if (text === null) {
      findings.push({
        severity: "warn",
        deal: deal.id,
        artifact: artifact.id,
        message: `no readable content`,
      });
      continue;
    }
    checkUseCaseLead(cfg, deal, artifact, text, findings);

    // Every competitor on the deal must be named in a CLOSED-state artifact; an
    // early-stage note/email may predate knowing it, so that is a warning.
    const final = isFinalArtifact(artifact);
    for (const comp of deal.competitors) {
      if (!mentions(text, comp)) {
        findings.push({
          severity: final ? "error" : "warn",
          deal: deal.id,
          artifact: artifact.id,
          message: `does not mention competitor "${comp}" recorded on the deal`,
        });
      }
    }
    // The recorded win/loss reason must appear (win-loss artifacts especially).
    const reasonRequired =
      artifact.kind === "survey" || artifact.kind === "interview" || artifact.kind === "winloss_post";
    if (reasonRequired && deal.winLossReason && !mentions(text, deal.winLossReason)) {
      findings.push({
        severity: "error",
        deal: deal.id,
        artifact: artifact.id,
        message: `does not reference recorded ${deal.status} reason "${deal.winLossReason}"`,
      });
    }
  }

  // none-mode closed deals MUST have a winloss_post carrying the signal, but
  // only once win-loss generation is switched on.
  if (expectWinlossArtifacts && deal.winLossMode === "none") {
    const post = artifacts.find((a) => a.kind === "winloss_post");
    if (!post) {
      findings.push({
        severity: "error",
        deal: deal.id,
        message: `none-mode closed deal has no #win-loss post-mortem (the sole win/loss signal)`,
      });
    }
  }
}

export function formatFindings(result: LintResult): string {
  if (result.findings.length === 0)
    return `✓ lint clean. ${result.checkedDeals} closed deals checked, no issues`;
  const lines = result.findings.map((f) => {
    const icon = f.severity === "error" ? "✗" : f.severity === "warn" ? "⚠" : "·";
    const loc = [f.deal && `deal=${f.deal}`, f.artifact && `art=${f.artifact}`].filter(Boolean).join(" ");
    return `  ${icon} [${f.severity}] ${loc ? loc + ": " : ""}${f.message}`;
  });
  return [
    `lint: ${result.errors} error(s), ${result.warnings} warning(s) over ${result.checkedDeals} closed deals`,
    ...lines,
  ].join("\n");
}
