/**
 * Zod schemas for the Tier-1 standing config (config/*.yaml). See DESIGN.md §11.
 *
 * These validate the human-authored seed files with friendly errors and supply
 * sensible defaults, so a minimal config still yields a good world.
 */

import { z } from "zod";

/** A {key: weight} distribution; weights are positive and need not sum to 1. */
const Distribution = z.record(z.string(), z.number().nonnegative());

/** A [min, max] inclusive integer range. */
const IntRange = z
  .tuple([z.number().int(), z.number().int()])
  .refine(([a, b]) => a <= b, { message: "range must be [min, max] with min <= max" });

const DetailLevel = z.enum(["low", "medium", "high"]);

/** Fixed self-service price per billing term (annual = two months free). */
const TierPrice = z.object({
  monthly: z.number().positive(), // annualized run-rate of a monthly contract
  annual: z.number().positive(), // annual prepay (10× the monthly rate)
});

// --- world.yaml --------------------------------------------------------------

export const WorldConfigSchema = z.object({
  company: z.object({
    name: z.string(),
    /** Colloquial name for prose ("Acme" vs "Acme.io"); defaults to `name`. */
    short_name: z.string().optional(),
    domain: z.string(),
    /**
     * Suffix for fabricated contact email domains (`<account>.<suffix>`), kept
     * under the reserved .example TLD so a synthetic mailbox can never resolve.
     */
    synthetic_email_domain: z.string().default("demo.example"),
    /** The company's product modules — options for the win-loss `product_modules` question. */
    product_modules: z.array(z.string()).default([]),
  }),
  generate: z
    .object({
      transcripts: z.boolean().default(true),
      winloss: z.boolean().default(true),
      slack: z.boolean().default(true),
      internal_collateral: z.boolean().default(true),
      // Touch-point kinds for the live weekly engine (advanceWorld). The
      // retroactive backfill planner does NOT consult these — it plants the full
      // touch-point set on demand, gated only by the per-deal cadence below.
      ae_notes: z.boolean().default(false),
      emails: z.boolean().default(false),
    })
    .default({}),
  detail: z
    .object({
      call_transcripts: DetailLevel.default("medium"),
      phone_interviews: DetailLevel.default("high"),
      surveys: DetailLevel.default("low"),
      slack: DetailLevel.default("medium"),
      ae_notes: DetailLevel.default("low"),
      emails: DetailLevel.default("medium"),
    })
    .default({}),
  window: z
    .object({
      history_quarters: z.number().int().positive().default(4),
      period: z.enum(["week", "month"]).default("week"),
      keep_fresh_days: z.number().int().positive().default(120),
    })
    .default({}),
  volume: z.object({
    new_opps_per_week: IntRange,
    pricing: z.object({
      professional: TierPrice,
      enterprise: TierPrice,
      /** Share of deals on an annual contract (vs monthly). */
      annual_billing_rate: z.number().min(0).max(1),
      /** Per account-size, the {tier: weight} mix used to pick a deal's tier. */
      tier_by_size: z.record(z.string(), Distribution),
      /** A small minority of Enterprise deals carry round-number add-ons. */
      addons: z.object({
        enterprise_rate: z.number().min(0).max(1),
        increments_usd: z.array(z.number().positive()).min(1),
        max_total_usd: z.number().positive(),
      }),
    }),
  }),
  pipeline: z.object({
    stages: z.array(z.string()).min(2),
    avg_sales_cycle_weeks: IntRange,
  }),
  winloss: z.object({
    baseline_win_rate: z.number().min(0).max(1),
    win_rate_trend_per_quarter: z.number(),
    loss_reasons: Distribution,
    competitor_present_rate: z.number().min(0).max(1),
    mode_mix: z.object({
      interview: z.number().min(0).max(1),
      survey: z.number().min(0).max(1),
      none: z.number().min(0).max(1),
    }),
  }),
  /**
   * Real target-account source lists. When present + enabled, the generator
   * draws each account's name/domain/industry/firmographics from these prospect
   * CSVs (the canonical workspace lists) instead of the synthetic name banks;
   * contacts and the pipeline stay synthetic. Omitted/disabled → fully synthetic.
   */
  prospects: z
    .object({
      enabled: z.boolean().default(true),
      /** Directory of prospect CSVs, resolved relative to the repo root. */
      dir: z.string(),
      /**
       * CSV lists within `dir` to load and merge (dedup by domain). A fixed
       * `industry` maps every row of a single-vertical list; omit it for mixed
       * lists (rows then map via `segments.industry_keywords`). A fixed
       * `region` overrides per-row headquarters detection.
       */
      files: z
        .array(
          z.object({
            file: z.string(),
            industry: z.string().optional(),
            region: z.string().optional(),
          }),
        )
        .min(1),
    })
    .optional(),
  segments: z.object({
    industries: Distribution,
    /**
     * Ordered free-text → industry keyword rules for mixed prospect lists (first
     * match wins; `pattern` is a case-insensitive regex). Rows matching nothing
     * take `industry_fallback`, or are skipped when that is unset.
     */
    industry_keywords: z.array(z.object({ industry: z.string(), pattern: z.string() })).default([]),
    industry_fallback: z.string().optional(),
    /** Region → CRM BillingCountry for the standard firmographic fields. */
    region_countries: z
      .record(z.string(), z.string())
      .default({ NA: "United States", EMEA: "United Kingdom" }),
    sizes: Distribution,
    /** Per account-size conditional firmographics (kept internally coherent). */
    by_size: z.record(
      z.string(),
      z.object({
        employee_bands: Distribution,
        revenue_bands: Distribution,
        funding_stages: Distribution,
      }),
    ),
    regions: Distribution,
    /** Independent presence probability per tool / per trigger (0..1 each). */
    tech_stack: z.record(z.string(), z.number().min(0).max(1)),
    triggers: z.record(z.string(), z.number().min(0).max(1)),
  }),
  /**
   * The market-intelligence buying motion (the "win when PMM is
   * involved" story). A larger-company cohort where a fraction of deals have no
   * product-marketing persona driving — encoded purely as sampling bias. The
   * cohort share ramps over time via state/trends.json. Optional: configs without
   * it simply have no MI cohort.
   */
  market_intelligence: z
    .object({
      /** Baseline share of new opps in this cohort (ramps via trends.json). */
      share: z.number().min(0).max(1),
      /** Within the cohort, fraction of deals with no PMM persona driving. */
      pmm_absent_rate: z.number().min(0).max(1),
      /** Dominant competitor in this cohort (a competitors.yaml name). */
      competitor: z.string(),
      /** Non-PMM persona role that anchors a PMM-absent deal (a personas.yaml role). */
      primary_role: z.string(),
      /** Persona roles allowed in a PMM-absent buying group (personas.yaml roles). */
      driver_roles: z.array(z.string()).min(1),
      /** Additive win-probability penalty on a deal with no PMM persona present. */
      win_penalty: z.number().min(0).max(1).default(0),
      /** Bigger-company firmographic skew (bands ⊆ segments.by_size.Enterprise). */
      firmographics: z.object({
        employee_bands: Distribution,
        revenue_bands: Distribution,
        funding_stages: Distribution,
      }),
    })
    .optional(),
  artifacts: z.object({
    transcripts_per_deal: z.record(z.string(), z.union([z.number().int(), IntRange])),
    /** Per-stage AE-note cadence (same shape as transcripts_per_deal). */
    ae_notes_per_deal: z.record(z.string(), z.union([z.number().int(), IntRange])).default({}),
    /** Per-stage email-thread cadence (same shape as transcripts_per_deal). */
    emails_per_deal: z.record(z.string(), z.union([z.number().int(), IntRange])).default({}),
    /** Probability a deal also carries an opportunity-scoped #competitive question. */
    competitive_q_rate: z.number().min(0).max(1).default(0),
    /**
     * Chance a closed deal carries the rep's closing AE note. Below 1.0 the CRM
     * stops being uniformly well-logged, which is what makes the downstream
     * win-loss interviews necessary. 1.0 restores the old always-on behavior.
     */
    ae_close_note_rate: z.number().min(0).max(1).default(1),
    internal_collateral: z.object({
      count: IntRange,
      types: z.array(z.string()).min(1),
    }),
  }),
  slack: z.object({
    posts_per_deal: z.object({
      deal_thread: IntRange,
      competitive_q: IntRange,
    }),
    competitive_questions_per_week: IntRange,
  }),
});

