/**
 * Real target-account ingestion — turns the operator's prospect CSVs (config
 * `world.prospects`) into a pool of REAL companies the generator draws account
 * objects from (name/domain/industry/firmographics), while the pipeline,
 * contacts and outcomes stay synthetic.
 *
 * The lists are re-derived read-only; nothing is copied into this repo. Each
 * file's industry/region mapping comes from config (`prospects.files[]` +
 * `segments.industry_keywords`), and rows resolving outside the configured
 * industry vocabulary are skipped. When the pool is disabled or a bucket is
 * empty the caller falls back to the synthetic name banks (names.ts), so
 * generation never fails and the planted industry distribution is honored.
 *
 * Guardrail (DESIGN §18): only the account/logo is real. Contacts are fabricated
 * (see names.ts demoEmailDomain) — no real person or real contact info is used.
 */

import { readText, repoPath, fileExists } from "../util/fs.js";
import type { Rng } from "../util/rng.js";
import type { WorldConfig } from "../config/schema.js";
import type { World } from "../ledger/schema.js";
import { sizeForEmployees } from "../domain/bands.js";

type ProspectFile = NonNullable<WorldConfig["prospects"]>["files"][number];

/** A normalized real company, mapped onto the engine's enums. */
export interface RealCompany {
  name: string;
  domain: string;
  /** An industry from config/world.yaml segments.industries. */
  industry: string;
  /** A region from config/world.yaml segments.regions. */
  region: string;
  /** Enterprise | Mid-market | SMB. */
  size: string;
  /** An engine employee_band enum value (config/icp.yaml). */
  employeeBand: string;
  /** An engine funding_stage enum, or null to sample coherently downstream. */
  fundingStage: string | null;
  /** Which prospect list this came from (provenance/debugging). */
  sourceVertical: string;
}

export interface RealAccountPool {
  readonly size: number;
  /**
   * Draw an unused real company, preferring the requested industry bucket (and,
   * for the market-intelligence cohort, a genuinely large/Enterprise vendor).
   * Marks it consumed. Returns null when the bucket is exhausted — the caller
   * then falls back to a synthetic name.
   */
  pick(rng: Rng, opts?: { industry?: string; large?: boolean }): RealCompany | null;
}

// --- CSV parsing -------------------------------------------------------------

/** Quote-aware CSV parse (handles commas and newlines inside "..." fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  // flush trailing field/row (unless the file ended on a clean newline)
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse a CSV file into header-keyed record objects. */
function parseRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = (r[i] ?? "").trim();
    });
    return rec;
  });
}

// --- field normalization -----------------------------------------------------

/**
 * Map a free-text vertical/sub-category onto a configured industry via the
 * ordered `segments.industry_keywords` rules (first match wins), falling back
 * to `segments.industry_fallback` (or null → the row is skipped).
 */
function industryFromText(raw: string, wcfg: WorldConfig): string | null {
  for (const rule of wcfg.segments.industry_keywords) {
    if (new RegExp(rule.pattern, "i").test(raw)) return rule.industry;
  }
  return wcfg.segments.industry_fallback ?? null;
}

/** First integer in a messy employee string ("~2000+ (Prague), 3000 global" → 2000). */
function parseEmployees(raw: string): number | null {
  const m = raw.replace(/,/g, "").match(/\d+/);
  return m ? parseInt(m[0]!, 10) : null;
}

const NA_HINTS =
  /(usa|united states|u\.s\.|, ca|, ny|, tx|, ma|, wa|, il|, co|canada|toronto|new york|san francisco|boston|austin|seattle|chicago|palo alto|santa clara|silicon valley)/i;
const EMEA_HINTS =
  /(uk|united kingdom|england|london|ireland|dublin|germany|berlin|munich|france|paris|netherlands|amsterdam|belgium|brussels|sweden|stockholm|spain|madrid|barcelona|italy|poland|czech|prague|brno|hungary|budapest|austria|vienna|switzerland|denmark|finland|norway|portugal|estonia|romania|europe|israel|tel aviv)/i;

/** Country/city → NA | EMEA; a fixed per-file region from config wins. */
function regionFor(hqRaw: string, fixedRegion: string | undefined): string {
  if (fixedRegion) return fixedRegion;
  if (NA_HINTS.test(hqRaw)) return "NA";
  if (EMEA_HINTS.test(hqRaw)) return "EMEA";
  return "NA"; // global lists skew US — default NA when unknown
}

/** Best-effort engine funding_stage from free text; null → sample downstream. */
function fundingFor(raw: string): string | null {
  const s = raw.toLowerCase();
  if (/(public|ipo|nasdaq|nyse|\(lse\)|listed|went public)/.test(s)) return "Public";
  if (/(pe-owned|private equity|buyout|acquired by|acquisition by|taken private)/.test(s)) return "PE-owned";
  if (/series\s*[d-z]/.test(s)) return "Series D+";
  if (/series\s*c/.test(s)) return "Series C";
  if (/series\s*b/.test(s)) return "Series B";
  if (/series\s*a/.test(s)) return "Series A";
  if (/\bseed\b/.test(s)) return "Seed";
  if (/bootstrapp/.test(s)) return "Bootstrapped";
  return null;
}

