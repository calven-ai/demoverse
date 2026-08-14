/**
 * Derive Salesforce's STANDARD firmographic fields from the ledger's band enums.
 *
 * Why this exists: downstream CRM ingestion treats `NumberOfEmployees`,
 * `AnnualRevenue` and `BillingCountry` as always-imported, and enrichment derives `size`,
 * `employee_band`, `revenue_band` and `region` from those raw numbers. The
 * engine's own vocabulary is the BAND (crm-shared.ts enums), so we pick a
 * representative point INSIDE each band rather than leaving the standard
 * fields null and hoping enrichment finds our custom band fields.
 *
 * The point is drawn deterministically from the account id, so a value never
 * churns between reconciles and the spread across accounts still looks natural
 * (a whole band collapsing onto one midpoint would read as synthetic).
 */

import { Rng } from "../../util/rng.js";
import { employeeSpan, REVENUE_SPANS } from "../../domain/bands.js";

/** Round to a believable precision. Nobody records 4,317 employees. */
function roundEmployees(n: number): number {
  if (n < 100) return Math.round(n / 5) * 5;
  if (n < 1000) return Math.round(n / 25) * 25;
  return Math.round(n / 100) * 100;
}

/** Revenue lands on a round million. */
function roundRevenue(n: number): number {
  return Math.round(n / 1_000_000) * 1_000_000;
}

export interface StandardFirmographics {
  NumberOfEmployees?: number;
  AnnualRevenue?: number;
  BillingCountry?: string;
}

/**
 * Representative standard-field values for one account. Unknown bands are
 * omitted rather than guessed. A null is honest, a wrong number is not.
 */
export function standardFirmographics(
  account: {
    id: string;
    employeeBand: string;
    revenueBand: string;
    region: string;
  },
  /** Region → BillingCountry, from config/world.yaml segments.region_countries. */
  regionCountries: Record<string, string>,
): StandardFirmographics {
  const out: StandardFirmographics = {};

  const emp = employeeSpan(account.employeeBand);
  if (emp) {
    const n = new Rng(`${account.id}|employees`).int(emp[0], emp[1]);
    // Clamp back into the band: rounding must never push a value across the
    // boundary, or the downstream product would re-derive a DIFFERENT band than the ledger's.
    out.NumberOfEmployees = Math.min(emp[1], Math.max(emp[0], roundEmployees(n)));
  }

  const rev = REVENUE_SPANS[account.revenueBand];
  if (rev) {
    const n = new Rng(`${account.id}|revenue`).int(rev[0], rev[1]);
    out.AnnualRevenue = Math.min(rev[1], Math.max(rev[0], roundRevenue(n)));
  }

  const country = regionCountries[account.region];
  if (country) out.BillingCountry = country;

  return out;
}