export type WorldConfig = z.infer<typeof WorldConfigSchema>;

// --- competitors.yaml --------------------------------------------------------

export const CompetitorsConfigSchema = z.object({
  competitors: z
    .array(
      z.object({
        name: z.string(),
        domain: z.string(),
        category: z.string(),
        positioning: z.string(),
        strength: z.number().min(0).max(1),
        typical_loss_reasons: z.array(z.string()).default([]),
        /** Optional buying-motion cohort tag (e.g. "market_intelligence"). */
        cohort: z.string().optional(),
      }),
    )
    .min(1),
});

export type CompetitorsConfig = z.infer<typeof CompetitorsConfigSchema>;
export type Competitor = CompetitorsConfig["competitors"][number];

// --- surveys.yaml ------------------------------------------------------------

/** The 7 win-loss question types. */
export const SurveyQuestionType = z.enum([
  "open_text",
  "single_select",
  "multi_select",
  "vendor_select",
  "comparison_table",
  "rating_scale",
  "yes_no",
]);

const SurveyQuestionSchema = z.object({
  id: z.string(),
  type: SurveyQuestionType,
  prompt: z.string(),
  /** Optional questions set this false; everything else is answered. */
  required: z.boolean().default(true),
  /** Literal options for single_select / multi_select. */
  options: z.array(z.string()).optional(),
  /** Draw options from a prior question's answer (e.g. vendor_chosen ← vendors_evaluated). */
  options_from: z.string().optional(),
  /** Draw options from a config list (currently only "product_modules"). */
  options_from_config: z.enum(["product_modules"]).optional(),
  /** comparison_table: one row per the named question's answer. */
  rows_from: z.string().optional(),
  /** comparison_table column headers. */
  columns: z.array(z.string()).optional(),
  /** multi_select: allow free-text additions beyond the listed options. */
  allow_other: z.boolean().optional(),
  /** rating_scale: allow a free-text comment alongside the rating. */
  allow_comment: z.boolean().optional(),
  /** rating_scale bounds. */
  scale: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
});

