/**
 * The firmographic band vocabulary — the ONE copy in code. Everything that
 * buckets an employee count, picks a representative number inside a band, or
 * names a band (`config/*.yaml segments.by_size`, the CSV prospect mapper, the
 * CRM firmographics writer) derives from these tables; config band labels are
 * validated against them at load.
 */

export interface EmployeeBand {
  label: string;
  /** Inclusive upper bound for bucketing a raw employee count. */
  bucketMax: number;
  /** Account size class this band implies. */
  size: "SMB" | "Mid-market" | "Enterprise";
  /** Representative span for deriving a plausible point value (CRM standard fields). */
  span: [number, number];
}

/** In ascending order; the last band is open-ended. */
export const EMPLOYEE_BANDS: EmployeeBand[] = [
  { label: "1-50", bucketMax: 50, size: "SMB", span: [8, 50] },
  { label: "51-200", bucketMax: 200, size: "SMB", span: [51, 200] },
  { label: "201-500", bucketMax: 500, size: "Mid-market", span: [201, 500] },
  { label: "501-2000", bucketMax: 2000, size: "Mid-market", span: [501, 2000] },
  { label: "2001-5000", bucketMax: 5000, size: "Enterprise", span: [2001, 5000] },
  { label: "5000+", bucketMax: Number.POSITIVE_INFINITY, size: "Enterprise", span: [5000, 25000] },
];

/** Annual-revenue span (USD) per revenue-band label. */
export const REVENUE_SPANS: Record<string, [number, number]> = {
  "<$10M": [2_000_000, 10_000_000],
  "$10-50M": [10_000_000, 50_000_000],
  "$50-250M": [50_000_000, 250_000_000],
  "$250M-1B": [250_000_000, 1_000_000_000],
  ">$1B": [1_000_000_000, 5_000_000_000],
};

/** Bucket a raw employee count into {size, band label}. Null count → mid-market. */
export function sizeForEmployees(employees: number | null): { size: string; employeeBand: string } {
  if (employees === null) return { size: "Mid-market", employeeBand: "501-2000" };
  const band = EMPLOYEE_BANDS.find((b) => employees <= b.bucketMax) ?? EMPLOYEE_BANDS.at(-1)!;
  return { size: band.size, employeeBand: band.label };
}

export function employeeSpan(label: string): [number, number] | undefined {
  return EMPLOYEE_BANDS.find((b) => b.label === label)?.span;
}

export const EMPLOYEE_BAND_LABELS = EMPLOYEE_BANDS.map((b) => b.label);
export const REVENUE_BAND_LABELS = Object.keys(REVENUE_SPANS);
