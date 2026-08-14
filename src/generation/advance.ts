/**
 * Deterministic world-advance, the core simulation. See docs/architecture.md#clock-periods-and-advance.
 *
 * For each pending period this computes the next desired world state: new
 * accounts/contacts/opportunities sampled from the Tier-1 distributions, open
 * deals progressed through stages and closed won/lost under the trend-evaluated
 * win-rate target, and the prose artifacts each event needs. It owns ALL
 * structure + referential integrity; the LLM later fills only the prose.
 * Everything is seeded so replays match.
 *
 * Variance model (the demo payoff): firmographics are sampled COHERENTLY (size
 * drives employee/revenue/funding), an account's ICP fit is DERIVED from those
 * raw fields (config/icp.yaml), and outcomes are correlated.
 * Win probability is biased by ICP fit, competitor strength, multi-threading and
 * planted per-segment deltas; loss reason / price / product feedback correlate
 * with the competitor and outcome. Trends (state/trends.json) move volume,
 * competitor presence/strength and segment shares over time. The result is the
 * intentional, sliceable structure downstream dashboards GROUP BY.
 */

import { Rng } from "../util/rng.js";
import { addDays, addWeeks, daysBetween, isBefore, DAYS_PER_QUARTER, type ISODate } from "../util/date.js";
import { CohortIndex } from "../cohort.js";
import { pickUseCase, opportunityName } from "../use-cases.js";
import type { Config } from "../config/schema.js";
import type { Period } from "../clock.js";
import { evaluateTrends, type Trends } from "../trends.js";
import { Ledger, nextId } from "../ledger/ledger.js";
import type { Opportunity, World } from "../ledger/schema.js";
import { icWinModifier } from "../sales-team.js";
import { createdAtFor } from "./created-at.js";

import { buildRealAccountPool } from "./real-accounts.js";
import { openStages, stageForFraction, stageRank } from "../pipeline/stages.js";
import {
  pickRep,
  sampleCompetitors,
  makeAccount,
  makeBuyingGroup,
  pickTier,
  dealAmount,
  pickComplexity,
} from "./sample.js";
import {
  decideWin,
  pickLossReason,
  pickRepLossReason,
  pickPriceFeedback,
  pickProductFeedback,
  pickTechRequirements,
} from "./outcomes.js";
import {
  dealFacts,
  planArtifact,
  artifactDetail,
  normalizeModeMix,
  shouldEmitPerStage,
  planCloseArtifacts,
} from "./touchpoints.js";
export { backfillStageHistory, backfillTouchpoints } from "./backfill.js";

export interface PeriodSummary {
  index: number;
  start: ISODate;
  end: ISODate;
  newAccounts: number;
  newOpps: number;
  won: number;
  lost: number;
  artifactsPlanned: number;
}

export interface AdvanceResult {
  summaries: PeriodSummary[];
  /** Ids of artifacts planned across all periods (need prose generation). */
  plannedArtifactIds: string[];
  /**
   * Deals this advance created, to be enrolled in the Salesforce cohort as
   * `weekly` members by the CALLER, after it has saved the ledger. Reported
   * rather than written so a failed run cannot leave cohort.json describing
   * deals that were never persisted.
   */
  enrolled: { oppId: string; accountName: string; source: "weekly" }[];
}

/** Deterministic per-deal cycle length (recomputable from the seed). */
export function cycleWeeks(world: World, cfg: Config, oppId: string): number {
  const [lo, hi] = cfg.world.pipeline.avg_sales_cycle_weeks;
  return new Rng(`${world.seed}|cycle|${oppId}`).int(lo, hi);
}

export function closeTarget(world: World, cfg: Config, opp: Opportunity): ISODate {
  return addWeeks(opp.createdDate, cycleWeeks(world, cfg, opp.id));
}

/**
 * Advance the world through the given periods, mutating `world` in place.
 * Returns per-period summaries and the ids of newly-planned artifacts.
 */
