/**
 * Deterministic name banks for synthetic accounts and contacts.
 *
 * All names are clearly fictitious (DESIGN §18 guardrail: no impersonation of
 * real people). Company names are assembled from neutral parts; person names
 * from broad first/last banks. Everything is drawn via the seeded Rng so a given
 * world replays identically.
 */

import type { Rng } from "../util/rng.js";

const COMPANY_PREFIXES = [
  "North",
  "Vertex",
  "Summit",
  "Cedar",
  "Harbor",
  "Lumen",
  "Atlas",
  "Meridian",
  "Bright",
  "Iron",
  "Silver",
  "Pioneer",
  "Crest",
  "Beacon",
  "Granite",
  "Cobalt",
  "Vantage",
  "Anchor",
  "Keystone",
  "Polaris",
  "Helix",
  "Orchard",
  "Ridge",
  "Quill",
];

// B2B-tech name parts per industry (see config/world.yaml segments.industries).
const COMPANY_SUFFIXES_BY_INDUSTRY: Record<string, string[]> = {
  DevTools: ["Labs", "Stack", "Build", "Deploy", "Forge", "Runtime"],
  Cybersecurity: ["Security", "Shield", "Defend", "Guard", "Sec", "Armor"],
  "Data & Analytics": ["Data", "Analytics", "Metrics", "Insights", "Signal", "Lake"],
  Fintech: ["Pay", "Finance", "Ledger", "Capital", "Money", "Banking"],
  "HR Tech": ["HR", "People", "Talent", "Workforce", "Hire", "Team"],
  Healthtech: ["Health", "Care", "Clinical", "MedTech", "Vital", "Wellness"],
  "E-commerce": ["Commerce", "Shop", "Cart", "Retail", "Store", "Market"],
};

const FIRST_NAMES = [
  "Avery",
  "Jordan",
  "Riley",
  "Morgan",
  "Casey",
  "Taylor",
  "Jamie",
  "Quinn",
  "Devon",
  "Rowan",
  "Sasha",
  "Noor",
  "Priya",
  "Mateo",
  "Hana",
  "Liam",
  "Sofia",
  "Omar",
  "Yuki",
  "Elena",
  "Marcus",
  "Aisha",
  "Diego",
  "Freya",
  "Kenji",
  "Lucia",
  "Tobias",
  "Naomi",
  "Andre",
  "Mei",
  "Ravi",
  "Clara",
];

const LAST_NAMES = [
  "Patel",
  "Nguyen",
  "Garcia",
  "Kim",
  "Okafor",
  "Andersson",
  "Rossi",
  "Schmidt",
  "Hassan",
  "Cohen",
  "Murphy",
  "Silva",
  "Tanaka",
  "Novak",
  "Dubois",
  "Costa",
  "Ivanova",
  "Mensah",
  "Larsson",
  "Khan",
  "Romano",
  "Park",
  "Fischer",
  "Reyes",
  "Bauer",
  "Haddad",
  "Walsh",
  "Moreau",
  "Singh",
  "Petrov",
  "Lindqvist",
  "Becker",
];

export function makeCompanyName(rng: Rng, industry: string): { name: string; domain: string } {
  const prefix = rng.pick(COMPANY_PREFIXES);
  const suffixes = COMPANY_SUFFIXES_BY_INDUSTRY[industry] ?? ["Group", "Co", "Partners"];
  const suffix = rng.pick(suffixes);
  const name = `${prefix} ${suffix}`;
  const domain = `${prefix.toLowerCase()}${suffix.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
  return { name, domain };
}

export function makePersonName(rng: Rng): { first: string; last: string; full: string } {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return { first, last, full: `${first} ${last}` };
}

export function emailFor(full: string, domain: string): string {
  const slug = full.toLowerCase().replace(/[^a-z]+/g, ".");
  return `${slug}@${domain}`;
}

/**
 * A clearly-fake, non-resolving email domain for a synthetic contact, derived
 * from the account's (possibly REAL) domain. Uses the reserved `.example` TLD
 * (RFC 2606) so a fabricated contact at a real logo can never
 * produce a plausible real mailbox. Accounts are real, people never are
 * (DESIGN §18). Keeping the account label makes emails unique per account.
 */
export function demoEmailDomain(accountDomain: string, syntheticDomain = "demo.example"): string {
  const label = accountDomain
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".")[0]!
    .replace(/[^a-z0-9]/g, "");
  return `${label || "account"}.${syntheticDomain}`;
}