export type SurveyQuestion = z.infer<typeof SurveyQuestionSchema>;

const SurveyGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  questions: z.array(SurveyQuestionSchema).min(1),
});

/** One outcome's questionnaire (win or loss), grouped into sections. */
const WinLossSurveySchema = z.object({
  meta: z.object({
    title: z.string(),
    intro: z.string(),
  }),
  groups: z.array(SurveyGroupSchema).min(1),
});

export type WinLossSurvey = z.infer<typeof WinLossSurveySchema>;

export const SurveysConfigSchema = z.object({
  /** Closed-won questionnaire ("Win analysis"). */
  win: WinLossSurveySchema,
  /** Closed-lost questionnaire ("Loss analysis"). */
  loss: WinLossSurveySchema,
  interview_style: z
    .object({
      follow_ups: z.boolean().default(true),
      tangents: z.boolean().default(true),
      verbatim_color: z.boolean().default(true),
      approx_duration_min: IntRange,
    })
    .optional(),
});

export type SurveysConfig = z.infer<typeof SurveysConfigSchema>;

// --- slack-personas.yaml -----------------------------------------------------

export const SlackPersonasConfigSchema = z.object({
  avatar_style: z.enum(["initials", "emoji", "image"]).default("initials"),
  internal_personas: z
    .array(
      z.object({
        handle: z.string(),
        display: z.string(),
        role: z.string(),
        avatar: z.string().optional(),
        /** One-line voice card rendered into Slack prompts so personas don't all sound alike. */
        voice: z.string().optional(),
      }),
    )
    .default([]),
  rep_personas: z
    .array(
      z.object({
        handle: z.string(),
        display: z.string(),
        avatar: z.string().optional(),
        /** One-line voice card rendered into Slack prompts so personas don't all sound alike. */
        voice: z.string().optional(),
      }),
    )
    .default([]),
});

