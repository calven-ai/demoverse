/**
 * Zod schemas for the world-state ledger (state/world.json). See DESIGN.md §5–6.
 *
 * The ledger is the single source of truth. The deterministic generator owns
 * structure + referential integrity (stable ids); every entity records its
 * external ids (Salesforce Id / Drive fileId / Slack ts) after first creation so
 * re-runs UPDATE rather than duplicate. Schema-validating every emitted record
 * (and re-generating on failure) is a core robustness pillar (§7.2).
 */

import { z } from "zod";

export const DealStatus = z.enum(["open", "won", "lost"]);
export const WinLossMode = z.enum(["survey", "interview", "none"]);
export const DealTier = z.enum(["professional", "enterprise"]);
/** Self-service billing term — annual prepay gets two months free. */
export const BillingTerm = z.enum(["monthly", "annual"]);
/** Internal derived ICP fit tier (never reconciled — the downstream product re-derives it). */
export const IcpTier = z.enum(["Tier 1", "Tier 2", "Tier 3"]);

/**
 * Buying-committee role. An open string — the vocabulary is defined by
 * `config/personas.yaml` and validated there and by the domain linter, so the
 * ledger schema stays config-agnostic.
 */
export const BuyingRole = z.string();

/** Drive / Slack / Salesforce ids, attached after first reconcile. */
export const ExternalRefs = z.object({
  salesforceId: z.string().optional(),
  /**
   * For a call_transcript reconciled to Salesforce: the ContentDocument id of the
   * attached transcript File. `salesforceId` holds the activity Task id; this holds
   * the File so both can be reconciled idempotently on the same opportunity.
   */
  salesforceContentDocumentId: z.string().optional(),
  driveFileId: z.string().optional(),
  slackChannel: z.string().optional(),
  /** Root ts of a Slack thread (the parent message). */
  slackThreadTs: z.string().optional(),
});
export type ExternalRefs = z.infer<typeof ExternalRefs>;

export const RepRole = z.enum(["ic", "manager"]);

export const Rep = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  region: z.string(),
  /** ic = Account Executive (owns deals); manager = pure management (owns none). */
  role: RepRole.default("ic"),
  /** Manager this IC reports to (unset for managers). */
  managerId: z.string().optional(),
  title: z.string().optional(),
  external: ExternalRefs.default({}),
});
export type Rep = z.infer<typeof Rep>;

export const Account = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  /** Industry, from config/world.yaml segments.industries. */
  industry: z.string(),
  size: z.string(), // Enterprise | Mid-market | SMB
  /** Firmographic bands (src/domain/bands.ts; the ICP scorecard dimensions). */
  employeeBand: z.string(),
  revenueBand: z.string(),
  fundingStage: z.string(),
  region: z.string(), // NA | EMEA
  /**
   * Provenance for a REAL target-account logo: the prospect list it was drawn
   * from (config world.prospects). Absent for synthetically-named accounts.
   * Real accounts carry real firmographics (derived from the list), so their
   * employee/funding bands are valid CRM enums but need not sit in the synthetic
   * segments.by_size conditional table.
   */
  source: z.string().optional(),
  triggers: z.array(z.string()).default([]),
  techStack: z.array(z.string()).default([]),
  /**
   * INTERNAL derived ICP fit (from config/icp.yaml over the raw firmographics).
   * Used to bias outcomes + classify in/out-of-ICP in the pre-flight report.
   * NEVER reconciled to any external system — the downstream product computes its own.
   */
  icpScore: z.number().min(0).max(100),
  icpTier: IcpTier,
  external: ExternalRefs.default({}),
});
export type Account = z.infer<typeof Account>;

export const Contact = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  title: z.string(),
  buyingRole: BuyingRole,
  seniority: z.string().optional(),
  email: z.string(),
  external: ExternalRefs.default({}),
});
export type Contact = z.infer<typeof Contact>;