/** Strip a Website/URL down to a bare, lowercased registrable domain. */
function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
}

function firstNonEmpty(rec: Record<string, string>, keys: string[]): string {
  for (const k of keys) if (rec[k] && rec[k]!.trim() !== "") return rec[k]!.trim();
  return "";
}

/** Normalize one CSV record; returns null if it lacks a usable name+domain. */
function normalizeRow(
  rec: Record<string, string>,
  fileCfg: ProspectFile,
  wcfg: WorldConfig,
): RealCompany | null {
  const name = firstNonEmpty(rec, ["Company", "Name"]);
  const domain = normalizeDomain(firstNonEmpty(rec, ["Website", "Domain", "Domains"]));
  if (!name || !domain || !domain.includes(".")) return null;

  const categoryText = firstNonEmpty(rec, ["Sub-Category", "Industry/Vertical", "Vertical", "Industry"]);
  const industry = fileCfg.industry ?? industryFromText(categoryText, wcfg);
  // Only configured industries enter the pool — anything else would break the
  // planted industry distribution downstream.
  if (!industry || !(industry in wcfg.segments.industries)) return null;

  const { size, employeeBand } = sizeForEmployees(
    parseEmployees(firstNonEmpty(rec, ["Est. Employees", "Employees"])),
  );
  const region = regionFor(
    firstNonEmpty(rec, ["Headquarters (City; Country)", "Location", "HQ", "Headquarters"]),
    fileCfg.region,
  );
  const fundingStage = fundingFor(
    firstNonEmpty(rec, ["Funding/Acquisition Status", "Acquisition Status", "Funding"]),
  );

  return {
    name,
    domain,
    industry,
    region,
    size,
    employeeBand,
    fundingStage,
    sourceVertical: fileCfg.file,
  };
}

/** Parse + normalize one CSV file's text into real companies (drops bad rows). */
export function companiesFromCsv(text: string, fileCfg: ProspectFile, wcfg: WorldConfig): RealCompany[] {
  const out: RealCompany[] = [];
  for (const rec of parseRecords(text)) {
    const c = normalizeRow(rec, fileCfg, wcfg);
    if (c) out.push(c);
  }
  return out;
}

// --- pool --------------------------------------------------------------------

/** Load + normalize + dedupe (by domain) all configured prospect lists. */
export function loadRealCompanies(wcfg: WorldConfig): RealCompany[] {
  const cfg = wcfg.prospects;
  if (!cfg || cfg.enabled === false) return [];
  const byDomain = new Map<string, RealCompany>();
  for (const fileCfg of cfg.files) {
    const path = repoPath(cfg.dir, fileCfg.file);
    if (!fileExists(path)) {
      console.warn(`⚠️  prospects: list not found, skipping: ${cfg.dir}/${fileCfg.file}`);
      continue;
    }
    for (const c of companiesFromCsv(readText(path), fileCfg, wcfg)) {
      if (!byDomain.has(c.domain)) byDomain.set(c.domain, c);
    }
  }
  // Stable order (by domain) so seeded picks replay identically.
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Build the draw pool. Companies already present in the ledger (by domain) start
 * consumed, so incremental weekly runs never reuse a logo. Deterministic: picks
 * flow through the caller's seeded Rng over a stable (domain-sorted) candidate
 * list.
 */
export function buildRealAccountPool(world: World, wcfg: WorldConfig): RealAccountPool {
  const companies = loadRealCompanies(wcfg);
  const consumed = new Set<string>(world.accounts.map((a) => normalizeDomain(a.domain)));
  if (companies.length > 0) {
    console.log(
      `ℹ️  prospects: ${companies.length} real companies loaded (${consumed.size} already in ledger)`,
    );
  }

  const draw = (rng: Rng, filter: (c: RealCompany) => boolean): RealCompany | null => {
    const candidates = companies.filter((c) => !consumed.has(c.domain) && filter(c));
    if (candidates.length === 0) return null;
    const chosen = rng.pick(candidates);
    consumed.add(chosen.domain);
    return chosen;
  };

  return {
    size: companies.length,
    pick(rng, opts) {
      const industry = opts?.industry;
      const large = opts?.large === true;
      const inIndustry = (c: RealCompany) => !industry || c.industry === industry;
      // The requested industry is NEVER crossed: exhaustion returns null so the
      // caller falls back to a SYNTHETIC name of that industry, preserving the
      // planted industry distribution. `large` (MI cohort) is a hard preference
      // for an Enterprise vendor within the industry — if none, null → synthetic
      // forced-Enterprise, which keeps the "bigger ICP" size story intact.
      if (large) return draw(rng, (c) => c.size === "Enterprise" && inIndustry(c));
      return draw(rng, inIndustry);
    },
  };
}
