/**
 * Engine tests. The coherence linter is a first-class, tested feature (DESIGN §7.1);
 * determinism (replayability) is the core property of the ledger model (§5).
 * Batch 1 adds: enum fidelity to the reference CRM vocabulary, firmographic coherence,
 * and ICP-fit scoring sanity.
 *
 * Run: `npm test`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { rmSync } from "node:fs";

import { loadConfig } from "../src/config/load.js";
import { emptyWorld, Ledger } from "../src/ledger/ledger.js";
import { World, type Artifact } from "../src/ledger/schema.js";
import { buildReps } from "../src/sales-team.js";
import { seedTrendsFromConfig, loadTrends } from "../src/trends.js";
import { advanceWorld, backfillTouchpoints } from "../src/generation/advance.js";
import { CohortIndex, COHORT_PATH, type Cohort } from "../src/cohort.js";
import { buildRequest } from "../src/generation/prompts.js";
import { ingestResults } from "../src/generation/ingest.js";
import { scoreIcp } from "../src/icp.js";
import { lint } from "../src/lint.js";
import { Rng } from "../src/util/rng.js";
import { repoPath, ensureDir, writeJson, readText, fileExists } from "../src/util/fs.js";
import type { Period } from "../src/clock.js";

const cfg = loadConfig();

// --- The reference CRM vocabulary — the fidelity oracle. Every value the
// generator emits for these fields MUST be a member of the matching set (kept
// in lockstep with the shipped config; the private deployment mirrors its CRM
// enums through the same sets).
const CRM_VOCAB = {
  SIZE: ["Enterprise", "Mid-market", "SMB"],
  REGION: ["NA", "EMEA", "APAC"],
  BUYING_ROLE: [
    "Champion",
    "Decision Maker",
    "Economic Buyer",
    "Technical Buyer",
    "User",
    "Influencer",
    "Blocker",
    "Sponsor",
  ],
  STAGE: ["Discovery", "Evaluation", "Proposal", "Negotiation", "Closed"],
  STATUS: ["open", "won", "lost"],
  LOSS_REASON: ["Price", "Missing feature", "Integrations", "Incumbent", "Brand/trust", "No decision"],
  PRICE_FEEDBACK: ["Less expensive", "On par", "More expensive"],
  PRODUCT_FEEDBACK: [
    "Integrations",
    "Security",
    "Analytics",
    "AI / Automation",
    "API",
    "Reporting",
    "Onboarding",
    "Support",
  ],
  TECH_STACK: [
    "Salesforce",
    "HubSpot",
    "Snowflake",
    "Segment",
    "Marketo",
    "Microsoft Dynamics",
    "Slack",
    "Tableau",
  ],
  TRIGGER: ["Recent funding", "Exec hire", "M&A", "Tech migration", "Expansion", "Restructuring"],
  EMPLOYEE_BAND: ["1-50", "51-200", "201-500", "501-2000", "2001-5000", "5000+"],
  REVENUE_BAND: ["<$10M", "$10-50M", "$50-250M", "$250M-1B", ">$1B"],
  FUNDING_STAGE: [
    "Bootstrapped",
    "Seed",
    "Series A",
    "Series B",
    "Series C",
    "Series D+",
    "Public",
    "PE-owned",
  ],
  COMPLEXITY: ["Low", "Medium", "High"],
};

function seededWorld(seed = "test-seed") {
  const w = emptyWorld(seed);
  w.reps = buildReps(cfg.salesTeam);
  return w;
}

const periods: Period[] = [
  { index: 1, start: "2025-06-23", end: "2025-06-30" },
  { index: 2, start: "2025-06-30", end: "2025-07-07" },
  { index: 3, start: "2025-07-07", end: "2025-07-14" },
];

/** A longer run so closed deals (with reasons/feedback) exist for assertions. */
/** An inactive cohort gate — every deal passes, nothing is Slack-suppressed. */
const EMPTY_COHORT: Cohort = { version: 1, targetSize: 0, members: [] };

function bigWorld(seed = "big-seed") {
  const w = seededWorld(seed);
  const trends = seedTrendsFromConfig(cfg, "2025-06-23");
  // These are STATISTICAL assertions (win-rate lifts, cohort sizes), so they need
  // a large sample regardless of the operator's current velocity setting. Pin the
  // volume here rather than inheriting config, which is a Tier-2 knob the operator
  // is free to retune — a demo-org policy change must not fail engine tests.
  trends.volume = { newOppsPerWeek: [6, 10], trendPerQuarter: 1 };
  const many: Period[] = [];
  let cursor = "2025-06-23";
  for (let i = 1; i <= 53; i++) {
    const end = new Date(Date.UTC(2025, 5, 23 + i * 7)).toISOString().slice(0, 10);
    many.push({ index: i, start: cursor, end });
    cursor = end;
  }
  advanceWorld(w, cfg, trends, "2025-06-23", many, new CohortIndex(EMPTY_COHORT));
  return w;
}

