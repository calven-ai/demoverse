import { test } from "node:test";
import assert from "node:assert/strict";

import { standardFirmographics } from "../src/connectors/salesforce/firmographics.js";

const REGION_COUNTRIES = { NA: "United States", EMEA: "United Kingdom" };

const EMPLOYEE_BANDS: [string, number, number][] = [
  ["51-200", 51, 200],
  ["201-500", 201, 500],
  ["501-2000", 501, 2000],
  ["2001-5000", 2001, 5000],
  ["5000+", 5000, 25000],
];

const REVENUE_BANDS: [string, number, number][] = [
  ["<$10M", 2_000_000, 10_000_000],
  ["$10-50M", 10_000_000, 50_000_000],
  ["$50-250M", 50_000_000, 250_000_000],
  ["$250M-1B", 250_000_000, 1_000_000_000],
  [">$1B", 1_000_000_000, 5_000_000_000],
];

// The whole point of these fields is that the downstream product re-derives OUR band from the
// number. A value outside the band would make it disagree with the ledger.
test("derived employee counts stay inside their band", () => {
  for (const [band, lo, hi] of EMPLOYEE_BANDS) {
    for (let i = 0; i < 50; i++) {
      const f = standardFirmographics(
        {
          id: `acc-${i}`,
          employeeBand: band,
          revenueBand: "$10-50M",
          region: "NA",
        },
        REGION_COUNTRIES,
      );
      assert.ok(f.NumberOfEmployees !== undefined, `${band} produced no value`);
      assert.ok(
        f.NumberOfEmployees! >= lo && f.NumberOfEmployees! <= hi,
        `${band}: ${f.NumberOfEmployees} outside [${lo}, ${hi}]`,
      );
    }
  }
});

test("derived revenue stays inside its band", () => {
  for (const [band, lo, hi] of REVENUE_BANDS) {
    for (let i = 0; i < 50; i++) {
      const f = standardFirmographics(
        {
          id: `acc-${i}`,
          employeeBand: "201-500",
          revenueBand: band,
          region: "EMEA",
        },
        REGION_COUNTRIES,
      );
      assert.ok(f.AnnualRevenue !== undefined, `${band} produced no value`);
      assert.ok(
        f.AnnualRevenue! >= lo && f.AnnualRevenue! <= hi,
        `${band}: ${f.AnnualRevenue} outside [${lo}, ${hi}]`,
      );
    }
  }
});

test("region maps to the country the downstream product derives region back from", () => {
  const na = standardFirmographics(
    {
      id: "acc-1",
      employeeBand: "51-200",
      revenueBand: "<$10M",
      region: "NA",
    },
    REGION_COUNTRIES,
  );
  const emea = standardFirmographics(
    {
      id: "acc-1",
      employeeBand: "51-200",
      revenueBand: "<$10M",
      region: "EMEA",
    },
    REGION_COUNTRIES,
  );
  assert.equal(na.BillingCountry, "United States");
  assert.equal(emea.BillingCountry, "United Kingdom");
});

// Values must not churn between reconciles — a re-run would otherwise rewrite
// every account and make the diff meaningless.
test("values are deterministic per account id", () => {
  const acct = { id: "acc-042", employeeBand: "501-2000", revenueBand: "$50-250M", region: "NA" };
  const a = standardFirmographics(acct, REGION_COUNTRIES);
  const b = standardFirmographics(acct, REGION_COUNTRIES);
  assert.deepEqual(a, b);
});

test("different accounts in one band get a spread of values", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const f = standardFirmographics(
      {
        id: `acc-${i}`,
        employeeBand: "501-2000",
        revenueBand: "$50-250M",
        region: "NA",
      },
      REGION_COUNTRIES,
    );
    seen.add(f.NumberOfEmployees!);
  }
  assert.ok(seen.size > 10, `expected a spread, got ${seen.size} distinct values`);
});

// An unknown band is a config drift signal — omit the field rather than invent
// a number the downstream product would then derive a wrong band from.
test("unknown bands omit the field instead of guessing", () => {
  const f = standardFirmographics(
    {
      id: "acc-1",
      employeeBand: "not-a-band",
      revenueBand: "not-a-band",
      region: "APAC",
    },
    REGION_COUNTRIES,
  );
  assert.equal(f.NumberOfEmployees, undefined);
  assert.equal(f.AnnualRevenue, undefined);
  assert.equal(f.BillingCountry, undefined);
});
