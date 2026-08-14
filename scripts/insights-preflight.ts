/**
 * Insight pre-flight is the Batch-1 review tool. See the plan, Part C.
 *
 * Reads the generated ledger (state/world.json) and runs the SAME aggregations
 * the downstream product's dashboards (ICP / Win-Loss / CI / Persona) compute as Postgres
 * GROUP BYs. Before any external push we can SEE that the structured CRM
 * data will produce meaningful, on-brand charts (not noise). It also checks each
 * planted "hero story" is statistically visible, and exports the pipeline to CSV
 * for eyeballing.
 *
 *   npm run preflight
 *
 * Output: a console report + state/preflight/{report.md,accounts.csv,
 * opportunities.csv,contacts.csv}.
 */

import { loadConfig } from "../src/config/load.js";
import { loadWorld, Ledger } from "../src/ledger/ledger.js";
import { loadTrends } from "../src/trends.js";
import { loadClock } from "../src/clock.js";
import { writeText, ensureDir, repoPath } from "../src/util/fs.js";
import { daysBetween, addDays } from "../src/util/date.js";
import type { Account, Opportunity, World } from "../src/ledger/schema.js";

type Opp = Opportunity;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const wr = (ds: Opp[]) => (ds.length ? ds.filter((o) => o.status === "won").length / ds.length : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const month = (iso?: string) => (iso ? iso.slice(0, 7) : "");

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    (m.get(k) ?? m.set(k, []).get(k)!).push(it);
  }
  return m;
}

interface Ctx {
  world: World;
  ledger: Ledger;
  acct: (o: Opp) => Account;
  decided: Opp[];
  /** The product-marketing anchor role (personas.yaml champion_role). */
  championRole: string;
  /** Dominant competitor in the market-intelligence cohort (or undefined). */
  miCompetitor?: string;
  /** Colloquial vendor name (world.yaml company.short_name). */
  companyShort: string;
  /** [start, simNow] of the simulated window (state/clock.json). */
  windowStart: string;
  windowEnd: string;
  /**
   * The competitor whose trends.json entry carries a strength bump, with the
   * bump's date window. This is the "toughens then recovers" story, when planted.
   */
  bumpedCompetitor?: { name: string; from: string; to: string };
  /** Industry with positive weight drift in trends.json. The emerging-segment story. */
  emergingIndustry?: string;
  /** Competitor whose config lists "Price" among its typical loss reasons. */
  priceCompetitor?: string;
  out: string[]; // report lines
}

/** Whether a deal has a product-marketing (champion-role) persona in its group. */
function hasPmm(ctx: Ctx, o: Opp): boolean {
  return o.contactIds.some((id) => ctx.ledger.contact(id).buyingRole === ctx.championRole);
}

function line(ctx: Ctx, s = ""): void {
  ctx.out.push(s);
  console.log(s);
}

function section(ctx: Ctx, title: string): void {
  line(ctx);
  line(ctx, `## ${title}`);
}

// --- dashboard-mirroring sections -------------------------------------------

function summary(ctx: Ctx): void {
  const { world, decided } = ctx;
  const won = decided.filter((o) => o.status === "won").length;
  section(ctx, "Pipeline summary");
  line(
    ctx,
    `Accounts: ${world.accounts.length} · Contacts: ${world.contacts.length} · Opportunities: ${world.opportunities.length}`,
  );
  line(
    ctx,
    `Open: ${world.opportunities.filter((o) => o.status === "open").length} · Decided: ${decided.length} (won ${won} / lost ${decided.length - won})`,
  );
  line(ctx, `Overall win rate (decided): ${pct(wr(decided))}`);
}