test("advanceWorld is deterministic (same seed → identical world)", () => {
  const a = seededWorld();
  const b = seededWorld();
  const trends = seedTrendsFromConfig(cfg, "2025-06-23");
  advanceWorld(a, cfg, trends, "2025-06-23", periods, new CohortIndex(EMPTY_COHORT));
  advanceWorld(b, cfg, trends, "2025-06-23", periods, new CohortIndex(EMPTY_COHORT));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.opportunities.length > 0, "should create opportunities");
});

test("advanceWorld produces a structurally coherent world (lint: 0 errors)", () => {
  const w = seededWorld();
  const trends = seedTrendsFromConfig(cfg, "2025-06-23");
  advanceWorld(w, cfg, trends, "2025-06-23", periods, new CohortIndex(EMPTY_COHORT));
  World.parse(w);
  const result = lint(w, cfg);
  assert.equal(result.errors, 0, JSON.stringify(result.findings.filter((f) => f.severity === "error")));
});

test("every emitted enum value is a member of the reference CRM vocab", () => {
  const w = bigWorld();
  assert.ok(w.opportunities.length > 50, `expected a sizeable pipeline, got ${w.opportunities.length}`);

  const subset = (vals: string[], set: string[], label: string) => {
    for (const v of vals) assert.ok(set.includes(v), `${label}: "${v}" not in reference CRM vocab`);
  };

  for (const a of w.accounts) {
    subset([a.size], CRM_VOCAB.SIZE, "account.size");
    subset([a.region], CRM_VOCAB.REGION, "account.region");
    subset([a.employeeBand], CRM_VOCAB.EMPLOYEE_BAND, "account.employeeBand");
    subset([a.revenueBand], CRM_VOCAB.REVENUE_BAND, "account.revenueBand");
    subset([a.fundingStage], CRM_VOCAB.FUNDING_STAGE, "account.fundingStage");
    subset(a.triggers, CRM_VOCAB.TRIGGER, "account.triggers");
    subset(a.techStack, CRM_VOCAB.TECH_STACK, "account.techStack");
    assert.ok(["Tier 1", "Tier 2", "Tier 3"].includes(a.icpTier));
    // industry intentionally uses the configured ICP sub-verticals (NOT generic
    // ACCOUNT_INDUSTRY_OPTIONS) — assert it matches the configured set instead.
    assert.ok(a.industry in cfg.world.segments.industries, `industry "${a.industry}" not in config`);
  }
  for (const c of w.contacts) subset([c.buyingRole], CRM_VOCAB.BUYING_ROLE, "contact.buyingRole");
  for (const o of w.opportunities) {
    subset([o.stage], CRM_VOCAB.STAGE, "opp.stage");
    subset([o.status], CRM_VOCAB.STATUS, "opp.status");
    subset([o.complexity], CRM_VOCAB.COMPLEXITY, "opp.complexity");
    if (o.winLossReason) subset([o.winLossReason], CRM_VOCAB.LOSS_REASON, "opp.winLossReason");
    if (o.priceFeedback) subset([o.priceFeedback], CRM_VOCAB.PRICE_FEEDBACK, "opp.priceFeedback");
    subset(o.productFeedback, CRM_VOCAB.PRODUCT_FEEDBACK, "opp.productFeedback");
    subset(o.techStackRequirements, CRM_VOCAB.TECH_STACK, "opp.techStackRequirements");
  }
});

test("firmographics are internally coherent (bands consistent with size)", () => {
  const w = bigWorld("coh-seed");
  // The size a real-account employee band maps back to (mirrors real-accounts.ts
  // sizeFor thresholds) — real accounts derive employees/size from the target
  // list, so their band need not sit in the synthetic by_size conditional table,
  // but it MUST still be coherent with the size class.
  const bandSize: Record<string, string> = {
    "1-50": "SMB",
    "51-200": "SMB",
    "201-500": "Mid-market",
    "501-2000": "Mid-market",
    "2001-5000": "Enterprise",
    "5000+": "Enterprise",
  };
  for (const a of w.accounts) {
    const bySize = cfg.world.segments.by_size[a.size]!;
    // revenueBand is always sampled from the size's conditional table (real and
    // synthetic alike) → strict membership holds for everyone.
    assert.ok(a.revenueBand in bySize.revenue_bands, `${a.size} bad revenueBand ${a.revenueBand}`);
    if (a.source) {
      // Real account: employee/funding come from real data — valid CRM enums
      // (guarded by the enum-vocab test) and coherent size↔band by ingestion.
      assert.equal(
        bandSize[a.employeeBand],
        a.size,
        `real ${a.name}: band ${a.employeeBand} incoherent with size ${a.size}`,
      );
    } else {
      // Synthetic account: strict membership in the size's conditional table.
      assert.ok(a.employeeBand in bySize.employee_bands, `${a.size} bad employeeBand ${a.employeeBand}`);
      assert.ok(a.fundingStage in bySize.funding_stages, `${a.size} bad fundingStage ${a.fundingStage}`);
    }
  }
});