export type SlackPersonasConfig = z.infer<typeof SlackPersonasConfigSchema>;

// --- icp.yaml ----------------------------------------------------------------

/** One weighted dimension of the ICP fit scorecard. */
const IcpDimension = z.object({
  weight: z.number().nonnegative(),
  match: z.enum(["exact", "anyOf"]).default("exact"),
  /** {option value → fraction 0..1} lookup; missing keys score 0. */
  levels: z.record(z.string(), z.number().min(0).max(1)),
});

export const IcpConfigSchema = z.object({
  thresholds: z.object({
    tier1: z.number().min(0).max(100),
    tier2: z.number().min(0).max(100),
  }),
  dimensions: z.record(z.string(), IcpDimension),
});

export type IcpConfig = z.infer<typeof IcpConfigSchema>;

// --- personas.yaml -----------------------------------------------------------

export const PersonasConfigSchema = z.object({
  /** Role that always anchors a deal (the primary contact). */
  champion_role: z.string(),
  personas: z
    .array(
      z.object({
        role: z.string(),
        label: z.string(),
        seniority: z.string(),
        /** Probability this role appears on a given deal (champion = 1.0). */
        presence: z.number().min(0).max(1),
        titles: z.array(z.string()).min(1),
      }),
    )
    .min(1),
  /**
   * Which buying roles are actually IN THE ROOM for a call at each pipeline
   * stage. The deal's full buying group accumulates over its life, but an early
   * call only has a subset present (a first discovery call is 1–2 people, never
   * IT). The transcript builder intersects this allowlist with the deal's
   * contacts (plus the primary contact, always). A missing/empty stage means
   * "primary contact only".
   */
  attendees_by_stage: z.record(z.string(), z.array(z.string())).default({}),
});

export type PersonasConfig = z.infer<typeof PersonasConfigSchema>;

// --- product.yaml ------------------------------------------------------------

/** One autonomous agent/feature within a product domain (the demo surface). */
const ProductAgent = z.object({
  name: z.string(),
  /** One-line value prop the AE can say in a demo. */
  value_prop: z.string(),
  /** The buyer pain this agent solves. */
  solves: z.string(),
});

/** A buyer pain → which module/agent to lead with, plus the decision driver. */
const PainToModule = z.object({
  persona: z.string(),
  pain: z.string(),
  lead_with: z.string(),
  decision_driver: z.string(),
});

/**
 * Durable product grounding for sales-call transcripts — positioning,
 * the domain/agent catalog (the demo surface), the pain→module map, and brand
 * guardrails — the company's messaging document rendered into every call prompt.
 */
export const ProductConfigSchema = z.object({
  positioning: z.object({
    one_liner: z.string(),
    category: z.string(),
    universe: z.string(),
  }),
  domains: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string(),
        agents: z.array(ProductAgent).min(1),
      }),
    )
    .min(1),
  pain_to_module: z.array(PainToModule).default([]),
  brand_guardrails: z.array(z.string()).default([]),
});

export type ProductConfig = z.infer<typeof ProductConfigSchema>;

// --- sales-team.yaml ---------------------------------------------------------

const SalesManager = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  region: z.string(),
  title: z.string().default("Regional Sales Manager"),
});

const SalesIc = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  region: z.string(),
  title: z.string().default("Account Executive"),
  /** Manager id this IC reports to. */
  reports_to: z.string(),
  /** Additive bias on win probability for this AE's deals. */
  win_modifier: z.number().default(0),
  /** Optional improvement per quarter (the ramping new hire). */
  ramp_per_quarter: z.number().default(0),
});

export const SalesTeamConfigSchema = z.object({
  managers: z.array(SalesManager).min(1),
  ics: z.array(SalesIc).min(1),
});

export type SalesTeamConfig = z.infer<typeof SalesTeamConfigSchema>;
export type SalesIc = z.infer<typeof SalesIc>;

// --- aggregate ---------------------------------------------------------------

/**
 * Domain use cases — what the buyer walked in asking for. Coarser than the
 * product's 10 agents on purpose (a buyer says "get on top of our competitors",
 * not "a Battle Card agent"), so each use case maps to the agent(s) demoed for it.
 */
