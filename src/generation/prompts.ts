/**
 * Grounded prompt builders. See DESIGN.md §7.1–7.2.
 *
 * The deterministic generator owns structure + referential integrity; the LLM
 * owns ONLY the prose, and every prompt is grounded in the EXACT ledger facts
 * for that entity. These builders turn a planned artifact + its ledger context
 * into a GenerationRequest the agent fills. The same facts are recorded in
 * `artifact.grounding` and re-checked by the coherence linter afterwards.
 */

import type { Config, SurveyQuestion, WinLossSurvey } from "../config/schema.js";
import { Ledger } from "../ledger/ledger.js";
import type { Artifact, Opportunity } from "../ledger/schema.js";
import type { GenerationRequest } from "./requests.js";
import { varietyBlock, artifactShape, castSubset, bannedPhrasesRule } from "./variety.js";
import { useCaseBrief } from "../use-cases.js";

interface Ctx {
  config: Config;
  ledger: Ledger;
  /** world.seed — drives the deterministic variety axes (variety.ts). */
  seed: string;
}

const DETAIL_GUIDANCE: Record<"low" | "medium" | "high", string> = {
  low: "Keep it terse — a few short sentences or structured one-liners. No filler.",
  medium: "Moderate length — a realistic but focused artifact; a few short paragraphs.",
  high: "Rich and long-form — conversational, with follow-ups, tangents, and verbatim color.",
};

/**
 * Render the grounded fact block. Static structure (account, contacts,
 * competitors) comes from the live ledger, but the VOLATILE fields (stage,
 * outcome, win/loss reason) come from the artifact's grounding SNAPSHOT — so an
 * early-stage transcript reflects the world as it was at the call date and does
 * not leak the eventual outcome, while a win-loss artifact shows the close.
 */