test("wins carry no reason; lost deals always do", () => {
  const w = bigWorld("wl-seed");
  for (const o of w.opportunities) {
    if (o.status === "won") assert.equal(o.winLossReason, undefined, "won deal must not carry a reason");
    if (o.status === "lost") assert.ok(o.winLossReason, "lost deal must carry a reason");
  }
});

test("opportunity name is '<Account> - <Use Case>' (never the bare account name)", () => {
  const w = bigWorld("name-seed");
  const byAcct = new Map(w.accounts.map((a) => [a.id, a]));
  const known = new Set(cfg.useCases.use_cases.map((u) => u.name));
  for (const o of w.opportunities) {
    const acct = byAcct.get(o.accountId)!.name;
    assert.ok(o.useCase, `opp ${o.id} has no use case`);
    assert.ok(known.has(o.useCase!), `use case "${o.useCase}" is not in use-cases.yaml`);
    assert.equal(o.name, `${acct} - ${o.useCase}`, `opp name "${o.name}" is not "<Account> - <Use Case>"`);
    // A CRM where the deal is named after the account and nothing else tells you
    // nothing about the deal — that was the whole point of adding use cases.
    assert.notEqual(o.name, acct, `opp name must not be the bare account name`);
    const vendor = cfg.world.company.short_name ?? cfg.world.company.name;
    assert.ok(!o.name.includes(vendor), `opp name "${o.name}" must not contain a vendor suffix`);
  }
});