export function advanceWorld(
  world: World,
  cfg: Config,
  trends: Trends,
  startDate: ISODate,
  periods: Period[],
  /** Cohort gate; loaded from state/cohort.json when omitted (tests pass their own). */
  cohortIndex?: CohortIndex,
  opts?: {
    /**
     * Per-run override of how many deals each period creates (`--new-opps=N`).
     * A one-off knob for a heavier increment; the standing rate lives in
     * `state/trends.json` `volume.newOppsPerWeek` and is not touched by this.
     */
    newOppsPerPeriod?: number;
  },
): AdvanceResult {
  const ledger = new Ledger(world);
  const summaries: PeriodSummary[] = [];
  const plannedArtifactIds: string[] = [];
  const isFirstEver = world.opportunities.length === 0;
  // Salesforce cohort. Deals created below are reported as `weekly` enrollments
  // for the caller to persist; pre-existing deals outside the cohort get no
  // Slack, since it could never be published for them anyway.
  const cohort = cohortIndex ?? new CohortIndex();
  const enrolledIds = new Set<string>();
  const newlyEnrolled: { oppId: string; accountName: string; source: "weekly" }[] = [];
  const slackFor = (oppId: string): boolean => cohort.allowsSlack(oppId) || enrolledIds.has(oppId);
  // Prose is planted only for deals that can actually reach a destination, on
  // the same argument that suppresses Slack at planting time rather than at
  // push time. A non-cohort deal never leaves the repo, so a transcript planned
  // for it can never be published; planting one only grows a backlog of
  // requests that every later bundle re-emits and nobody should ever fill.
  // (An absent cohort file means "no cohort selected" and everything passes.)
  const proseFor = (oppId: string): boolean => cohort.has(oppId) || enrolledIds.has(oppId);
  // Real target-account pool: consumed state is seeded from accounts already in
  // the ledger, so incremental runs never reuse a logo. Built once per advance.
  const realPool = buildRealAccountPool(world, cfg.world);

  for (const period of periods) {
    const rng = new Rng(`${world.seed}|period|${period.index}`);
    const eff = evaluateTrends(trends, cfg, startDate, period.end);
    const quarters = Math.max(0, daysBetween(startDate, period.end) / DAYS_PER_QUARTER);
    const summary: PeriodSummary = {
      index: period.index,
      start: period.start,
      end: period.end,
      newAccounts: 0,
      newOpps: 0,
      won: 0,
      lost: 0,
      artifactsPlanned: 0,
    };

    const planned = (a: Parameters<typeof planArtifact>[1]): void => {
      const art = planArtifact(world, a);
      art.detailLevel = artifactDetail(cfg, art.kind);
      plannedArtifactIds.push(art.id);
      summary.artifactsPlanned++;
    };

    // --- 1. New opportunities (with their accounts + buying groups) -----------
    const [lo, hi] = eff.newOppsPerWeek;
    const sampled = cfg.world.window.period === "month" ? rng.int(lo, hi) * 4 : rng.int(lo, hi);
    // The override is exact, not a range: the operator asked for N this run.
    // Still drawn through `rng` above so the rest of the period's stream (and
    // therefore every other deal's facts) stays identical either way.
    const count = opts?.newOppsPerPeriod ?? sampled;
    for (let i = 0; i < count; i++) {
      // Market-intelligence cohort: a larger-company, often non-PMM-driven deal
      // where the MI competitor competes (the "win when PMM is involved" story).
      const isMI = cfg.world.market_intelligence ? rng.chance(eff.marketIntelShare) : false;
      const pmmAbsent = isMI && rng.chance(eff.pmmAbsentRate);

      const account = makeAccount(world, cfg, eff, rng, realPool, isMI ? "mi" : undefined);
      world.accounts.push(account);
      summary.newAccounts++;

      const tier = pickTier(cfg, rng, account.size);
      const billingTerm: Opportunity["billingTerm"] = rng.chance(cfg.world.volume.pricing.annual_billing_rate)
        ? "annual"
        : "monthly";
      const { contacts, primaryId } = makeBuyingGroup(world, cfg, rng, account, tier, { pmmAbsent });
      world.contacts.push(...contacts);

      const createdDate = addDays(period.start, rng.int(0, 6));
      const createdAt = createdAtFor(createdDate, rng);
      // Competitors are sampled first so the use case can skew off them. You
      // meet a competitor because you are in their patch, not the other way
      // round. Use case never feeds back into the outcome (see src/use-cases.ts).
      const competitors = sampleCompetitors(cfg, rng, eff, isMI);
      const useCase = pickUseCase(cfg, competitors, rng);
      const opp: Opportunity = {
        id: nextId(world.opportunities, "opp"),
        name: opportunityName(account.name, useCase),
        accountId: account.id,
        ownerRepId: pickRep(world, rng, account.region),
        amount: dealAmount(cfg, rng, tier, billingTerm),
        tier,
        billingTerm,
        stage: "Discovery",
        status: "open",
        complexity: pickComplexity(rng, tier, account.size),
        createdDate,
        createdAt,
        // A deal opens in Discovery on the day it is created; every later
        // transition appends here as it happens.
        stageHistory: [{ stage: "Discovery", date: createdDate }],
        competitors,
        useCase,
        productFeedback: [],
        techStackRequirements: pickTechRequirements(rng, account.techStack),
        winLossMode: rng.weighted(normalizeModeMix(cfg)) as Opportunity["winLossMode"],
        contactIds: contacts.map((c) => c.id),
        primaryContactId: primaryId,
        external: {},
      };
      world.opportunities.push(opp);
      summary.newOpps++;
      // Deals born in a live run join the Salesforce cohort as `weekly` members:
      // they are the handful the operator adds each week and they get the FULL
      // detail layer, Slack included. (Enrollment is a no-op until a cohort has
      // been selected. See src/cohort.ts.)
      newlyEnrolled.push({ oppId: opp.id, accountName: account.name, source: "weekly" });
      enrolledIds.add(opp.id);

      // Discovery call transcript + an opening Slack thread (Batch 3, gated).
      if (cfg.world.generate.transcripts) {
        planned({
          id: nextId(world.artifacts, "art"),
          kind: "call_transcript",
          dealId: opp.id,
          title: `${account.name} — Discovery call`, // prose-lint: allow-emdash (external record name)
          date: createdDate,
          grounding: { ...dealFacts(ledger, opp), stage: "Discovery" },
        });
      }
      if (
        cfg.world.generate.ae_notes &&
        shouldEmitPerStage(cfg.world.artifacts.ae_notes_per_deal, "Discovery", rng)
      ) {
        planned({
          id: nextId(world.artifacts, "art"),
          kind: "ae_note",
          dealId: opp.id,
          title: `${account.name} — AE note (Discovery)`, // prose-lint: allow-emdash (external record name)
          date: createdDate,
          grounding: { ...dealFacts(ledger, opp), stage: "Discovery" },
        });
      }
      if (
        cfg.world.generate.emails &&
        shouldEmitPerStage(cfg.world.artifacts.emails_per_deal, "Discovery", rng)
      ) {
        planned({
          id: nextId(world.artifacts, "art"),
          kind: "email_exchange",
          dealId: opp.id,
          title: `${account.name} — email thread (Discovery)`, // prose-lint: allow-emdash (external record name)
          date: createdDate,
          grounding: { ...dealFacts(ledger, opp), stage: "Discovery" },
        });
      }
      if (cfg.world.generate.slack && slackFor(opp.id)) {
        planned({
          id: nextId(world.artifacts, "art"),
          kind: "slack_deal_thread",
          dealId: opp.id,
          title: `#deals — ${account.name} kickoff`, // prose-lint: allow-emdash (external record name)
          date: createdDate,
          grounding: {
            ...dealFacts(ledger, opp),
            messageCount: rng.int(...cfg.world.slack.posts_per_deal.deal_thread),
          },
        });
      }
    }

    // --- 2. Progress + close existing open deals ------------------------------
    for (const opp of world.opportunities) {
      if (opp.status !== "open") continue;
      if (isBefore(period.end, opp.createdDate)) continue; // not created yet in this period

      const target = closeTarget(world, cfg, opp);
      const dealRng = new Rng(`${world.seed}|close|${opp.id}`);
      // A non-cohort deal still lives its whole life here. It stages, closes,
      // and records its outcome, because that is what grounds the win-rate,
      // competitor and ICP statistics. It just grows no prose.
      const withProse = proseFor(opp.id);

      if (!isBefore(period.end, target)) {
        // Close it.
        const account = ledger.account(opp.accountId);
        const repMod = icWinModifier(cfg.salesTeam, opp.ownerRepId, quarters);
        // Persona-presence penalty: a deal with NO product-marketing persona in
        // the buying group wins less (the "win when PMM is involved" story). The
        // signal is derived from the recorded contacts, not stored on the deal.
        const pmmPresent = opp.contactIds.some(
          (id) => ledger.contact(id).buyingRole === cfg.personas.champion_role,
        );
        const personaAdj = pmmPresent ? 0 : -(cfg.world.market_intelligence?.win_penalty ?? 0);
        const won = decideWin(eff, account, opp, dealRng, repMod, personaAdj);
        opp.status = won ? "won" : "lost";
        opp.stage = "Closed";
        opp.closeDate = period.end;
        opp.stageHistory.push({ stage: "Closed", date: period.end });
        if (!won) {
          opp.winLossReason = pickLossReason(cfg, opp, dealRng);
          opp.repLossReason = pickRepLossReason(cfg, opp.winLossReason, dealRng);
        }
        opp.priceFeedback = pickPriceFeedback(dealRng, won, opp.winLossReason);
        opp.productFeedback = pickProductFeedback(
          dealRng,
          opp.winLossReason,
          cfg.prose.vocab.product_feedback,
        );
        if (won) summary.won++;
        else summary.lost++;

        // Win-loss artifact by mode (Batch 2, gated).
        if (cfg.world.generate.winloss && withProse)
          planCloseArtifacts(world, cfg, ledger, opp, period.end, planned, rng, slackFor(opp.id));
        // Closing AE note, the rep's own win/loss recap (grounds repLossReason,
        // the belief-vs-reality gap). Carries the closed facts (outcome + reason).
        if (cfg.world.generate.ae_notes && withProse) {
          planned({
            id: nextId(world.artifacts, "art"),
            kind: "ae_note",
            dealId: opp.id,
            title: `${account.name} — AE close note`, // prose-lint: allow-emdash (external record name)
            date: period.end,
            grounding: dealFacts(ledger, opp),
          });
        }
        if (cfg.world.generate.slack && slackFor(opp.id)) {
          planned({
            id: nextId(world.artifacts, "art"),
            kind: "slack_deal_thread",
            dealId: opp.id,
            title: `#deals — ${account.name} closed ${opp.status}`, // prose-lint: allow-emdash (external record name)
            date: period.end,
            grounding: {
              ...dealFacts(ledger, opp),
              messageCount: rng.int(...cfg.world.slack.posts_per_deal.deal_thread),
            },
          });
        }
      } else {
        // Progress the stage; plan a transcript when entering Evaluation/Proposal.
        const frac =
          daysBetween(opp.createdDate, period.end) / Math.max(1, daysBetween(opp.createdDate, target));
        const newStage = stageForFraction(openStages(cfg), frac);
        if (
          newStage !== opp.stage &&
          stageRank(openStages(cfg), newStage) > stageRank(openStages(cfg), opp.stage)
        ) {
          const entered = newStage;
          opp.stage = entered;
          opp.stageHistory.push({ stage: entered, date: period.end });
          if (!withProse) continue;
          const acctName = ledger.account(opp.accountId).name;
          if (
            cfg.world.generate.transcripts &&
            shouldEmitPerStage(cfg.world.artifacts.transcripts_per_deal, entered, rng)
          ) {
            planned({
              id: nextId(world.artifacts, "art"),
              kind: "call_transcript",
              dealId: opp.id,
              title: `${acctName} — ${entered} call`, // prose-lint: allow-emdash (external record name)
              date: period.end,
              grounding: { ...dealFacts(ledger, opp), stage: entered },
            });
          }
          if (
            cfg.world.generate.ae_notes &&
            shouldEmitPerStage(cfg.world.artifacts.ae_notes_per_deal, entered, rng)
          ) {
            planned({
              id: nextId(world.artifacts, "art"),
              kind: "ae_note",
              dealId: opp.id,
              title: `${acctName} — AE note (${entered})`, // prose-lint: allow-emdash (external record name)
              date: period.end,
              grounding: { ...dealFacts(ledger, opp), stage: entered },
            });
          }
          if (
            cfg.world.generate.emails &&
            shouldEmitPerStage(cfg.world.artifacts.emails_per_deal, entered, rng)
          ) {
            planned({
              id: nextId(world.artifacts, "art"),
              kind: "email_exchange",
              dealId: opp.id,
              title: `${acctName} — email thread (${entered})`, // prose-lint: allow-emdash (external record name)
              date: period.end,
              grounding: { ...dealFacts(ledger, opp), stage: entered },
            });
          }
        }
      }
    }

    // --- 3. Competitive questions in #competitive (Batch 3, gated) ------------
    if (cfg.world.generate.slack) {
      const qCount = rng.int(...cfg.world.slack.competitive_questions_per_week);
      for (let i = 0; i < qCount; i++) {
        const competitor = rng.pick(cfg.competitors.competitors).name;
        planned({
          id: nextId(world.artifacts, "art"),
          kind: "competitive_q",
          dealId: null,
          title: `#competitive — question about ${competitor}`, // prose-lint: allow-emdash (external record name)
          date: addDays(period.start, rng.int(0, 6)),
          grounding: { competitor },
        });
      }
    }

    // --- 4. Internal collateral (once, at the very first period, gated) -------
    if (isFirstEver && period.index === periods[0]!.index && cfg.world.generate.internal_collateral) {
      const n = rng.int(...cfg.world.artifacts.internal_collateral.count);
      for (let i = 0; i < n; i++) {
        const docType = rng.pick(cfg.world.artifacts.internal_collateral.types);
        planned({
          id: nextId(world.artifacts, "art"),
          kind: "internal_collateral",
          dealId: null,
          title: `${docType}`,
          date: addDays(period.start, rng.int(0, 6)),
          grounding: { docType },
        });
      }
    }

    summaries.push(summary);
  }

  // Enrollment is REPORTED, never written here. advanceWorld is a pure-ish
  // planner over the world it is handed; the caller owns persistence and only
  // commits cohort.json once the ledger it describes has itself been saved.
  // (Writing from in here also meant the test suite, which advances many
  // synthetic worlds, enrolled hundreds of phantom deals into the real file.)
  return { summaries, plannedArtifactIds, enrolled: newlyEnrolled };
}

// --- helpers -----------------------------------------------------------------