export const Opportunity = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string(),
  ownerRepId: z.string(),
  amount: z.number().nonnegative(),
  /** Pricing tier (Professional | Enterprise) — fixed price, self-service. */
  tier: DealTier,
  /** monthly | annual contract — the only thing that varies the base price. */
  billingTerm: BillingTerm,
  stage: z.string(),
  status: DealStatus,
  /** Deal complexity (Low | Medium | High). */
  complexity: z.string(),
  /** ISO date (YYYY-MM-DD). */
  createdDate: z.string(),
  /** ISO-8601 datetime — createdDate + a seeded business-hours time. SF push source. */
  createdAt: z.string().optional(),
  closeDate: z.string().optional(),
  /**
   * When the deal ENTERED each pipeline stage, oldest first. The first entry is
   * always Discovery on `createdDate`; the last is Closed on `closeDate` once
   * decided. Stages the deal skipped (a short cycle can jump Evaluation
   * straight to Negotiation) simply do not appear.
   *
   * This is the raw material for stage-duration / pipeline-velocity analysis —
   * how long a deal sat in each stage. Salesforce's own `OpportunityHistory`
   * cannot serve that here: it is system-generated, so every transition would
   * be stamped with the reconcile time rather than the simulated date. The
   * reconciler therefore pushes these into per-stage custom date fields.
   */
  stageHistory: z.array(z.object({ stage: z.string(), date: z.string() })).default([]),
  /** Competitor names present on this deal (must exist in competitors.yaml). */
  competitors: z.array(z.string()).default([]),
  /**
   * The primary domain use case — what the buyer walked in asking for (a name
   * from config/use-cases.yaml). Drives the Opportunity name and is the dominant
   * theme of every artifact on the deal.
   *
   * Optional for backward compatibility with ledgers written before use cases
   * existed; `npm run assign-use-cases` backfills them.
   */
  useCase: z.string().optional(),
  /** Set only when status is lost — crm-shared.ts LOSS_REASON_OPTIONS. */
  winLossReason: z.string().optional(),
  /**
   * The AE-believed loss reason (what the opportunity OWNER thinks lost the deal),
   * set only when lost. Usually matches `winLossReason` (the prospect/win-loss
   * truth) but diverges on a minority of deals — the belief-vs-reality gap analytics
   * surfaces. Also a LOSS_REASON_OPTIONS value.
   */
  repLossReason: z.string().optional(),
  /** Price feedback vs the competition (set on close, won or lost). */
  priceFeedback: z.string().optional(),
  /** Product-feedback areas (prose.yaml vocab.product_feedback; multi). */
  productFeedback: z.array(z.string()).default([]),
  /** crm-shared.ts TECH_STACK_OPTIONS named as requirements on the deal. */
  techStackRequirements: z.array(z.string()).default([]),
  winLossMode: WinLossMode,
  /** Buying-group contact ids involved in this deal. */
  contactIds: z.array(z.string()).default([]),
  /** The primary contact (the champion) — is_primary on opportunity_contacts. */
  primaryContactId: z.string().optional(),
  external: ExternalRefs.default({}),
});
export type Opportunity = z.infer<typeof Opportunity>;

export const ArtifactKind = z.enum([
  "call_transcript",
  "survey",
  "interview",
  "winloss_post", // Slack #win-loss post-mortem (the sole signal for none-mode deals)
  "slack_deal_thread",
  "competitive_q",
  "internal_collateral",
  "ae_note", // account-exec note logged on the deal (Salesforce Task + Drive file)
  "email_exchange", // a threaded rep<->buyer email conversation (Salesforce Email Tasks)
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** A single Slack message within a thread (persona-attributed). */
export const SlackMessage = z.object({
  personaHandle: z.string(),
  personaDisplay: z.string(),
  avatar: z.string().optional(),
  text: z.string(),
  /** Posted-message ts, set after reconcile. */
  ts: z.string().optional(),
});
export type SlackMessage = z.infer<typeof SlackMessage>;

/** A single email within an email_exchange thread. */
export const EmailMessage = z.object({
  /** Sender, e.g. "Dana Reyes <dana@acme.com>". */
  from: z.string(),
  /** Recipient addresses. */
  to: z.array(z.string()).default([]),
  subject: z.string(),
  body: z.string(),
  /** ISO date (YYYY-MM-DD) of this message. */
  date: z.string(),
  /** Resolved buying-group contact id this email is with (for the SF Task WhoId). */
  contactId: z.string().optional(),
  /** SF Task id, set after reconcile (per-message idempotency). */
  salesforceId: z.string().optional(),
});
export type EmailMessage = z.infer<typeof EmailMessage>;

export const ArtifactStatus = z.enum(["planned", "generated", "reconciled"]);

export const Artifact = z.object({
  id: z.string(),
  kind: ArtifactKind,
  /** Opportunity id this artifact is tied to (null for standalone, e.g. some collateral). */
  dealId: z.string().nullable(),
  title: z.string(),
  detailLevel: z.enum(["low", "medium", "high"]).default("medium"),
  /** ISO date the artifact is dated to. */
  date: z.string(),
  /**
   * Grounding facts snapshot the prose must honor (competitors, contacts, loss
   * reason, etc.). The linter checks the generated content against this.
   */
  grounding: z.record(z.string(), z.unknown()).default({}),
  /** Path (relative to repo root) of the generated markdown body, if file-based. */
  contentPath: z.string().optional(),
  /** Hash of the generated content, for change detection on reconcile. */
  contentHash: z.string().optional(),
  /** For Slack artifacts: the per-persona messages. */
  messages: z.array(SlackMessage).optional(),
  /** For email_exchange artifacts: the per-message email thread. */
  emails: z.array(EmailMessage).optional(),
  status: ArtifactStatus.default("planned"),
  external: ExternalRefs.default({}),
});
export type Artifact = z.infer<typeof Artifact>;

export const World = z.object({
  /** Stable seed; all deterministic sampling derives from this + period index. */
  seed: z.string(),
  /** Schema/format version of the ledger. */
  version: z.literal(1).default(1),
  reps: z.array(Rep).default([]),
  accounts: z.array(Account).default([]),
  contacts: z.array(Contact).default([]),
  opportunities: z.array(Opportunity).default([]),
  artifacts: z.array(Artifact).default([]),
});
export type World = z.infer<typeof World>;
