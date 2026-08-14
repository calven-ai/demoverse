/**
 * Touch-point planning. Decides which prose artifacts a deal earns, when, and
 * with which grounding snapshot. Split from advance.ts; shared by the live weekly engine
 * and the retroactive backfill planner.
 */

import { Rng } from "../util/rng.js";
import { addDays, daysBetween, type ISODate } from "../util/date.js";
import type { Config } from "../config/schema.js";
import { Ledger, nextId } from "../ledger/ledger.js";
import type { Artifact, Opportunity, World } from "../ledger/schema.js";
import { openStages, stageRank } from "../pipeline/stages.js";

export function dealFacts(ledger: Ledger, opp: Opportunity): Record<string, unknown> {
  const acct = ledger.account(opp.accountId);
  const rep = ledger.rep(opp.ownerRepId);
  return {
    accountName: acct.name,
    repName: rep.name,
    competitors: opp.competitors,
    contactNames: opp.contactIds.map((id) => ledger.contact(id).name),
    winLossReason: opp.winLossReason,
    outcome: opp.status,
    stage: opp.stage,
    // Snapshotted like everything else here so an artifact keeps the use case
    // the deal had when it was planned, even if the deal is later renamed.
    useCase: opp.useCase,
  };
}

export function planArtifact(
  world: World,
  a: Omit<Artifact, "external" | "status" | "detailLevel" | "grounding"> & Partial<Artifact>,
): Artifact {
  const artifact: Artifact = {
    detailLevel: "medium",
    grounding: {},
    status: "planned",
    external: {},
    ...a,
  } as Artifact;
  world.artifacts.push(artifact);
  return artifact;
}

export function artifactDetail(cfg: Config, kind: Artifact["kind"]): "low" | "medium" | "high" {
  switch (kind) {
    case "call_transcript":
      return cfg.world.detail.call_transcripts;
    case "interview":
      return cfg.world.detail.phone_interviews;
    case "survey":
      return cfg.world.detail.surveys;
    case "slack_deal_thread":
    case "winloss_post":
    case "competitive_q":
      return cfg.world.detail.slack;
    case "ae_note":
      return cfg.world.detail.ae_notes;
    case "email_exchange":
      return cfg.world.detail.emails;
    case "internal_collateral":
      return "medium";
  }
}

export function normalizeModeMix(cfg: Config): Record<string, number> {
  const m = cfg.world.winloss.mode_mix;
  return { interview: m.interview, survey: m.survey, none: m.none };
}

/** Per-stage cadence: a fixed count or an [min,max] range chosen probabilistically. */
export function shouldEmitPerStage(
  spec: Record<string, number | [number, number]>,
  stage: string,
  rng: Rng,
): boolean {
  const s = spec[stage];
  if (s === undefined) return false;
  if (typeof s === "number") return s > 0;
  const [min, max] = s;
  if (max <= 0) return false;
  if (min >= 1) return true;
  return rng.chance(max / (max + 1));
}

/**
 * The win-loss artifact for a closing deal, one per `winLossMode`.
 *
 * `none` mode deliberately produces no survey or interview: its signal lives in
 * a #win-loss Slack post-mortem instead. When Slack is not a destination for
 * this deal (a `seed` cohort member, see src/cohort.ts) that post cannot exist,
 * so the deal simply closes with no win-loss artifact at all. That is the
 * intended outcome, not a gap: real teams only run win-loss on a subset of
 * deals, and the linter's none-mode rule is scoped to match.
 */
export function planCloseArtifacts(
  world: World,
  cfg: Config,
  ledger: Ledger,
  opp: Opportunity,
  date: ISODate,
  planned: (a: Parameters<typeof planArtifact>[1]) => void,
  rng: Rng,
  allowSlack: boolean,
): void {
  const facts = dealFacts(ledger, opp);
  const acct = ledger.account(opp.accountId);
  if (opp.winLossMode === "none" && !allowSlack) return;
  if (opp.winLossMode === "survey") {
    planned({
      id: nextId(world.artifacts, "art"),
      kind: "survey",
      dealId: opp.id,
      title: `${acct.name} — win-loss survey`, // prose-lint: allow-emdash (external record name)
      date,
      grounding: facts,
    });
  } else if (opp.winLossMode === "interview") {
    planned({
      id: nextId(world.artifacts, "art"),
      kind: "interview",
      dealId: opp.id,
      title: `${acct.name} — win-loss interview`, // prose-lint: allow-emdash (external record name)
      date,
      grounding: facts,
    });
  } else {
    planned({
      id: nextId(world.artifacts, "art"),
      kind: "winloss_post",
      dealId: opp.id,
      title: `#win-loss — ${acct.name} ${opp.status} post-mortem`, // prose-lint: allow-emdash (external record name)
      date,
      grounding: facts,
    });
  }
}

// --- Touch-point backfill (retroactive, for EXISTING deals) ------------------
//
// advanceWorld plants touch points incrementally as a deal progresses, so deals
// that were already advanced/closed with the touch-point switches off carry
// none. This planner reconstructs a deal's whole sales cycle from its RECORDED
// timeline (createdDate → closeDate, the stages it visited) and plants the full
// touch-point set: call transcripts, AE notes, email threads, the deal's Slack
// thread, an optional #competitive question, and the win-loss artifact on close.
//
// Unlike the live engine it does NOT consult cfg.world.generate.*. It is an
// explicit operator action ("backfill this deal"), gated only by the per-deal
// cadence config (an empty cadence ⇒ none of that kind). Idempotent at deal
// granularity: a deal that already has any artifact is skipped.

