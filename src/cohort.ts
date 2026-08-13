/**
 * The Salesforce cohort — which deals are allowed to leave this repo.
 *
 * The ledger deliberately holds far more deals than the demo org should show:
 * the full 283-deal history is what grounds the win rate, per-competitor win
 * rates and ICP statistics in the run reports. Only a curated ~50 of them are
 * meant to exist in Salesforce, each one FULLY populated, rather than 283 bare
 * CRM shells.
 *
 * `state/cohort.json` is that membership list, and it is the authority: every
 * reconcile target filters through it, and `apply --next` (so `/backfill-opps`)
 * only ever walks its members. Deals outside it stay in the ledger and simply
 * never leave the repo.
 *
 * Membership carries only what CANNOT be derived — chiefly `source`:
 *
 *   seed    the one-time backfill cohort. Transcripts + emails always, AE notes
 *           and win-loss occasionally, and NO Slack: the demo Slack workspace is
 *           reserved for deals the operator creates week by week.
 *   weekly  a deal created by a normal `apply` run after the cohort existed.
 *           Gets the full detail layer, Slack included.
 *
 * Everything else (is it in Salesforce? are its assets complete?) is computed
 * live from the ledger by `npm run cohort`, never stored, so cohort.json and
 * world.json cannot drift apart.
 */

import { z } from "zod";
import { repoPath, readJson, writeJson, fileExists } from "./util/fs.js";
import type { World, Artifact } from "./ledger/schema.js";

export const COHORT_PATH = repoPath("state", "cohort.json");

/** Artifact kinds that only ever exist for `weekly` members. */
export const SLACK_KINDS = ["slack_deal_thread", "competitive_q", "winloss_post"] as const;

export const CohortSource = z.enum(["seed", "weekly"]);
export type CohortSource = z.infer<typeof CohortSource>;

export const CohortMember = z.object({
  oppId: z.string(),
  /** Denormalized for readability of the file itself; the ledger stays authoritative. */
  accountName: z.string(),
  source: CohortSource,
  addedOn: z.string(),
});
export type CohortMember = z.infer<typeof CohortMember>;

export const Cohort = z.object({
  version: z.literal(1),
  targetSize: z.number(),
  members: z.array(CohortMember),
});
export type Cohort = z.infer<typeof Cohort>;

export function cohortExists(): boolean {
  return fileExists(COHORT_PATH);
}

/** Load the cohort, or an empty one if it has not been selected yet. */
export function loadCohort(): Cohort {
  if (!cohortExists()) return { version: 1, targetSize: 0, members: [] };
  return Cohort.parse(readJson(COHORT_PATH));
}

export function saveCohort(cohort: Cohort): void {
  const sorted = {
    ...cohort,
    members: [...cohort.members].sort((a, b) => a.oppId.localeCompare(b.oppId)),
  };
  writeJson(COHORT_PATH, sorted);
}

/**
 * Membership index. Built once per command; `has()` is the gate every reconcile
 * target and the `--next` queue run through.
 *
 * An ABSENT cohort file means "no cohort selected yet" and everything passes —
 * so the engine behaves exactly as it did before this file existed, and adding
 * cohort scoping cannot retroactively break a fresh `init`.
 */
export class CohortIndex {
  private readonly bySource = new Map<string, CohortSource>();
  readonly active: boolean;

  constructor(cohort: Cohort = loadCohort()) {
    this.active = cohort.members.length > 0;
    for (const m of cohort.members) this.bySource.set(m.oppId, m.source);
  }

  /**
   * Is this deal allowed to reach the external systems at all?
   *
   * A null/absent dealId means the artifact is NOT deal-scoped — a standalone
   * #competitive question, a piece of internal collateral — so the cohort has
   * no opinion on it and it passes. The cohort governs which DEALS exist
   * externally, not which channel content does.
   */
  has(oppId: string | null | undefined): boolean {
    if (!this.active) return true;
    if (oppId == null) return true;
    return this.bySource.has(oppId);
  }

  source(oppId: string): CohortSource | undefined {
    return this.bySource.get(oppId);
  }

  /**
   * Slack is reserved for deals the operator adds week by week. Seed members
   * carry no Slack artifacts at all, and any that were planted before the cohort
   * existed are never pushed.
   */
  allowsSlack(oppId: string | null | undefined): boolean {
    if (!this.active) return true;
    if (oppId == null) return true; // not deal-scoped — see has()
    return this.bySource.get(oppId) === "weekly";
  }

  get size(): number {
    return this.bySource.size;
  }

  ids(): string[] {
    return [...this.bySource.keys()].sort();
  }
}

/** True for an artifact kind that only `weekly` members may carry. */
export function isSlackKind(kind: Artifact["kind"]): boolean {
  return (SLACK_KINDS as readonly string[]).includes(kind);
}

/** Add deals to the cohort, ignoring ones already present. Returns the new count. */
export function enroll(
  cohort: Cohort,
  entries: { oppId: string; accountName: string; source: CohortSource }[],
  addedOn: string,
): number {
  const known = new Set(cohort.members.map((m) => m.oppId));
  let added = 0;
  for (const e of entries) {
    if (known.has(e.oppId)) continue;
    cohort.members.push({ ...e, addedOn });
    known.add(e.oppId);
    added++;
  }
  return added;
}

/** Per-deal asset rollup, derived from the ledger (never stored). */
export interface MemberStatus {
  oppId: string;
  accountName: string;
  source: CohortSource;
  dealStatus: string;
  inSalesforce: boolean;
  counts: Record<string, { generated: number; planned: number }>;
  planned: number;
  total: number;
  /** untouched | N planned | complete */
  state: "untouched" | "planned" | "complete";
}

export function memberStatuses(world: World, cohort: Cohort): MemberStatus[] {
  const acct = new Map(world.accounts.map((a) => [a.id, a]));
  const opp = new Map(world.opportunities.map((o) => [o.id, o]));
  const byDeal = new Map<string, Artifact[]>();
  for (const a of world.artifacts) {
    if (!a.dealId) continue;
    const list = byDeal.get(a.dealId) ?? [];
    list.push(a);
    byDeal.set(a.dealId, list);
  }

  return cohort.members.map((m) => {
    const o = opp.get(m.oppId);
    const arts = byDeal.get(m.oppId) ?? [];
    const counts: MemberStatus["counts"] = {};
    for (const a of arts) {
      const c = (counts[a.kind] ??= { generated: 0, planned: 0 });
      if (a.status === "planned") c.planned++;
      else c.generated++;
    }
    const planned = arts.filter((a) => a.status === "planned").length;
    const state = arts.length === 0 ? "untouched" : planned > 0 ? "planned" : "complete";
    return {
      oppId: m.oppId,
      accountName: o ? (acct.get(o.accountId)?.name ?? m.accountName) : m.accountName,
      source: m.source,
      dealStatus: o?.status ?? "(missing from ledger)",
      inSalesforce: Boolean(o?.external.salesforceId),
      counts,
      planned,
      total: arts.length,
      state,
    };
  });
}