test("use case skews toward the competitor on the deal, without becoming a rule", () => {
  const w = bigWorld("usecase-seed");
  const share = (competitor: string, useCase: string) => {
    const deals = w.opportunities.filter((o) => o.competitors.includes(competitor));
    return deals.length ? deals.filter((o) => o.useCase === useCase).length / deals.length : 0;
  };
  // Derive the strongest configured skew: the use case whose top-weighted
  // competitor most exceeds its mean weight must over-represent that
  // competitor relative to one it does not favor.
  const allNames = cfg.competitors.competitors.map((c) => c.name);
  const skews = cfg.useCases.use_cases
    .map((uc) => {
      const entries = Object.entries(uc.competitor_weights);
      if (entries.length === 0) return null;
      const sorted = [...entries].sort((a, b) => b[1] - a[1]);
      const mean = entries.reduce((acc, [, v]) => acc + v, 0) / entries.length;
      const other = allNames.find((n) => !(n in uc.competitor_weights)) ?? sorted.at(-1)![0];
      return { uc: uc.name, top: sorted[0]![0], other, ratio: sorted[0]![1] / Math.max(mean, 1e-9) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null && x.top !== x.other)
    .sort((a, b) => b.ratio - a.ratio);
  assert.ok(skews.length > 0, "no use case declares a competitor skew to check");
  const { uc, top, other } = skews[0]!;
  assert.ok(
    share(top, uc) > share(other, uc),
    `${top} deals should skew to ${uc} more than ${other} deals do`,
  );
  // ...but a skew is not a rule: every use case must remain reachable, or we
  // hard-coded a pattern and would then credit the product with discovering it.
  for (const uc of cfg.useCases.use_cases) {
    assert.ok(
      w.opportunities.some((o) => o.useCase === uc.name),
      `no deal drew use case "${uc.name}" — the skew has collapsed into a rule`,
    );
  }
});

test("every opportunity carries at least one real competitor", () => {
  const w = bigWorld("comp-seed");
  const known = new Set(cfg.competitors.competitors.map((c) => c.name));
  for (const o of w.opportunities) {
    assert.ok(o.competitors.length >= 1, `opp ${o.id} has no competitor`);
    for (const c of o.competitors) assert.ok(known.has(c), `competitor "${c}" not in config`);
  }
});

test("lost deals carry an AE-believed loss reason (enum); some diverge from the actual", () => {
  const w = bigWorld("rep-loss-seed");
  const lost = w.opportunities.filter((o) => o.status === "lost");
  let diverged = 0;
  for (const o of lost) {
    assert.ok(o.repLossReason, "lost deal must carry an AE-believed reason");
    assert.ok(
      CRM_VOCAB.LOSS_REASON.includes(o.repLossReason!),
      `repLossReason "${o.repLossReason}" not a reference enum`,
    );
    if (o.repLossReason !== o.winLossReason) diverged++;
  }
  // Won deals never carry it.
  for (const o of w.opportunities.filter((o) => o.status === "won")) {
    assert.equal(o.repLossReason, undefined, "won deal must not carry an AE-believed reason");
  }
  assert.ok(
    diverged >= 1,
    "expected some AE-believed reasons to differ from the actual (belief-vs-reality gap)",
  );
});

test("pricing is fixed, round, and add-ons stay a small minority < $50K", () => {
  const w = bigWorld("price-seed");
  const pricingCfg = cfg.world.volume.pricing;
  const allowedBase = new Set([
    pricingCfg.professional.monthly,
    pricingCfg.professional.annual,
    pricingCfg.enterprise.monthly,
    pricingCfg.enterprise.annual,
  ]);
  let aboveBase = 0;
  for (const o of w.opportunities) {
    assert.ok(["professional", "enterprise"].includes(o.tier));
    assert.ok(["monthly", "annual"].includes(o.billingTerm));
    assert.equal(o.amount % 100, 0, `price ${o.amount} not a round number`);
    const priceCap =
      Math.max(
        cfg.world.volume.pricing.professional.annual,
        cfg.world.volume.pricing.enterprise.annual,
        cfg.world.volume.pricing.professional.monthly,
        cfg.world.volume.pricing.enterprise.monthly,
      ) + cfg.world.volume.pricing.addons.max_total_usd;
    assert.ok(o.amount <= priceCap, `price ${o.amount} exceeds base+addon cap ${priceCap}`);
    const tierPrice = cfg.world.volume.pricing[o.tier];
    const base = o.billingTerm === "annual" ? tierPrice.annual : tierPrice.monthly;
    if (o.amount > base) {
      aboveBase++;
      assert.equal(o.tier, "enterprise", "only Enterprise carries add-ons");
    } else {
      assert.ok(allowedBase.has(o.amount), `non-add-on price ${o.amount} not a base price`);
    }
  }
  assert.ok(
    aboveBase / w.opportunities.length <= 0.1,
    `>10% of deals above base (${aboveBase}/${w.opportunities.length})`,
  );
});

test("ICP scoring is monotonic: a core-ICP account beats an off-ICP one", () => {
  // Fixtures derived from the scorecard itself: the best-scoring value of
  // every dimension vs the worst — monotonicity must hold for ANY config.
  const levelsOf = (dim: string): [string, number][] => Object.entries(cfg.icp.dimensions[dim]?.levels ?? {});
  const best = (dim: string) => [...levelsOf(dim)].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const worst = (dim: string) => [...levelsOf(dim)].sort((a, b) => a[1] - b[1])[0]?.[0] ?? "";
  const ideal = scoreIcp(cfg.icp, {
    industry: best("industry"),
    size: best("size"),
    employeeBand: best("employee_band"),
    revenueBand: best("revenue_band"),
    fundingStage: best("funding_stage"),
    techStack: [best("tech_stack")].filter(Boolean),
    triggers: [best("triggers")].filter(Boolean),
  });
  const off = scoreIcp(cfg.icp, {
    industry: worst("industry"),
    size: worst("size"),
    employeeBand: worst("employee_band"),
    revenueBand: worst("revenue_band"),
    fundingStage: worst("funding_stage"),
    techStack: [],
    triggers: [],
  });
  assert.equal(ideal.tier, "Tier 1", `ideal scored ${ideal.score}`);
  assert.equal(off.tier, "Tier 3", `off scored ${off.score}`);
  assert.ok(ideal.inIcp && !off.inIcp);
});

test("in-ICP deals win at a meaningfully higher rate than out-of-ICP", () => {
  const w = bigWorld("lift-seed");
  const closed = w.opportunities.filter((o) => o.status !== "open");
  const byTier = (inIcp: boolean) => {
    const acc = new Map(w.accounts.map((a) => [a.id, a]));
    const deals = closed.filter((o) => (acc.get(o.accountId)!.icpTier !== "Tier 3") === inIcp);
    const won = deals.filter((o) => o.status === "won").length;
    return deals.length ? won / deals.length : 0;
  };
  assert.ok(
    byTier(true) > byTier(false) + 0.07,
    `expected in-ICP lift; in=${byTier(true).toFixed(2)} out=${byTier(false).toFixed(2)}`,
  );
});

test("sales team: managers own no deals; every owner is an IC; leaderboard has spread", () => {
  const w = bigWorld("sales-seed");
  const byId = new Map(w.reps.map((r) => [r.id, r]));
  const managers = w.reps.filter((r) => r.role === "manager");
  assert.equal(managers.length, cfg.salesTeam.managers.length);
  for (const m of managers) {
    assert.equal(
      w.opportunities.filter((o) => o.ownerRepId === m.id).length,
      0,
      `manager ${m.name} owns deals`,
    );
  }
  for (const o of w.opportunities) assert.equal(byId.get(o.ownerRepId)?.role, "ic", "owner must be an IC");

  // A real owner leaderboard spread (not noise). Threshold is modest because this
  // runs on baseline trends (no curated ramps/segment deltas); the live curated
  // world shows a wider gap (~0.19). The ordering (David > Lukas) is asserted next.
  const ics = w.reps.filter((r) => r.role === "ic");
  const rates = ics.map((ic) => {
    const ds = w.opportunities.filter((o) => o.ownerRepId === ic.id && o.status !== "open");
    return ds.length ? ds.filter((o) => o.status === "won").length / ds.length : 0;
  });
  assert.ok(
    Math.max(...rates) - Math.min(...rates) > 0.05,
    `expected leaderboard spread, got ${rates.map((r) => r.toFixed(2)).join(",")}`,
  );

  // The configured per-rep win_modifier must show up in the leaderboard: the
  // highest-modifier IC out-closes the lowest-modifier IC.
  const icCfg = [...cfg.salesTeam.ics].sort((a, b) => b.win_modifier - a.win_modifier);
  if (icCfg.length >= 2 && icCfg[0]!.win_modifier > icCfg.at(-1)!.win_modifier) {
    const wrOf = (name: string) => {
      const rep = w.reps.find((r) => r.name === name)!;
      const ds = w.opportunities.filter((o) => o.ownerRepId === rep.id && o.status !== "open");
      return ds.length ? ds.filter((o) => o.status === "won").length / ds.length : 0;
    };
    const top = icCfg[0]!.name;
    const bottom = icCfg.at(-1)!.name;
    assert.ok(
      wrOf(top) > wrOf(bottom),
      `${top} (modifier ${icCfg[0]!.win_modifier}) at ${wrOf(top).toFixed(2)} should beat ` +
        `${bottom} (modifier ${icCfg.at(-1)!.win_modifier}) at ${wrOf(bottom).toFixed(2)}`,
    );
  }
});

test("committed state/trends.json (when present) is valid and sane", () => {
  // A fresh clone has no state yet — nothing to validate until `npm run init`.
  if (!fileExists(repoPath("state", "trends.json"))) return;
  const trends = loadTrends();
  assert.ok(trends.volume.newOppsPerWeek[0]! >= 1, "expected a positive weekly deal volume");
  assert.ok(trends.volume.trendPerQuarter >= 0, "velocity must not ramp downward");
  // The MI trend block accompanies the config block when the cohort is used.
  if (cfg.world.market_intelligence) {
    assert.ok(trends.marketIntelligence, "expected the market-intelligence cohort trend block");
  }
});

test("market-intelligence cohort: no-PMM deals lose more; a non-PMM driver leads", () => {
  const mi = cfg.world.market_intelligence;
  if (!mi) return; // optional cohort not configured
  const w = bigWorld("mi-seed");
  const champRole = cfg.personas.champion_role;
  const byId = new Map(w.contacts.map((c) => [c.id, c]));
  const role = (id: string) => byId.get(id)!.buyingRole;
  const hasPmm = (o: (typeof w.opportunities)[number]) => o.contactIds.some((id) => role(id) === champRole);
  const decided = w.opportunities.filter((o) => o.status !== "open");
  const wr = (ds: typeof decided) =>
    ds.length ? ds.filter((o) => o.status === "won").length / ds.length : 0;

  const withPmm = decided.filter(hasPmm);
  const noPmm = decided.filter((o) => !hasPmm(o));
  assert.ok(noPmm.length >= 5, `expected a no-PMM cohort, got ${noPmm.length}`);
  assert.ok(
    wr(withPmm) > wr(noPmm) + 0.1,
    `expected PMM-present lift; with=${wr(withPmm).toFixed(2)} without=${wr(noPmm).toFixed(2)}`,
  );

  // No-PMM deals are the MI cohort: a non-PMM driver is primary, the MI competitor competes,
  // and there is genuinely NO product-marketing persona in the buying group.
  const acc = new Map(w.accounts.map((a) => [a.id, a]));
  for (const o of noPmm) {
    const primaryRole = role(o.primaryContactId!);
    assert.notEqual(primaryRole, champRole, "no-PMM primary must not be the PMM champion");
    assert.ok(mi.driver_roles.includes(primaryRole), `primary role ${primaryRole} should be a driver role`);
    assert.equal(
      acc.get(o.accountId)!.size,
      "Enterprise",
      "MI cohort accounts are Enterprise (bigger companies)",
    );
  }
  // The cohort is contested by its configured dominant competitor, by construction.
  const miCompShare = noPmm.filter((o) => o.competitors.includes(mi.competitor)).length / noPmm.length;
  assert.ok(
    miCompShare > 0.8,
    `expected most no-PMM deals to face ${mi.competitor}, got ${(miCompShare * 100).toFixed(0)}%`,
  );

  // Recorded loss reasons stay within the configured enum (the persona signal is NOT a reason).
  for (const o of noPmm.filter((o) => o.status === "lost")) {
    assert.ok(
      CRM_VOCAB.LOSS_REASON.includes(o.winLossReason!),
      `loss reason "${o.winLossReason}" must be a configured enum value`,
    );
  }

  // The MI driver persona never leaks into normal PMM-led deals.
  for (const o of withPmm) {
    assert.ok(
      !o.contactIds.some((id) => role(id) === mi.primary_role),
      "MI driver should not appear in PMM-led deals",
    );
  }
});

test("linter flags a closed deal whose win-loss prose omits the competitor", () => {
  const w = emptyWorld("lint-test");
  w.reps = [
    {
      id: "rep-003",
      name: "Maya Okonkwo",
      email: "m@vendor.example",
      region: "NA",
      role: "ic",
      managerId: "rep-001",
      external: {},
    },
  ];
  w.accounts = [
    {
      id: "acc-001",
      name: "Acme",
      domain: "acme.com",
      industry: "Cybersecurity",
      size: "Enterprise",
      employeeBand: "2001-5000",
      revenueBand: "$250M-1B",
      fundingStage: "Series D+",
      region: "NA",
      triggers: ["Recent funding"],
      techStack: ["Salesforce"],
      icpScore: 85,
      icpTier: "Tier 1",
      external: {},
    },
  ];
  w.contacts = [
    {
      id: "con-001",
      accountId: "acc-001",
      name: "Jo Buyer",
      title: "CMO",
      buyingRole: "Economic Buyer",
      email: "jo@acme.com",
      external: {},
    },
  ];
  const competitor = cfg.competitors.competitors[0]!.name;
  w.opportunities = [
    {
      id: "opp-001",
      name: "Acme — Vendor",
      accountId: "acc-001",
      ownerRepId: "rep-003",
      amount: 24000,
      tier: "enterprise",
      billingTerm: "monthly",
      stage: "Closed",
      status: "lost",
      complexity: "High",
      createdDate: "2025-06-23",
      closeDate: "2025-07-14",
      stageHistory: [],
      competitors: [competitor],
      winLossReason: "Price",
      priceFeedback: "More expensive",
      productFeedback: [],
      techStackRequirements: ["Salesforce"],
      winLossMode: "survey",
      contactIds: ["con-001"],
      primaryContactId: "con-001",
      external: {},
    },
  ];
  w.artifacts = [
    {
      id: "art-001",
      kind: "survey",
      dealId: "opp-001",
      title: "Acme — win-loss survey",
      detailLevel: "low",
      date: "2025-07-14",
      grounding: {},
      status: "generated",
      messages: [{ personaHandle: "x", personaDisplay: "X", text: "We chose another vendor on Price." }],
      external: {},
    },
  ];

  const result = lint(w, cfg);
  assert.ok(
    result.findings.some((f) => f.severity === "error" && f.message.includes(competitor)),
    "expected an error about the missing competitor name",
  );
});

/** A minimal world with one closed-lost deal carrying a competitor. */
function oneDealWorld(): World {
  const competitor = cfg.competitors.competitors[0]!.name;
  const w = emptyWorld("touchpoint-seed");
  w.reps = [
    {
      id: "rep-003",
      name: "Maya Okonkwo",
      email: "maya@vendor.example",
      region: "NA",
      role: "ic",
      managerId: "rep-001",
      external: {},
    },
  ];
  w.accounts = [
    {
      id: "acc-001",
      name: "Acme",
      domain: "acme.com",
      industry: "Cybersecurity",
      size: "Enterprise",
      employeeBand: "2001-5000",
      revenueBand: "$250M-1B",
      fundingStage: "Series D+",
      region: "NA",
      triggers: ["Recent funding"],
      techStack: ["Salesforce"],
      icpScore: 85,
      icpTier: "Tier 1",
      external: {},
    },
  ];
  w.contacts = [
    {
      id: "con-001",
      accountId: "acc-001",
      name: "Jo Buyer",
      title: "CMO",
      buyingRole: "Economic Buyer",
      email: "jo@acme.com",
      external: {},
    },
  ];
  w.opportunities = [
    {
      id: "opp-001",
      name: "Acme",
      accountId: "acc-001",
      ownerRepId: "rep-003",
      amount: 24000,
      tier: "enterprise",
      billingTerm: "monthly",
      stage: "Closed",
      status: "lost",
      complexity: "High",
      createdDate: "2025-06-23",
      closeDate: "2025-07-21",
      stageHistory: [],
      competitors: [competitor],
      winLossReason: "Price",
      repLossReason: "Price",
      priceFeedback: "More expensive",
      productFeedback: [],
      techStackRequirements: ["Salesforce"],
      winLossMode: "survey",
      contactIds: ["con-001"],
      primaryContactId: "con-001",
      external: {},
    },
  ];
  return w;
}

test("backfillTouchpoints plants a full, leak-safe touch-point set on a closed deal", () => {
  const w = oneDealWorld();
  // Empty cohort = inactive gate, so the FULL set is planted. Passed explicitly
  // so the test never depends on whatever state/cohort.json currently holds.
  const { plannedArtifactIds } = backfillTouchpoints(
    w,
    cfg,
    "opp-001",
    "2025-08-01",
    new CohortIndex(EMPTY_COHORT),
  );
  assert.ok(plannedArtifactIds.length > 0, "should plan artifacts");
  const arts = w.artifacts.filter((a) => a.dealId === "opp-001");
  const kinds = new Set(arts.map((a) => a.kind));
  for (const k of ["call_transcript", "ae_note", "email_exchange", "slack_deal_thread"]) {
    assert.ok(kinds.has(k as Artifact["kind"]), `expected a ${k}`);
  }
  assert.ok(
    arts.some((a) => ["survey", "interview", "winloss_post"].includes(a.kind)),
    "expected a win-loss artifact on close",
  );

  // Leak-safety: Discovery-stage artifacts must reflect the open world, not the loss.
  const discovery = arts.filter((a) => a.grounding.stage === "Discovery");
  assert.ok(discovery.length > 0, "expected Discovery-stage artifacts");
  for (const a of discovery) {
    assert.equal(a.grounding.outcome, "open", `early ${a.kind} leaked the outcome`);
    assert.equal(a.grounding.winLossReason, undefined, `early ${a.kind} leaked the loss reason`);
  }
  // The closing AE note legitimately carries the recorded outcome.
  const closeNote = arts.find((a) => a.kind === "ae_note" && a.title.includes("close"));
  assert.ok(closeNote, "expected a close AE note");
  assert.equal(closeNote!.grounding.outcome, "lost");

  // Idempotent at deal granularity: a second backfill plans nothing more.
  const second = backfillTouchpoints(w, cfg, "opp-001", "2025-08-01", new CohortIndex(EMPTY_COHORT));
  assert.equal(second.plannedArtifactIds.length, 0, "re-backfill should be a no-op");
});

test("advanceWorld reports cohort enrollment but never writes state/cohort.json", () => {
  // Regression guard. advanceWorld used to persist enrollment itself, so running
  // the test suite — which advances dozens of synthetic worlds whose opp ids
  // collide with real ones — silently enrolled hundreds of phantom deals into
  // the operator's live cohort file.
  const before = fileExists(COHORT_PATH) ? readText(COHORT_PATH) : null;
  const w = seededWorld("enroll-seed");
  const trends = seedTrendsFromConfig(cfg, "2025-06-23");
  const result = advanceWorld(w, cfg, trends, "2025-06-23", periods, new CohortIndex(EMPTY_COHORT));

  assert.ok(result.enrolled.length > 0, "new deals should be reported for enrollment");
  assert.equal(result.enrolled.length, w.opportunities.length, "every new deal is reported once");
  for (const e of result.enrolled) assert.equal(e.source, "weekly", "live-run deals join as weekly members");

  const after = fileExists(COHORT_PATH) ? readText(COHORT_PATH) : null;
  assert.equal(after, before, "advanceWorld must not touch state/cohort.json");
});

test("seed cohort members are planted with no Slack artifacts at all", () => {
  const w = oneDealWorld();
  const seedCohort = new CohortIndex({
    version: 1,
    targetSize: 1,
    members: [{ oppId: "opp-001", accountName: "Test", source: "seed", addedOn: "2026-08-12" }],
  });
  backfillTouchpoints(w, cfg, "opp-001", "2025-08-01", seedCohort);
  const arts = w.artifacts.filter((a) => a.dealId === "opp-001");
  const kinds = new Set(arts.map((a) => a.kind));

  // Suppressed at PLANTING time, not merely at push time — otherwise the agent
  // spends tokens writing prose for a destination it can never reach.
  for (const k of ["slack_deal_thread", "competitive_q", "winloss_post"]) {
    assert.ok(!kinds.has(k as Artifact["kind"]), `seed member must not be planted a ${k}`);
  }
  // The deal still gets its real detail layer.
  assert.ok(kinds.has("call_transcript"), "expected transcripts");
  assert.ok(kinds.has("email_exchange"), "expected email threads");
});

test("a weekly cohort member still gets the full Slack layer", () => {
  const w = oneDealWorld();
  const weeklyCohort = new CohortIndex({
    version: 1,
    targetSize: 1,
    members: [{ oppId: "opp-001", accountName: "Test", source: "weekly", addedOn: "2026-08-12" }],
  });
  backfillTouchpoints(w, cfg, "opp-001", "2025-08-01", weeklyCohort);
  const kinds = new Set(w.artifacts.filter((a) => a.dealId === "opp-001").map((a) => a.kind));
  assert.ok(kinds.has("slack_deal_thread"), "weekly members keep their #deals thread");
});

test("linter only warns (not errors) when an early-stage artifact omits the competitor", () => {
  const w = oneDealWorld();
  const competitor = w.opportunities[0]!.competitors[0]!;
  w.artifacts.push({
    id: "art-early",
    kind: "email_exchange",
    dealId: "opp-001",
    title: "Acme — email thread (Discovery)",
    detailLevel: "medium",
    date: "2025-06-30",
    grounding: { stage: "Discovery", outcome: "open" },
    status: "generated",
    emails: [
      {
        from: "Maya <maya@vendor.example>",
        to: ["jo@acme.com"],
        subject: "Intro",
        body: "No rival named here.",
        date: "2025-06-30",
      },
    ],
    external: {},
  });
  const result = lint(w, cfg);
  assert.ok(
    !result.findings.some((f) => f.severity === "error" && f.artifact === "art-early"),
    "early-stage miss must not be an error",
  );
  assert.ok(
    result.findings.some(
      (f) => f.severity === "warn" && f.artifact === "art-early" && f.message.includes(competitor),
    ),
    "expected a warning about the missing competitor",
  );
});

test("ingest resolves an email thread's contactRef to a real contact id", () => {
  const w = oneDealWorld();
  w.artifacts.push({
    id: "art-eml",
    kind: "email_exchange",
    dealId: "opp-001",
    title: "Acme — email thread (Discovery)",
    detailLevel: "medium",
    date: "2025-06-30",
    grounding: { stage: "Discovery", outcome: "open" },
    status: "planned",
    external: {},
  });
  const ctx = { config: cfg, ledger: new Ledger(w), seed: w.seed };
  const req = buildRequest(ctx, w.artifacts.at(-1)!);
  const periodIndex = 990001;
  const dir = repoPath("state", "requests", String(periodIndex), "results");
  ensureDir(dir);
  writeJson(repoPath(dir, "art-eml.json"), {
    emails: [
      {
        from: "Maya <maya@vendor.example>",
        to: ["jo@acme.com"],
        subject: "Intro",
        body: "Hi Jo",
        date: "2025-06-30",
        contactRef: "jo@acme.com",
      },
    ],
  });
  try {
    const report = ingestResults(w, cfg, periodIndex, [req]);
    assert.ok(report.filled.includes("art-eml"), `expected art-eml to ingest: ${JSON.stringify(report)}`);
    const art = w.artifacts.find((a) => a.id === "art-eml")!;
    assert.equal(
      art.emails?.[0]?.contactId,
      "con-001",
      "contactRef should resolve to the buying-group contact",
    );
  } finally {
    rmSync(repoPath("state", "requests", String(periodIndex)), { recursive: true, force: true });
  }
});

test("Rng is seed-stable and weighted() respects weights", () => {
  const r1 = new Rng("abc");
  const r2 = new Rng("abc");
  assert.equal(r1.int(0, 1_000_000), r2.int(0, 1_000_000));

  const rng = new Rng("weights");
  let dominant = 0;
  for (let i = 0; i < 200; i++) if (rng.weighted({ a: 99, b: 1 }) === "a") dominant++;
  assert.ok(dominant > 180, `expected ~99% 'a', got ${dominant}/200`);
});