export type PlanFn = (a: Parameters<typeof planArtifact>[1]) => void;

export function planDealTouchpoints(
  world: World,
  cfg: Config,
  ledger: Ledger,
  opp: Opportunity,
  horizonDate: ISODate,
  planned: PlanFn,
  rng: Rng,
  allowSlack: boolean,
): void {
  const acctName = ledger.account(opp.accountId).name;
  const created = opp.createdDate;
  const end = opp.closeDate ?? horizonDate;
  const span = Math.max(0, daysBetween(created, end));
  // Which stages this deal ACTUALLY visited, and when.
  //
  // Prefer the recorded `stageHistory`: a deal that skipped Evaluation (short
  // cycles routinely do) must not be handed an Evaluation transcript here, or
  // the backfill would contradict the ledger the live engine wrote. Deals
  // predating `stageHistory` fall back to the old assumption, every stage in
  // order, interpolated evenly across [created, end].
  const stages = openStages(cfg);
  const openVisits = opp.stageHistory.filter((h) => stages.includes(h.stage));
  const visits: { stage: string; date: ISODate }[] =
    openVisits.length > 0
      ? openVisits.map((h) => ({ stage: h.stage, date: h.date }))
      : (() => {
          const reachedIdx = opp.status === "open" ? stageRank(stages, opp.stage) : stages.length - 1;
          const out: { stage: string; date: ISODate }[] = [];
          for (let i = 0; i <= reachedIdx && i < stages.length; i++) {
            out.push({
              stage: stages[i]!,
              date: addDays(created, Math.round((span * i) / stages.length)),
            });
          }
          return out;
        })();

  for (const [i, { stage, date }] of visits.entries()) {
    // Leak-safe grounding: an early-stage artifact must not reference the
    // eventual outcome, so override outcome/reason to the open state.
    const groundingOpen = { ...dealFacts(ledger, opp), stage, outcome: "open", winLossReason: undefined };

    if (shouldEmitPerStage(cfg.world.artifacts.transcripts_per_deal, stage, rng)) {
      planned({
        id: nextId(world.artifacts, "art"),
        kind: "call_transcript",
        dealId: opp.id,
        title: `${acctName} — ${stage} call`, // prose-lint: allow-emdash (external record name)
        date,
        grounding: groundingOpen,
      });
    }
    if (shouldEmitPerStage(cfg.world.artifacts.ae_notes_per_deal, stage, rng)) {
      planned({
        id: nextId(world.artifacts, "art"),
        kind: "ae_note",
        dealId: opp.id,
        title: `${acctName} — AE note (${stage})`, // prose-lint: allow-emdash (external record name)
        date,
        grounding: groundingOpen,
      });
    }
    if (shouldEmitPerStage(cfg.world.artifacts.emails_per_deal, stage, rng)) {
      planned({
        id: nextId(world.artifacts, "art"),
        kind: "email_exchange",
        dealId: opp.id,
        title: `${acctName} — email thread (${stage})`, // prose-lint: allow-emdash (external record name)
        date,
        grounding: groundingOpen,
      });
    }
    if (i === 0 && allowSlack) {
      planned({
        id: nextId(world.artifacts, "art"),
        kind: "slack_deal_thread",
        dealId: opp.id,
        title: `#deals — ${acctName} kickoff`, // prose-lint: allow-emdash (external record name)
        date,
        grounding: { ...groundingOpen, messageCount: rng.int(...cfg.world.slack.posts_per_deal.deal_thread) },
      });
    }
  }

  // An opportunity-scoped #competitive question on a subset of deals. The AE
  // flags a competitor they ran into on this deal.
  if (
    allowSlack &&
    visits.length > 0 &&
    opp.competitors.length > 0 &&
    rng.chance(cfg.world.artifacts.competitive_q_rate)
  ) {
    planned({
      id: nextId(world.artifacts, "art"),
      kind: "competitive_q",
      dealId: opp.id,
      title: `#competitive — ${opp.competitors[0]} on ${acctName}`, // prose-lint: allow-emdash (external record name)
      // Early in the cycle: the second stage the deal reached, or the first if
      // it never got that far.
      date: visits[Math.min(1, visits.length - 1)]!.date,
      grounding: { competitor: opp.competitors[0] },
    });
  }

  // Close artifacts (win-loss survey/interview/post + the rep's close note + a
  // closing #deals update) carry the recorded outcome and reason.
  if (opp.status !== "open") {
    const closeDate = opp.closeDate ?? end;
    planCloseArtifacts(world, cfg, ledger, opp, closeDate, planned, rng, allowSlack);
    // The close note is the one note a rep almost always writes, but "almost".
    // ae_close_note_rate keeps the CRM from being uniformly well-logged, which
    // is what makes win-loss interviews necessary downstream.
    if (rng.chance(cfg.world.artifacts.ae_close_note_rate)) {
      planned({
        id: nextId(world.artifacts, "art"),
        kind: "ae_note",
        dealId: opp.id,
        title: `${acctName} — AE close note`, // prose-lint: allow-emdash (external record name)
        date: closeDate,
        grounding: dealFacts(ledger, opp),
      });
    }
    if (allowSlack) {
      planned({
        id: nextId(world.artifacts, "art"),
        kind: "slack_deal_thread",
        dealId: opp.id,
        title: `#deals — ${acctName} closed ${opp.status}`, // prose-lint: allow-emdash (external record name)
        date: closeDate,
        grounding: {
          ...dealFacts(ledger, opp),
          messageCount: rng.int(...cfg.world.slack.posts_per_deal.deal_thread),
        },
      });
    }
  }
}
