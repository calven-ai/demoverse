/**
 * Deal sampling: accounts, buying groups, tiers, amounts, competitors. Split
 * from advance.ts; pure functions over config + seeded Rng (see advance.ts for
 * the determinism contract).
 */

import { Rng } from "../util/rng.js";
import type { Config, PersonasConfig } from "../config/schema.js";
import type { EffectiveParams } from "../trends.js";
import { nextId } from "../ledger/ledger.js";
import type { Account, Contact, Opportunity, World } from "../ledger/schema.js";
import { scoreIcp } from "../icp.js";
import { makeCompanyName, makePersonName, emailFor, demoEmailDomain } from "./names.js";
import type { RealAccountPool } from "./real-accounts.js";

/** Assign a deal to an IC (Account Executive) in-region; managers own none. */
export function pickRep(world: World, rng: Rng, region: string): string {
  const ics = world.reps.filter((r) => r.role === "ic");
  const inRegion = ics.filter((r) => r.region === region);
  const pool = inRegion.length > 0 ? inRegion : ics;
  return rng.pick(pool).id;
}

/** Independent Bernoulli inclusion per key, for tech_stack[] / triggers[]. */
export function bernoulliSet(dist: Record<string, number>, rng: Rng): string[] {
  const out: string[] = [];
  for (const [k, p] of Object.entries(dist)) if (rng.chance(p)) out.push(k);
  return out;
}

export function sampleCompetitors(cfg: Config, rng: Rng, eff: EffectiveParams, isMI = false): string[] {
  const weights: Record<string, number> = {};
  for (const c of cfg.competitors.competitors) weights[c.name] = eff.competitorPresence[c.name] ?? c.strength;

  // Market-intelligence cohort deals are contested by the configured MI competitor.
  // That competitor dominates the cohort (config market_intelligence.competitor).
  const mi = cfg.world.market_intelligence;
  if (isMI && mi) {
    const competitors = [mi.competitor];
    if (rng.chance(0.25)) {
      const second = rng.weighted(weights);
      if (second !== mi.competitor) competitors.push(second);
    }
    return competitors;
  }

  if (!rng.chance(cfg.world.winloss.competitor_present_rate)) return [];
  // Weight competitor presence by the current (trend-adjusted) presence.
  const first = rng.weighted(weights);
  const competitors = [first];
  // ~30% of contested deals have a second competitor.
  if (rng.chance(0.3)) {
    const second = rng.weighted(weights);
    if (second !== first) competitors.push(second);
  }
  return competitors;
}

/**
 * Sample a coherent account. When a real-account `pool` yields a company, its
 * name/domain/industry/size/employee-band/region are taken from the real target
 * list and the remaining firmographics (revenue, and funding when the list did
 * not carry it) are sampled coherently from that size's bands. When the pool is
 * disabled or its bucket is exhausted, we fall back to the synthetic name banks
 * (identical rng order to the pre-real-accounts engine, so old worlds still
 * replay). Market-intelligence cohort accounts (`cohort === "mi"`) prefer a
 * genuinely large real vendor, else are forced to the Enterprise firmographic
 * skew, the "bigger / different ICP" read (world.yaml market_intelligence).
 */
export function makeAccount(
  world: World,
  cfg: Config,
  eff: EffectiveParams,
  rng: Rng,
  pool: RealAccountPool,
  cohort?: "mi",
): Account {
  const industryDraw = rng.weighted(eff.industryWeights);
  const mi = cfg.world.market_intelligence;
  const real = pool.pick(rng, { industry: industryDraw, large: cohort === "mi" });

  let name: string, domain: string, industry: string, size: string;
  let employeeBand: string, revenueBand: string, fundingStage: string, region: string;
  const source = real?.sourceVertical;

  if (real) {
    industry = real.industry;
    size = real.size;
    employeeBand = real.employeeBand;
    region = real.region;
    const bands = cfg.world.segments.by_size[size] ?? cfg.world.segments.by_size["Mid-market"]!;
    revenueBand = rng.weighted(bands.revenue_bands);
    fundingStage = real.fundingStage ?? rng.weighted(bands.funding_stages);
    name = real.name;
    domain = real.domain;
  } else {
    industry = industryDraw;
    size = cohort === "mi" && mi ? "Enterprise" : rng.weighted(cfg.world.segments.sizes);
    const bands = cohort === "mi" && mi ? mi.firmographics : cfg.world.segments.by_size[size];
    if (!bands) throw new Error(`world.yaml segments.by_size missing entry for size "${size}"`);
    employeeBand = rng.weighted(bands.employee_bands);
    revenueBand = rng.weighted(bands.revenue_bands);
    fundingStage = rng.weighted(bands.funding_stages);
    region = rng.weighted(cfg.world.segments.regions);
    ({ name, domain } = makeCompanyName(rng, industry));
  }

  const techStack = bernoulliSet(cfg.world.segments.tech_stack, rng);
  const triggers = bernoulliSet(cfg.world.segments.triggers, rng);

  const fit = scoreIcp(cfg.icp, {
    industry,
    size,
    employeeBand,
    revenueBand,
    fundingStage,
    techStack,
    triggers,
  });
  return {
    id: nextId(world.accounts, "acc"),
    name,
    domain,
    industry,
    size,
    employeeBand,
    revenueBand,
    fundingStage,
    region,
    ...(source ? { source } : {}),
    triggers,
    techStack,
    icpScore: fit.score,
    icpTier: fit.tier,
    external: {},
  };
}

