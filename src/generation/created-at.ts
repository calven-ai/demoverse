/**
 * Deterministic creation TIMESTAMP for an opportunity.
 *
 * The engine models deal birth date-granular (`opp.createdDate`, YYYY-MM-DD).
 * Salesforce, though, stamps every reconciled deal with the same wall-clock
 * CreatedDate (the reconcile run), which reads as obviously synthetic. To give
 * each deal a realistic, distinct creation instant we derive a business-hours
 * time-of-day from its `createdDate`, seeded so replays and re-runs match.
 *
 * We keep this SEPARATE from `createdDate`: that date stays exactly as generated
 * (close targets, stage fractions and the artifact timeline all key off it), and
 * this only adds the time component for the SF push.
 */

import { Rng } from "../util/rng.js";
import type { ISODate } from "../util/date.js";

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * `createdDate` + a seeded business-hours time → ISO-8601 UTC datetime
 * (e.g. `2025-06-28T10:42:07Z`). Hour is triangular over 08:00–18:00, peaking
 * mid-day; minute/second uniform. Deterministic in `rng`.
 */
export function createdAtFor(createdDate: ISODate, rng: Rng): string {
  const hour = rng.triangular(8, 13, 17); // [08,17], peak ~13:00
  const minute = rng.int(0, 59);
  const second = rng.int(0, 59);
  return `${createdDate}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
}