function icpSection(ctx: Ctx): void {
  const { decided, acct } = ctx;
  section(ctx, "ICP dashboard (in-ICP vs out-of-ICP)");
  const inIcp = decided.filter((o) => acct(o).icpTier !== "Tier 3");
  const out = decided.filter((o) => acct(o).icpTier === "Tier 3");
  const cyc = (ds: Opp[]) =>
    mean(ds.filter((o) => o.closeDate).map((o) => daysBetween(o.createdDate, o.closeDate!)));
  line(
    ctx,
    `In-ICP (Tier 1/2): ${inIcp.length} decided (${pct(inIcp.length / decided.length)} of pipeline) · close rate ${pct(wr(inIcp))} · avg ACV ${usd(mean(inIcp.map((o) => o.amount)))} · avg cycle ${cyc(inIcp).toFixed(0)}d`,
  );
  line(
    ctx,
    `Out-of-ICP (Tier 3):  ${out.length} decided (${pct(out.length / decided.length)} of pipeline) · close rate ${pct(wr(out))} · avg ACV ${usd(mean(out.map((o) => o.amount)))} · avg cycle ${cyc(out).toFixed(0)}d`,
  );
  line(ctx, `→ in-ICP close-rate lift: ${pct(wr(inIcp) - wr(out))}`);

  // Fit-score band distribution (FitScoreDistribution widget).
  const bands = { "Poor 0-25": 0, "Fair 26-50": 0, "Strong 51-75": 0, "Ideal 76-100": 0 };
  for (const a of ctx.world.accounts) {
    const s = a.icpScore;
    if (s <= 25) bands["Poor 0-25"]++;
    else if (s <= 50) bands["Fair 26-50"]++;
    else if (s <= 75) bands["Strong 51-75"]++;
    else bands["Ideal 76-100"]++;
  }
  line(
    ctx,
    `Fit-score bands (accounts): ${Object.entries(bands)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ")}`,
  );

  // Win rate by industry / size / region (WinRateByAttribute).
  for (const [label, key] of [
    ["industry", (a: Account) => a.industry],
    ["size", (a: Account) => a.size],
    ["region", (a: Account) => a.region],
  ] as const) {
    line(ctx, `By ${label}:`);
    const g = groupBy(decided, (o) => key(acct(o)));
    for (const [k, ds] of [...g.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const tierTag = label === "industry" ? ` ${avgTierTag(ds, acct)}` : "";
      line(
        ctx,
        `   ${k.padEnd(18)} win ${pct(wr(ds)).padStart(6)}  n=${String(ds.length).padStart(3)}  avgACV ${usd(mean(ds.map((o) => o.amount)))}${tierTag}`,
      );
    }
  }
}

/** Tag a segment in/out of ICP by majority tier (for the emerging-segment read). */
function avgTierTag(ds: Opp[], acct: (o: Opp) => Account): string {
  const outShare = ds.filter((o) => acct(o).icpTier === "Tier 3").length / ds.length;
  return outShare > 0.5 ? "(mostly OUT-of-ICP)" : "";
}

function pricingSection(ctx: Ctx): void {
  const { world } = ctx;
  section(ctx, "Pricing (fixed self-service tiers)");
  const byTierTerm = groupBy(world.opportunities, (o) => `${o.tier}/${o.billingTerm}`);
  for (const k of [
    "professional/monthly",
    "professional/annual",
    "enterprise/monthly",
    "enterprise/annual",
  ]) {
    const ds = byTierTerm.get(k) ?? [];
    const amounts = [...new Set(ds.map((o) => o.amount))].sort((a, b) => a - b);
    line(
      ctx,
      `   ${k.padEnd(22)} n=${String(ds.length).padStart(3)}  amounts: ${amounts.map(usd).join(", ")}`,
    );
  }
  const entBase = { monthly: 24000, annual: 20000 };
  const aboveBase = world.opportunities.filter((o) => o.amount > entBase[o.billingTerm]);
  line(
    ctx,
    `Deals above the Enterprise base price (add-ons): ${aboveBase.length} (${pct(aboveBase.length / world.opportunities.length)}, target ≤10%)`,
  );
  const distinct = [...new Set(world.opportunities.map((o) => o.amount))].sort((a, b) => a - b);
  line(ctx, `Distinct prices in use: ${distinct.map(usd).join(", ")}`);
}

function competitiveSection(ctx: Ctx): void {
  const { decided } = ctx;
  section(ctx, "Competitive Intelligence dashboard");
  const contested = decided.filter((o) => o.competitors.length > 0);
  line(
    ctx,
    `Contested deals: ${contested.length} (${pct(contested.length / decided.length)}) · competitive win rate ${pct(wr(contested))}`,
  );
  line(ctx, `Leaderboard per competitor ("win" = ${ctx.companyShort} wins the deal):`);
  const names = new Set(ctx.world.opportunities.flatMap((o) => o.competitors));
  for (const name of [...names].sort()) {
    const ds = decided.filter((o) => o.competitors.includes(name));
    const revenue = ds.filter((o) => o.status === "won").reduce((s, o) => s + o.amount, 0);
    line(
      ctx,
      `   ${name.padEnd(12)} deals=${String(ds.length).padStart(3)}  ourWin ${pct(wr(ds)).padStart(6)}  wonRev ${usd(revenue)}`,
    );
  }
  // Loss reasons (LossReasonsChart).
  const lost = decided.filter((o) => o.status === "lost");
  const reasons = groupBy(lost, (o) => o.winLossReason ?? "(none)");
  line(
    ctx,
    `Loss reasons: ${[...reasons.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, v]) => `${k}=${v.length}`)
      .join("  ")}`,
  );
  // Pricing positioning (PricingPositioningChart).
  const price = groupBy(
    decided.filter((o) => o.priceFeedback),
    (o) => o.priceFeedback!,
  );
  line(
    ctx,
    `Pricing positioning: ${["Less expensive", "On par", "More expensive"].map((k) => `${k}=${price.get(k)?.length ?? 0}`).join("  ")}`,
  );
}

function personaSection(ctx: Ctx): void {
  const { decided } = ctx;
  section(ctx, "Persona dashboard (multi-threading)");
  const single = decided.filter((o) => o.contactIds.length <= 1);
  const multi = decided.filter((o) => o.contactIds.length >= 3);
  line(ctx, `Single-threaded (≤1 contact): n=${single.length}  win ${pct(wr(single))}`);
  line(ctx, `Multi-threaded (3+ contacts): n=${multi.length}  win ${pct(wr(multi))}`);
  line(ctx, `→ multi-threading win lift: ${pct(wr(multi) - wr(single))}`);
  // Win rate by buying-group role present (WinRateByPersona).
  const roles = new Set(ctx.world.contacts.map((c) => c.buyingRole));
  line(ctx, `Win rate when a role is in the buying group:`);
  for (const role of [...roles].sort()) {
    const ds = decided.filter((o) => o.contactIds.some((id) => ctx.ledger.contact(id).buyingRole === role));
    if (ds.length) line(ctx, `   ${role.padEnd(16)} win ${pct(wr(ds)).padStart(6)}  n=${ds.length}`);
  }
  // Product-marketing persona present vs absent (the "win when PMM involved" story).
  const withPmm = decided.filter((o) => hasPmm(ctx, o));
  const noPmm = decided.filter((o) => !hasPmm(ctx, o));
  line(ctx, `PMM persona (${ctx.championRole}) present: n=${withPmm.length}  win ${pct(wr(withPmm))}`);
  line(ctx, `PMM persona absent:            n=${noPmm.length}  win ${pct(wr(noPmm))}`);
  line(ctx, `→ PMM-present win lift: ${pct(wr(withPmm) - wr(noPmm))}`);
}

/** Market-intelligence cohort of non-PMM buyers at bigger companies. */
function marketIntelSection(ctx: Ctx): void {
  const { decided, acct } = ctx;
  const comp = ctx.miCompetitor;
  if (!comp) return;
  section(ctx, `Market-intelligence cohort (${comp} / non-PMM buyers)`);
  const alpha = decided.filter((o) => o.competitors.includes(comp));
  const alphaPmm = alpha.filter((o) => hasPmm(ctx, o));
  const alphaNoPmm = alpha.filter((o) => !hasPmm(ctx, o));
  line(ctx, `Deals vs ${comp}: n=${alpha.length}  our win ${pct(wr(alpha))}`);
  line(ctx, `   with PMM persona:  n=${alphaPmm.length}  our win ${pct(wr(alphaPmm))}`);
  line(ctx, `   no PMM persona:    n=${alphaNoPmm.length}  our win ${pct(wr(alphaNoPmm))}`);
  // Bigger-company read: firmographics of the no-PMM (cohort) deals.
  const sizes = groupBy(alphaNoPmm, (o) => acct(o).size);
  line(
    ctx,
    `No-PMM deal sizes: ${[...sizes.entries()].map(([k, v]) => `${k}=${v.length}`).join("  ") || "(none)"}`,
  );
  const tiers = groupBy(alphaNoPmm, (o) => acct(o).icpTier);
  line(
    ctx,
    `No-PMM deal ICP tiers: ${
      [...tiers.entries()]
        .sort()
        .map(([k, v]) => `${k}=${v.length}`)
        .join("  ") || "(none)"
    }`,
  );
  // Loss reasons recorded on cohort losses (should be normal enum values).
  const lost = alphaNoPmm.filter((o) => o.status === "lost");
  const reasons = groupBy(lost, (o) => o.winLossReason ?? "(none)");
  line(
    ctx,
    `No-PMM loss reasons: ${
      [...reasons.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, v]) => `${k}=${v.length}`)
        .join("  ") || "(none)"
    }`,
  );
}

function salesTeamSection(ctx: Ctx): void {
  const { world, ledger, decided } = ctx;
  section(ctx, "Sales-team dashboard (AE performance)");
  const ics = world.reps.filter((r) => r.role === "ic");
  const cyc = (ds: Opp[]) =>
    mean(ds.filter((o) => o.closeDate).map((o) => daysBetween(o.createdDate, o.closeDate!)));
  line(ctx, `AE leaderboard (decided deals):`);
  const rows = ics
    .map((ic) => {
      const ds = decided.filter((o) => o.ownerRepId === ic.id);
      const rev = ds.filter((o) => o.status === "won").reduce((s, o) => s + o.amount, 0);
      const mgr = ic.managerId ? ledger.rep(ic.managerId).name : "none";
      return { ic, n: ds.length, win: wr(ds), rev, cyc: cyc(ds), mgr };
    })
    .sort((a, b) => b.win - a.win);
  for (const r of rows) {
    line(
      ctx,
      `   ${r.ic.name.padEnd(18)} win ${pct(r.win).padStart(6)}  n=${String(r.n).padStart(3)}  wonRev ${usd(r.rev).padStart(9)}  cycle ${r.cyc.toFixed(0)}d  (${r.ic.region}, mgr ${r.mgr})`,
    );
  }
  // Team rollup (manager = aggregate of reports).
  line(ctx, `Team rollup (manager = rollup of reports):`);
  for (const m of world.reps.filter((r) => r.role === "manager")) {
    const team = ics.filter((ic) => ic.managerId === m.id).map((ic) => ic.id);
    const ds = decided.filter((o) => team.includes(o.ownerRepId));
    const rev = ds.filter((o) => o.status === "won").reduce((s, o) => s + o.amount, 0);
    line(
      ctx,
      `   ${m.name.padEnd(18)} (${m.region}) team win ${pct(wr(ds))}  deals=${ds.length}  wonRev ${usd(rev)}`,
    );
  }
}

function timeSection(ctx: Ctx): void {
  const { world, decided, acct } = ctx;
  section(ctx, "Over-time trends (the planted trajectories)");
  // Volume by created month.
  const byCreated = groupBy(world.opportunities, (o) => month(o.createdDate));
  const months = [...byCreated.keys()].sort();
  line(ctx, `New opps / month: ${months.map((m) => `${m}:${byCreated.get(m)!.length}`).join("  ")}`);
  // Win rate by close month.
  const byClosed = groupBy(decided, (o) => month(o.closeDate));
  const cmonths = [...byClosed.keys()].filter(Boolean).sort();
  line(ctx, `Win rate / close-month: ${cmonths.map((m) => `${m}:${pct(wr(byClosed.get(m)!))}`).join("  ")}`);
  // Bumped-competitor win rate by close month (the dip-and-recover), when planted.
  if (ctx.bumpedCompetitor) {
    const comp = ctx.bumpedCompetitor.name;
    line(
      ctx,
      `Win rate vs ${comp} / month: ${cmonths
        .map((m) => {
          const ds = byClosed.get(m)!.filter((o) => o.competitors.includes(comp));
          return ds.length >= 3 ? `${m}:${pct(wr(ds))}` : `${m}:·`;
        })
        .join("  ")}`,
    );
  }
  // Emerging-segment share by created month, when planted.
  if (ctx.emergingIndustry) {
    const ind = ctx.emergingIndustry;
    line(
      ctx,
      `${ind} share / month: ${months
        .map((m) => {
          const ds = byCreated.get(m)!;
          return `${m}:${pct(ds.filter((o) => acct(o).industry === ind).length / ds.length)}`;
        })
        .join("  ")}`,
    );
  }
}

// --- hero-story checks ------------------------------------------------------

function heroChecks(ctx: Ctx): void {
  const { world, decided, acct } = ctx;
  section(ctx, "Hero-story visibility checks");
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  const inIcp = decided.filter((o) => acct(o).icpTier !== "Tier 3");
  const out = decided.filter((o) => acct(o).icpTier === "Tier 3");
  checks.push({
    name: "1 · In-ICP focus pays off",
    pass: wr(inIcp) - wr(out) > 0.07 && out.length >= 8,
    detail: `in-ICP ${pct(wr(inIcp))} vs out ${pct(wr(out))} (Δ ${pct(wr(inIcp) - wr(out))}); out n=${out.length}`,
  });

  const created = (a: string, b: string) =>
    world.opportunities.filter((o) => o.createdDate >= a && o.createdDate < b).length;
  const start = ctx.windowStart;
  const end = ctx.windowEnd;
  const mid = addDays(start, Math.floor(daysBetween(start, end) / 2));
  const q1 = created(start, addDays(start, 91));
  const q4 = created(addDays(end, -98), end);
  checks.push({ name: "2 · Pipeline velocity ramp", pass: q4 > q1 * 1.2, detail: `Q1 ${q1} → Q4 ${q4}` });

  if (ctx.emergingIndustry) {
    const ind = ctx.emergingIndustry;
    const indShare = (a: string, b: string) => {
      const ds = world.opportunities.filter((o) => o.createdDate >= a && o.createdDate < b);
      return ds.length ? ds.filter((o) => acct(o).industry === ind).length / ds.length : 0;
    };
    const indDecided = decided.filter((o) => acct(o).industry === ind);
    const outNonInd = out.filter((o) => acct(o).industry !== ind);
    checks.push({
      name: `3 · Emerging off-ICP ${ind}`,
      pass: indShare(mid, end) > indShare(start, mid) && wr(indDecided) > wr(outNonInd),
      detail: `share H1 ${pct(indShare(start, mid))} → H2 ${pct(indShare(mid, end))}; ${ind} win ${pct(wr(indDecided))} vs other-out ${pct(wr(outNonInd))}`,
    });
  }

  if (ctx.bumpedCompetitor) {
    const { name: comp, from, to } = ctx.bumpedCompetitor;
    const byClosed = groupBy(decided, (o) => month(o.closeDate));
    const compMonthly = [...byClosed.entries()]
      .filter(([m]) => m)
      .sort()
      .map(([m, ds]) => {
        const k = ds.filter((o) => o.competitors.includes(comp));
        return { m, wr: k.length >= 3 ? wr(k) : null };
      })
      .filter((x) => x.wr !== null) as { m: string; wr: number }[];
    const dip = compMonthly.filter((x) => x.m >= from && x.m <= to);
    const outside = compMonthly.filter((x) => x.m < from || x.m > to);
    const minDip = dip.length ? Math.min(...dip.map((x) => x.wr)) : 1;
    const avgOutside = mean(outside.map((x) => x.wr));
    checks.push({
      name: `4 · ${comp} toughens, then recover`,
      pass: minDip < avgOutside - 0.1,
      detail: `min ${from}..${to} vs ${comp} ${pct(minDip)} vs avg-outside ${pct(avgOutside)}`,
    });
  }

  const single = decided.filter((o) => o.contactIds.length <= 1);
  const multi = decided.filter((o) => o.contactIds.length >= 3);
  checks.push({
    // Threshold scaled to the ~280-opp volume (cohort gaps run ~8–12% here vs
    // ~18–20% at the original 533-opp scale); the structural lever is unchanged.
    name: "5 · Multi-threading wins",
    pass: wr(multi) - wr(single) > 0.08 && single.length >= 8,
    detail: `multi ${pct(wr(multi))} vs single ${pct(wr(single))} (Δ ${pct(wr(multi) - wr(single))}); single n=${single.length}`,
  });

  // Pricing pressure clusters on the competitor config marks as a price threat.
  const priceLost = decided.filter((o) => o.status === "lost" && o.winLossReason === "Price");
  const priceComp = ctx.priceCompetitor;
  if (priceComp) {
    const pricier = decided.filter(
      (o) => o.competitors.includes(priceComp) && o.priceFeedback === "More expensive",
    );
    checks.push({
      name: `6 · Pricing pressure vs ${priceComp}`,
      pass: priceLost.length >= 5 && pricier.length >= 3,
      detail: `Price losses ${priceLost.length}; ${priceComp} 'More expensive' ${pricier.length}`,
    });
  }

  const ics = world.reps.filter((r) => r.role === "ic");
  const repWr = (id: string) => {
    const ds = decided.filter((o) => o.ownerRepId === id);
    return ds.length ? wr(ds) : 0;
  };
  const spread = Math.max(...ics.map((r) => repWr(r.id))) - Math.min(...ics.map((r) => repWr(r.id)));
  const teamWr = (region: string) => {
    const ds = decided.filter((o) => world.reps.find((r) => r.id === o.ownerRepId)?.region === region);
    return ds.length ? wr(ds) : 0;
  };
  const noManagerDeals = world.reps
    .filter((r) => r.role === "manager")
    .every((m) => decided.every((o) => o.ownerRepId !== m.id));
  checks.push({
    // Threshold scaled to the ~280-opp volume (see checks 5/8); David's win rate
    // is also pulled down by the no-PMM deals he owns, compressing the spread.
    name: "7 · Owner leaderboard (David > Lukas)",
    pass: spread > 0.12 && teamWr("NA") > teamWr("EMEA") && noManagerDeals,
    detail: `owner win-rate spread ${pct(spread)}; David/NA ${pct(teamWr("NA"))} vs Lukas/EMEA ${pct(teamWr("EMEA"))}; managers own 0 deals=${noManagerDeals}`,
  });

  // 8 · Market-intelligence expansion. Win when PMM is involved.
  const withPmm = decided.filter((o) => hasPmm(ctx, o));
  const noPmm = decided.filter((o) => !hasPmm(ctx, o));
  const comp = ctx.miCompetitor;
  const alphaNoPmm = comp ? noPmm.filter((o) => o.competitors.includes(comp)) : [];
  const noPmmShare = (a: string, b: string) => {
    const ds = world.opportunities.filter((o) => o.createdDate >= a && o.createdDate < b);
    return ds.length ? ds.filter((o) => !hasPmm(ctx, o)).length / ds.length : 0;
  };
  const winStart = ctx.windowStart;
  const winMid = addDays(winStart, Math.floor(daysBetween(winStart, ctx.windowEnd) / 2));
  const shareH1 = noPmmShare(winStart, winMid);
  const shareH2 = noPmmShare(winMid, ctx.windowEnd);
  checks.push({
    name: "8 · Market-intelligence expansion (win when PMM involved)",
    pass:
      noPmm.length >= 5 &&
      wr(withPmm) - wr(noPmm) > 0.1 &&
      (comp ? wr(alphaNoPmm) < wr(withPmm) : false) &&
      shareH2 > shareH1,
    detail: `PMM-present win ${pct(wr(withPmm))} vs absent ${pct(wr(noPmm))} (Δ ${pct(wr(withPmm) - wr(noPmm))}); no-PMM n=${noPmm.length}; ${comp ?? "MI"} no-PMM win ${pct(wr(alphaNoPmm))}; no-PMM share H1 ${pct(shareH1)} → H2 ${pct(shareH2)}`,
  });

  for (const c of checks) line(ctx, `${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  const passed = checks.filter((c) => c.pass).length;
  line(ctx, `\n${passed}/${checks.length} hero stories statistically visible.`);
}

// --- CSV export -------------------------------------------------------------

function csv(rows: (string | number)[][]): string {
  return rows
    .map((r) =>
      r.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","),
    )
    .join("\n");
}

function exportCsvs(ctx: Ctx, dir: string): void {
  const { world, ledger } = ctx;
  const accountRows = [
    [
      "id",
      "name",
      "industry",
      "size",
      "employeeBand",
      "revenueBand",
      "fundingStage",
      "region",
      "triggers",
      "techStack",
      "icpScore",
      "icpTier",
    ],
    ...world.accounts.map((a) => [
      a.id,
      a.name,
      a.industry,
      a.size,
      a.employeeBand,
      a.revenueBand,
      a.fundingStage,
      a.region,
      a.triggers.join("|"),
      a.techStack.join("|"),
      a.icpScore,
      a.icpTier,
    ]),
  ];
  const oppRows = [
    [
      "id",
      "account",
      "tier",
      "billingTerm",
      "amount",
      "stage",
      "status",
      "complexity",
      "createdDate",
      "closeDate",
      "competitors",
      "lossReason",
      "priceFeedback",
      "productFeedback",
      "techStackReq",
      "contacts",
      "winLossMode",
    ],
    ...world.opportunities.map((o) => [
      o.id,
      ledger.account(o.accountId).name,
      o.tier,
      o.billingTerm,
      o.amount,
      o.stage,
      o.status,
      o.complexity,
      o.createdDate,
      o.closeDate ?? "",
      o.competitors.join("|"),
      o.winLossReason ?? "",
      o.priceFeedback ?? "",
      o.productFeedback.join("|"),
      o.techStackRequirements.join("|"),
      o.contactIds.length,
      o.winLossMode,
    ]),
  ];
  const contactRows = [
    ["id", "account", "name", "title", "buyingRole", "seniority", "email"],
    ...world.contacts.map((c) => [
      c.id,
      ledger.account(c.accountId).name,
      c.name,
      c.title,
      c.buyingRole,
      c.seniority ?? "",
      c.email,
    ]),
  ];
  writeText(repoPath(dir, "accounts.csv"), csv(accountRows));
  writeText(repoPath(dir, "opportunities.csv"), csv(oppRows));
  writeText(repoPath(dir, "contacts.csv"), csv(contactRows));
}

function main(): void {
  const cfg = loadConfig();
  const world = loadWorld();
  if (world.opportunities.length === 0) {
    console.error("Ledger is empty. Run `npm run apply -- --backfill` first.");
    process.exit(1);
  }
  const ledger = new Ledger(world);
  const decided = world.opportunities.filter((o) => o.status !== "open");
  const trends = loadTrends();
  const clock = loadClock();
  const bumpedEntry = Object.entries(trends.competitors ?? {}).find(
    ([, c]) => (c.strengthBumps ?? []).length > 0,
  );
  const bump = bumpedEntry?.[1].strengthBumps?.[0];
  const emergingIndustry = Object.entries(trends.segments?.industryWeightDriftPerQuarter ?? {}).find(
    ([, drift]) => (drift as number) > 0,
  )?.[0];
  const ctx: Ctx = {
    world,
    ledger,
    acct: (o) => ledger.account(o.accountId),
    decided,
    championRole: cfg.personas.champion_role,
    miCompetitor: cfg.world.market_intelligence?.competitor,
    companyShort: cfg.world.company.short_name ?? cfg.world.company.name,
    windowStart: clock.startDate,
    windowEnd: clock.simNow,
    bumpedCompetitor:
      bumpedEntry && bump
        ? {
            name: bumpedEntry[0],
            from: addDays(bump.center, -bump.widthDays).slice(0, 7),
            to: addDays(bump.center, bump.widthDays).slice(0, 7),
          }
        : undefined,
    emergingIndustry,
    priceCompetitor: cfg.competitors.competitors.find((c) => c.typical_loss_reasons.includes("Price"))?.name,
    out: [],
  };

  line(ctx, `# Insight pre-flight for the generated pipeline (${world.opportunities.length} opps)`);
  summary(ctx);
  pricingSection(ctx);
  icpSection(ctx);
  competitiveSection(ctx);
  personaSection(ctx);
  marketIntelSection(ctx);
  salesTeamSection(ctx);
  timeSection(ctx);
  heroChecks(ctx);

  const dir = repoPath("state", "preflight");
  ensureDir(dir);
  exportCsvs(ctx, "state/preflight");
  writeText(repoPath(dir, "report.md"), ctx.out.join("\n") + "\n");
  console.log(`\nExports → state/preflight/{report.md,accounts.csv,opportunities.csv,contacts.csv}`);
}

main();