/** Build the buying group from personas.yaml; Enterprise deals multi-thread more. */
export function makeBuyingGroup(
  world: World,
  cfg: Config,
  rng: Rng,
  account: Account,
  tier: Opportunity["tier"],
  opts?: { pmmAbsent?: boolean },
): { contacts: Contact[]; primaryId: string } {
  const contacts: Contact[] = [];
  let primaryId = "";

  const makeContact = (persona: PersonasConfig["personas"][number]): Contact => {
    // Redraw on a name collision within the same account. Identical name+email
    // pairs read as data errors and trip Salesforce's contact duplicate rule.
    const taken = new Set(
      [...world.contacts.filter((c) => c.accountId === account.id), ...contacts].map((c) => c.name),
    );
    let person = makePersonName(rng);
    for (let i = 0; i < 5 && taken.has(person.full); i++) person = makePersonName(rng);
    return {
      id: nextId([...world.contacts, ...contacts], "con"),
      accountId: account.id,
      name: person.full,
      title: rng.pick(persona.titles),
      buyingRole: persona.role as Contact["buyingRole"],
      seniority: persona.seniority,
      email: emailFor(person.full, demoEmailDomain(account.domain, cfg.world.company.synthetic_email_domain)),
      external: {},
    };
  };

  // Market-intelligence, no-PMM motion: a non-PMM persona drives, and NO product
  // marketing role is in the room. The recorded buying group is what lets the product
  // surface "deals without a PMM persona lose more" (DESIGN §16; we never state
  // it, only the raw contacts).
  const mi = cfg.world.market_intelligence;
  if (opts?.pmmAbsent && mi) {
    const allowed = new Set(mi.driver_roles);
    const driverPersonas = cfg.personas.personas.filter((p) => allowed.has(p.role));
    const ordered = [...driverPersonas].sort((a, b) =>
      a.role === mi.primary_role ? -1 : b.role === mi.primary_role ? 1 : 0,
    );
    for (const persona of ordered) {
      const isPrimary = persona.role === mi.primary_role;
      // The primary driver is always present; other non-PMM roles are sampled
      // (Enterprise → more multi-threading), with a floor so thin groups still form.
      const p = isPrimary ? 1 : Math.max(0, Math.min(1, Math.max(persona.presence, 0.3) * 1.25));
      if (!isPrimary && !rng.chance(p)) continue;
      const contact = makeContact(persona);
      contacts.push(contact);
      if (isPrimary) primaryId = contact.id;
    }
    if (!primaryId && contacts.length > 0) primaryId = contacts[0]!.id;
    return { contacts, primaryId };
  }

  const sorted = orderChampionFirst(cfg.personas);
  for (const persona of sorted) {
    const isChampion = persona.role === cfg.personas.champion_role;
    // Scale non-champion presence by tier → Enterprise deals pull in more roles.
    const p = isChampion
      ? 1
      : Math.max(0, Math.min(1, persona.presence * (tier === "enterprise" ? 1.25 : 0.7)));
    if (!isChampion && !rng.chance(p)) continue;
    const contact = makeContact(persona);
    contacts.push(contact);
    if (isChampion) primaryId = contact.id;
  }
  if (!primaryId && contacts.length > 0) primaryId = contacts[0]!.id;
  return { contacts, primaryId };
}

export function orderChampionFirst(p: PersonasConfig): PersonasConfig["personas"] {
  return [...p.personas].sort((a, b) =>
    a.role === p.champion_role ? -1 : b.role === p.champion_role ? 1 : 0,
  );
}

export function pickTier(cfg: Config, rng: Rng, size: string): Opportunity["tier"] {
  const mix = cfg.world.volume.pricing.tier_by_size[size] ?? { enterprise: 0.5, professional: 0.5 };
  return rng.weighted(mix) as Opportunity["tier"];
}

/** Fixed price from tier + billing term, plus the rare Enterprise add-on. */
export function dealAmount(
  cfg: Config,
  rng: Rng,
  tier: Opportunity["tier"],
  billingTerm: Opportunity["billingTerm"],
): number {
  const p = cfg.world.volume.pricing;
  const base = p[tier][billingTerm];
  // Only a small minority of Enterprise deals carry round-number add-ons.
  if (tier === "enterprise" && rng.chance(p.addons.enterprise_rate)) {
    const addon = rng.pick(p.addons.increments_usd);
    return Math.min(base + addon, p.addons.max_total_usd);
  }
  return base;
}

export function pickComplexity(rng: Rng, tier: Opportunity["tier"], size: string): string {
  const enterprise = tier === "enterprise" || size === "Enterprise";
  const weights: Record<string, number> = enterprise
    ? { High: 0.45, Medium: 0.4, Low: 0.15 }
    : { High: 0.15, Medium: 0.45, Low: 0.4 };
  return rng.weighted(weights);
}