export const UseCaseSchema = z.object({
  name: z.string(),
  /** Reuses world.yaml company.product_modules verbatim. */
  domain: z.string(),
  agents: z.array(z.string()).min(1),
  /** How common this use case is overall. Relative; normalized across the set. */
  target_share: z.number().positive(),
  /** Lowercase phrases that identify this use case in prose (matching + lint). */
  keywords: z.array(z.string()).default([]),
  buyer_pain: z.string(),
  lead_with: z.string(),
  /**
   * Relative sampling weight per competitor on the deal — a skew, not a rule.
   * Competitors absent here score `default_weight`.
   */
  competitor_weights: z.record(z.string(), z.number().nonnegative()).default({}),
});
export type UseCase = z.infer<typeof UseCaseSchema>;

export const UseCasesConfigSchema = z.object({
  default_weight: z.number().positive().default(1),
  use_cases: z.array(UseCaseSchema).min(1),
});
export type UseCasesConfig = z.infer<typeof UseCasesConfigSchema>;

// --- prose.yaml --------------------------------------------------------------
// The story banks: seeded variety axes, per-artifact structural shapes, per-
// stage call focus, the anti-repetition blocklist, and the free-sample vocab.
// This file is what makes the prose sound like YOUR fictional company's world;
// the engine only draws from it deterministically.

export const ProseConfigSchema = z.object({
  /** Why THIS buyer is looking — the deal's backstory, one per deal. */
  narrative_angles: z.array(z.string()).min(4),
  /** How the buying group communicates, one per deal. */
  buyer_tones: z.array(z.string()).min(3),
  /** Friction the rep must handle. Leak-safe: never implies the outcome. */
  objection_themes: z.array(z.string()).min(4),
  /** Urgency texture, one per deal. */
  timeline_pressures: z.array(z.string()).min(3),
  /** Per-artifact-kind structural variants (one draw per artifact). */
  artifact_shapes: z.record(z.string(), z.array(z.string()).min(2)).default({}),
  /** Per-stage sales-motion focus for call transcripts; `default` is the fallback. */
  stage_focus: z.record(z.string(), z.string()),
  /** Anti-repetition blocklist; promote offenders here as lint surfaces them. */
  banned_phrases: z.array(z.string()).default([]),
  vocab: z.object({
    /** Product-feedback option list sampled onto closed deals. */
    product_feedback: z.array(z.string()).min(3),
  }),
});
export type ProseConfig = z.infer<typeof ProseConfigSchema>;

// --- connectors.yaml ---------------------------------------------------------
// Per-destination wiring: whether each connector runs, and the destination-side
// naming the engine writes into (CRM stage names, Drive folder tree, Slack
// channels). Credentials stay in `.env` — this file is safe to commit.

export const ConnectorsConfigSchema = z.object({
  salesforce: z
    .object({
      enabled: z.boolean().default(true),
      /** Engine pipeline stage → Salesforce Opportunity StageName picklist value. */
      stage_map: z.record(z.string(), z.string()),
    })
    .default({ stage_map: {} }),
  hubspot: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  drive: z
    .object({
      enabled: z.boolean().default(true),
      /** Artifact kind → top-level folder name in the shared Drive folder. */
      folders: z.record(z.string(), z.string()),
    })
    .default({ folders: {} }),
  slack: z
    .object({
      enabled: z.boolean().default(true),
      /** Artifact kind → channel. Channels must exist in the workspace. */
      channels: z.record(z.string(), z.string()),
      fallback_channel: z.string().default("#general"),
    })
    .default({ channels: {} }),
});
export type ConnectorsConfig = z.infer<typeof ConnectorsConfigSchema>;

export interface Config {
  world: WorldConfig;
  useCases: UseCasesConfig;
  competitors: CompetitorsConfig;
  surveys: SurveysConfig;
  slackPersonas: SlackPersonasConfig;
  icp: IcpConfig;
  personas: PersonasConfig;
  salesTeam: SalesTeamConfig;
  product: ProductConfig;
  prose: ProseConfig;
  connectors: ConnectorsConfig;
}