function dealFactBlock(ctx: Ctx, deal: Opportunity, grounding: Record<string, unknown>): string {
  const acct = ctx.ledger.account(deal.accountId);
  const rep = ctx.ledger.rep(deal.ownerRepId);
  const contacts = deal.contactIds.map((id) => ctx.ledger.contact(id));
  const competitorLines = deal.competitors.map((name) => {
    const c = ctx.config.competitors.competitors.find((x) => x.name === name);
    return c ? `  - ${c.name} (${c.category}): ${c.positioning.trim()}` : `  - ${name}`;
  });
  const stage = (grounding.stage as string) ?? deal.stage;
  const outcome = (grounding.outcome as string) ?? deal.status;
  const reason = grounding.winLossReason as string | undefined;
  return [
    `Deal: "${deal.name}" (${stage}, ${outcome}, $${deal.amount.toLocaleString()})`,
    `Account: ${acct.name} — ${acct.industry}, ${acct.size}, ${acct.region} (${acct.employeeBand} emp, ${acct.fundingStage})`,
    `${companyShort(ctx)} rep (owner): ${rep.name}`,
    contacts.length
      ? `Buying group:\n${contacts.map((c) => `  - ${c.name}, ${c.title} (${c.buyingRole})`).join("\n")}`
      : "Buying group: (none recorded)",
    deal.competitors.length
      ? `Competitors on this deal:\n${competitorLines.join("\n")}`
      : "Competitors: none on this deal",
    useCaseBrief(ctx.config, { useCase: (grounding.useCase as string) ?? deal.useCase }) ?? "",
    reason ? `Recorded ${outcome} reason: ${reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The vendor's formal and colloquial names, from config. */
function companyName(ctx: Ctx): string {
  return ctx.config.world.company.name;
}
function companyShort(ctx: Ctx): string {
  return ctx.config.world.company.short_name ?? ctx.config.world.company.name;
}

function commonRules(ctx: Ctx): string {
  return [
    "GROUNDING RULES (strict):",
    "- Use ONLY the names, companies, competitors, and the loss/win reason given below. Do not invent competitors or contacts.",
    `- This is clearly-fabricated demo data for an internal demo of ${companyName(ctx)}. Keep it realistic but never reference real people.`,
    "- Stay consistent with the recorded facts: the same competitor(s) and the same win/loss reason must appear across this deal's transcript, win-loss artifact, and Slack thread.",
    bannedPhrasesRule(ctx.config.prose),
    "- Do NOT template this artifact on other deals' stories. The VARIETY block (where present) is THIS deal's specific texture — write from it.",
    // The use case is what makes one deal's prose distinguishable from another's.
    // Without this rule every transcript drifts back to a generic product pitch.
    `- The deal's PRIMARY USE CASE is the dominant theme: it is what the buyer came for, what discovery digs into, what gets demoed, and what the objections are about. Other ${companyShort(ctx)} capabilities may come up in passing — buyers rarely want exactly one thing — but they must stay secondary, and on some deals the primary use case is genuinely the only thing discussed. Never open on a capability the buyer did not ask about.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The per-deal variety block + this artifact's structural shape, ready to insert. */
function varietySection(ctx: Ctx, artifact: Artifact): string {
  if (!artifact.dealId) return "";
  const shape = artifactShape(ctx.seed, artifact, ctx.config.prose);
  return [varietyBlock(ctx.seed, artifact.dealId, ctx.config.prose), shape].filter(Boolean).join("\n");
}

export function buildRequest(ctx: Ctx, artifact: Artifact): GenerationRequest {
  const base = {
    artifactId: artifact.id,
    kind: artifact.kind,
    detailLevel: artifact.detailLevel,
    title: artifact.title,
    date: artifact.date,
    grounding: artifact.grounding,
  };

  switch (artifact.kind) {
    case "call_transcript":
      return { ...base, output: "markdown", prompt: callTranscriptPrompt(ctx, artifact) };
    case "survey":
      return { ...base, output: "markdown", prompt: surveyPrompt(ctx, artifact) };
    case "interview":
      return { ...base, output: "markdown", prompt: interviewPrompt(ctx, artifact) };
    case "internal_collateral":
      return { ...base, output: "markdown", prompt: collateralPrompt(ctx, artifact) };
    case "slack_deal_thread":
      return { ...base, output: "slack_messages", prompt: slackDealThreadPrompt(ctx, artifact) };
    case "winloss_post":
      return { ...base, output: "slack_messages", prompt: winlossPostPrompt(ctx, artifact) };
    case "competitive_q":
      return { ...base, output: "slack_messages", prompt: competitiveQPrompt(ctx, artifact) };
    case "ae_note":
      return { ...base, output: "markdown", prompt: aeNotePrompt(ctx, artifact) };
    case "email_exchange":
      return { ...base, output: "email_thread", prompt: emailExchangePrompt(ctx, artifact) };
  }
}

function withDeal(ctx: Ctx, artifact: Artifact): { deal: Opportunity; facts: string } {
  if (!artifact.dealId) throw new Error(`Artifact ${artifact.id} (${artifact.kind}) requires a deal`);
  const deal = ctx.ledger.opportunity(artifact.dealId);
  return { deal, facts: dealFactBlock(ctx, deal, artifact.grounding) };
}

/**
 * Who is actually in the room for a call at this stage — a SUBSET of the deal's
 * full buying group. The deal's contacts accumulate over its life, but an early
 * call is small (a first discovery call is 1–2 people, never IT). Always keeps
 * the primary contact (covers PMM-absent market-intel deals where the driver
 * isn't a Champion); a missing/empty stage entry → primary contact only.
 */
function callAttendees(ctx: Ctx, deal: Opportunity, stage: string) {
  const rep = ctx.ledger.rep(deal.ownerRepId);
  const allowed = new Set(ctx.config.personas.attendees_by_stage[stage] ?? []);
  const contacts = deal.contactIds
    .map((id) => ctx.ledger.contact(id))
    .filter((c) => c.id === deal.primaryContactId || allowed.has(c.buyingRole));
  return { rep, contacts };
}

/** The sales motion + rough length for a call at each pipeline stage. */
function stageTranscriptFocus(ctx: Ctx, stage: string): string {
  const focus = ctx.config.prose.stage_focus;
  return (
    focus[stage] ??
    focus["default"] ??
    "A realistic sales call: the rep discovers needs, demos where relevant, and addresses the competitor(s) and any pricing/product reaction."
  );
}

/** Compact product grounding so the rep can position + demo on the call. */
function productBlock(ctx: Ctx): string {
  const p = ctx.config.product;
  const domains = p.domains
    .map((d) => {
      const agents = d.agents
        .map((a) => `    • ${a.name}: ${a.value_prop.trim()} (solves: ${a.solves.trim()})`)
        .join("\n");
      return `  ${d.name} — ${d.summary.trim()}\n${agents}`;
    })
    .join("\n");
  const pains = p.pain_to_module
    .map(
      (m) =>
        `  - ${m.persona}: pain — ${m.pain.trim()} → lead with ${m.lead_with.trim()} (driver: ${m.decision_driver})`,
    )
    .join("\n");
  const guards = p.brand_guardrails.map((g) => `  - ${g.trim()}`).join("\n");
  return [
    `${companyShort(ctx).toUpperCase()} PRODUCT (for the rep to position and demo — pick what maps to the buyer's pain; don't fire-hose the whole catalog):`,
    p.positioning.one_liner.trim(),
    `Category: ${p.positioning.category.trim()}`,
    `The Universe: ${p.positioning.universe.trim()}`,
    `Domains & agents:`,
    domains,
    p.pain_to_module.length ? `Map the buyer's pain to the right module:\n${pains}` : "",
    p.brand_guardrails.length ? `How the rep must position ${companyShort(ctx)}:\n${guards}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function callTranscriptPrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  const stage = (artifact.grounding.stage as string) ?? deal.stage;
  const { rep, contacts } = callAttendees(ctx, deal, stage);
  const roster = [
    `  - ${rep.name} — ${companyShort(ctx)} rep (deal owner)`,
    ...contacts.map((c) => `  - ${c.name}, ${c.title} (${c.buyingRole})`),
  ].join("\n");
  return [
    `Write a realistic ${stage} sales call transcript, dated ${artifact.date}.`,
    DETAIL_GUIDANCE[artifact.detailLevel],
    `Produce a FULL multi-turn conversation (many back-and-forth exchanges), not a summary or a handful of lines.`,
    "",
    `Sales motion for this call: ${stageTranscriptFocus(ctx, stage)}`,
    "",
    `Attendees on THIS call (use ONLY these people — a subset of the full buying group; earlier-stage calls have`,
    `fewer stakeholders, and IT/Security only joins the late security review):`,
    roster,
    "",
    facts,
    "",
    varietySection(ctx, artifact),
    "",
    productBlock(ctx),
    "",
    `Format as markdown: a short header (date, attendees, stage), then a speaker-labeled transcript.`,
    `The conversation should naturally surface the competitor(s) on the deal (raised by the buyer) and the themes`,
    `that lead to the recorded outcome.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

/** Substitute the `{company}` placeholder used throughout surveys.yaml. */
function subCompany(s: string, company: string): string {
  return s.replace(/\{company\}/g, company);
}

/**
 * Pick the win or loss questionnaire by the deal's recorded outcome. Win-loss
 * artifacts are only planted on closed deals, so a non-"won" outcome is a loss.
 */
function winLossSurvey(ctx: Ctx, deal: Opportunity, artifact: Artifact): WinLossSurvey {
  const outcome = (artifact.grounding.outcome as string) ?? deal.status;
  return outcome === "won" ? ctx.config.surveys.win : ctx.config.surveys.loss;
}

/** Resolve a select question's options into a readable "a / b / c" string, or null. */
function questionOptions(q: SurveyQuestion, company: string, modules: string[]): string | null {
  if (q.options?.length) return q.options.map((o) => subCompany(o, company)).join(" / ");
  if (q.options_from_config === "product_modules") return modules.length ? modules.join(" / ") : null;
  return null;
}

/** Render one question as a "- (type) prompt — how to answer" line. */
function renderQuestion(q: SurveyQuestion, company: string, modules: string[]): string {
  const prompt = subCompany(q.prompt, company);
  const opt = q.required === false ? " (optional)" : "";
  let how: string;
  switch (q.type) {
    case "open_text":
      how = "free text";
      break;
    case "yes_no":
      how = "yes / no";
      break;
    case "rating_scale": {
      const min = q.scale?.min ?? 1;
      const max = q.scale?.max ?? 5;
      how = `rate ${min}–${max}${q.allow_comment ? ", with a short comment" : ""}`;
      break;
    }
    case "vendor_select":
      how = "name the vendors evaluated — use the competitor(s) on this deal";
      break;
    case "single_select":
      if (q.options_from) {
        how = "choose the single vendor named above that the buyer ultimately chose";
      } else {
        const opts = questionOptions(q, company, modules);
        how = opts ? `choose one: ${opts}` : "choose one";
      }
      break;
    case "multi_select": {
      const opts = questionOptions(q, company, modules);
      how = `choose any that apply${opts ? `: ${opts}` : ""}${q.allow_other ? " (or add your own)" : ""}`;
      break;
    }
    case "comparison_table": {
      const cols = (q.columns ?? []).map((c) => subCompany(c, company)).join(" | ");
      how = `a small table, one row per evaluated vendor (the competitor(s) on this deal); columns: ${cols}`;
      break;
    }
  }
  return `- (${q.type}) ${prompt}${opt} — ${how}`;
}

/** Render a questionnaire as grouped, answerable question lines. */
function renderSurvey(survey: WinLossSurvey, company: string, modules: string[]): string {
  return survey.groups
    .map((g) => [`## ${g.title}`, ...g.questions.map((q) => renderQuestion(q, company, modules))].join("\n"))
    .join("\n\n");
}

function surveyPrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  const company = ctx.config.world.company.name;
  const modules = ctx.config.world.company.product_modules;
  const survey = winLossSurvey(ctx, deal, artifact);
  return [
    `Write a completed win-loss SURVEY (respondent TYPED their answers), dated ${artifact.date}.`,
    DETAIL_GUIDANCE[artifact.detailLevel],
    "Structured answers + short free-text, as a busy buyer would type.",
    "",
    facts,
    "",
    varietySection(ctx, artifact),
    `The free-text answers must reflect this deal's VARIETY backstory and objections — not a generic evaluation story.`,
    "",
    `Questionnaire: ${survey.meta.title}`,
    renderSurvey(survey, company, modules),
    "",
    `Format as markdown: each group heading, then each question followed by the respondent's answer (in the`,
    `answer FORMAT noted after each question). The free-text answers MUST reference the same competitor(s)`,
    `and the recorded win/loss reason above.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

function interviewPrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  const company = ctx.config.world.company.name;
  const survey = winLossSurvey(ctx, deal, artifact);
  const style = ctx.config.surveys.interview_style;
  const topics = survey.groups
    .flatMap((g) => g.questions)
    .map((x) => `- ${subCompany(x.prompt, company)}`)
    .join("\n");
  return [
    `Write a win-loss AI PHONE INTERVIEW transcript (respondent SPOKE), dated ${artifact.date}.`,
    DETAIL_GUIDANCE.high,
    style
      ? `Conversational: ${style.follow_ups ? "follow-ups, " : ""}${style.tangents ? "tangents, " : ""}${style.verbatim_color ? "verbatim color" : ""}. ~${style.approx_duration_min?.[0]}–${style.approx_duration_min?.[1]} min.`
      : "",
    "",
    facts,
    "",
    varietySection(ctx, artifact),
    "",
    `This is the "${survey.meta.title}" conversation. Cover these topics (the interviewer probes naturally, not as a rigid list):`,
    topics,
    "",
    `Format as markdown: a speaker-labeled transcript (Interviewer / Respondent). It MUST reference the`,
    `same competitor(s) and the recorded win/loss reason above, with realistic spoken detail.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

function collateralPrompt(ctx: Ctx, artifact: Artifact): string {
  const docType = (artifact.grounding.docType as string) ?? "Positioning one-pager";
  return [
    `Write a pre-existing internal ${companyName(ctx)} PMM document: "${docType}", dated ${artifact.date}.`,
    DETAIL_GUIDANCE[artifact.detailLevel],
    `This is collateral a real customer would already have on file (DESIGN §16) — not tied to a specific deal.`,
    `Company: ${ctx.config.world.company.name} (${ctx.config.world.company.domain}).`,
    `Where relevant, reference the real competitor set: ${ctx.config.competitors.competitors.map((c) => c.name).join(", ")}.`,
    "",
    `Format as a polished markdown document appropriate to a "${docType}".`,
    "",
    commonRules(ctx),
  ].join("\n");
}

function aeNotePrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  const rep = ctx.ledger.rep(deal.ownerRepId);
  const stage = (artifact.grounding.stage as string) ?? deal.stage;
  const outcome = (artifact.grounding.outcome as string) ?? deal.status;
  const isClose = outcome !== "open";
  const shape = artifactShape(ctx.seed, artifact, ctx.config.prose);
  return [
    `Write a short internal CRM note that the deal owner (${rep.name}) logged on this ${stage} opportunity, dated ${artifact.date}.`,
    DETAIL_GUIDANCE[artifact.detailLevel],
    "",
    facts,
    "",
    isClose
      ? `This deal has CLOSED ${outcome}. Jot the rep's quick wrap-up: what THEY believe drove the ${outcome} and the competitor(s) involved. The rep's read may be their own interpretation, and can be thin.`
      : [
          `Write the rep's working note the way a REAL busy AE actually logs it — mostly logistics`,
          `("Demo done, sending pricing.", "Champion OOO, following up next wk.", "Pushed to next month, budget not approved yet.").`,
          `A real field note is sparse and frequently captures NO real insight — often just what happened and the next step.`,
          `Do NOT dutifully fill in competitor, pricing, sentiment, and blockers. Usually omit most of that; mention a`,
          `competitor or a pricing/product reaction only if it would naturally land in a one-line jot, and often not at all.`,
        ].join("\n"),
    `This note's shape (write it exactly this way, not as a fixed bullet template): ${shape}.`,
    `First person, no headers. Do NOT state derived conclusions (no ICP score/tier, no "we always lose when X") — only the raw observations.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

/** What raw signal an email thread should surface at each stage. */
function stageEmailFocus(stage: string): string {
  switch (stage) {
    case "Discovery":
      return "the intro and scheduling a demo, the buyer's current tooling and what they are trying to solve, and which other stakeholders to loop in.";
    case "Evaluation":
      return "technical and integration requirements (the tech stack named on the deal), and which additional buying-group members are now involved (multi-threading).";
    case "Proposal":
      return "the buyer's reaction to pricing and packaging in their own words, and how it compares to alternatives.";
    case "Negotiation":
      return "the competitor(s) in play, the buyer's decision criteria, and remaining objections.";
    default:
      return "the buyer's needs, the competitor(s) in play, and any pricing or product reaction.";
  }
}

function emailExchangePrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  const rep = ctx.ledger.rep(deal.ownerRepId);
  const stage = (artifact.grounding.stage as string) ?? deal.stage;
  const contacts = deal.contactIds.map((id) => ctx.ledger.contact(id));
  const roster = [
    `  - ${rep.name} <${rep.email}> — ${companyShort(ctx)} rep (deal owner)`,
    ...contacts.map((c) => `  - ${c.name} <${c.email}> — ${c.title} (${c.buyingRole})`),
  ].join("\n");
  return [
    `Write a realistic email thread (3–6 messages) between the ${companyShort(ctx)} rep and the buying group for this ${stage} deal, around ${artifact.date}.`,
    DETAIL_GUIDANCE[artifact.detailLevel],
    "",
    facts,
    "",
    `Participants (use these EXACT names + addresses):`,
    roster,
    "",
    varietySection(ctx, artifact),
    "",
    `Surface this stage's raw signal naturally in the exchange: ${stageEmailFocus(stage)}`,
    `Messages alternate between the rep and one or more buyer contacts; keep subjects threaded ("Re: …").`,
    "",
    `Return STRICT JSON only:`,
    `{"emails":[{"from":"Name <email>","to":["email"],"subject":"...","body":"...","date":"YYYY-MM-DD","contactRef":"buyer-email"}]}`,
    `Set "contactRef" to the BUYER contact's email this message is with (even when the rep is the sender).`,
    `Name any competitor(s) on the deal where it fits, and quote pricing/product reactions verbatim. Never state a derived conclusion.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

function personaLine(display: string, handle: string, role: string, voice?: string): string {
  return `  - ${display} (@${handle}, ${role})${voice ? ` — voice: ${voice}` : ""}`;
}

/** The standing internal personas as a "- Display (@handle, role) — voice: …" roster. */
function internalRoster(ctx: Ctx): string[] {
  return ctx.config.slackPersonas.internal_personas.map((p) =>
    personaLine(p.display, p.handle, p.role, p.voice),
  );
}

/**
 * The allowed cast for a deal thread: the deal owner plus a seeded 2–3-persona
 * SUBSET of the standing internal roster, rotated per artifact — so the same
 * three voices don't show up on every deal, and nobody plays a fixed reflex role.
 */
function personaRoster(ctx: Ctx, deal: Opportunity, artifact: Artifact): string {
  const rep = ctx.ledger.rep(deal.ownerRepId);
  const repHandle = rep.name.toLowerCase().replace(/[^a-z]+/g, ".");
  const repVoice = ctx.config.slackPersonas.rep_personas.find((p) => p.handle === repHandle)?.voice;
  const cast = castSubset(ctx.seed, artifact.id, ctx.config.slackPersonas.internal_personas, 2, 3);
  return [
    `Allowed Slack personas (post ONLY as these — this thread's cast, a rotating subset of the team):`,
    personaLine(rep.name, repHandle, "deal owner", repVoice),
    ...cast.map((p) => personaLine(p.display, p.handle, p.role, p.voice)),
    `Write each persona in their own voice (above). Not everyone must post; replies may disagree, ask a`,
    `blunt question, or just react — do NOT write an obligatory praise round.`,
  ].join("\n");
}

function slackDealThreadPrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  const n = (artifact.grounding.messageCount as number) ?? 3;
  return [
    `Write an internal Slack #deals thread (${n} messages) about this deal, dated ${artifact.date}.`,
    DETAIL_GUIDANCE[artifact.detailLevel],
    "",
    facts,
    "",
    varietySection(ctx, artifact),
    "",
    personaRoster(ctx, deal, artifact),
    "",
    `Return STRICT JSON only: {"messages":[{"personaHandle":"...","text":"..."}, ...]}`,
    `The thread MUST name the deal/account/rep and the competitor(s); keep it casual and internal.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

function winlossPostPrompt(ctx: Ctx, artifact: Artifact): string {
  const { deal, facts } = withDeal(ctx, artifact);
  return [
    `Write a Slack #win-loss post-mortem for this CLOSED deal, dated ${artifact.date}.`,
    `IMPORTANT: this deal has win-loss mode = "none", so this post is the SOLE win/loss signal —`,
    `there is no survey or interview. It must fully carry the win/loss story.`,
    DETAIL_GUIDANCE.medium,
    "",
    facts,
    "",
    varietySection(ctx, artifact),
    "",
    personaRoster(ctx, deal, artifact),
    "",
    `Return STRICT JSON only: {"messages":[{"personaHandle":"...","text":"..."}, ...]}`,
    `The post MUST state the outcome, the recorded win/loss reason, and the competitor(s) involved.`,
    "",
    commonRules(ctx),
  ].join("\n");
}

function competitiveQPrompt(ctx: Ctx, artifact: Artifact): string {
  const competitor = (artifact.grounding.competitor as string) ?? ctx.config.competitors.competitors[0]!.name;
  return [
    `Write a #competitive channel question about the competitor "${competitor}", dated ${artifact.date}.`,
    `This is the HUMAN side only — an internal teammate asking a real competitive question that ${companyShort(ctx)}'s`,
    `own bot (installed separately, out of scope) will later answer. Do NOT write the answer (DESIGN §9 boundary).`,
    DETAIL_GUIDANCE.low,
    "",
    `Ask as ONE of these internal personas — set personaHandle to their exact @handle, and pick a role`,
    `whose vantage fits the question (e.g. a Sales Engineer hitting a POC objection, a CSM hearing churn risk):`,
    ...internalRoster(ctx),
    "",
    `Return STRICT JSON only: {"messages":[{"personaHandle":"...","text":"..."}]}  (usually 1 message)`,
    "",
    commonRules(ctx),
  ].join("\n");
}
