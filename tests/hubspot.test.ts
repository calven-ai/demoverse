import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyWorld } from "../src/ledger/ledger.js";
import type { Account, Contact, Opportunity } from "../src/ledger/schema.js";
import {
  companyProperties,
  contactProperties,
  dealProperties,
  hubSpotStageFor,
  selectHubSpotDataset,
} from "../src/connectors/hubspot/import.js";
import { chunk, flattenBatchErrors, type HubSpotPipeline } from "../src/connectors/hubspot/client.js";

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  name: `Real Logo ${id}`,
  domain: `${id}.example.com`,
  industry: "DevTools",
  size: "SMB",
  employeeBand: "51-200",
  revenueBand: "<$10M",
  fundingStage: "Seed",
  region: "NA",
  triggers: [],
  techStack: [],
  icpScore: 50,
  icpTier: "Tier 2",
  external: {},
  ...overrides,
});

const opportunity = (id: string, accountId: string, status: Opportunity["status"]): Opportunity => ({
  id,
  name: `${id} deal`,
  accountId,
  ownerRepId: "rep-1",
  amount: 10000,
  tier: "professional",
  billingTerm: "annual",
  stage: status === "open" ? "Evaluation" : "Closed",
  status,
  complexity: "Medium",
  createdDate: "2026-01-01",
  closeDate: status === "open" ? undefined : "2026-02-01",
  stageHistory: [],
  competitors: ["Vantage IQ"],
  winLossReason: status === "lost" ? "Price" : undefined,
  productFeedback: [],
  techStackRequirements: [],
  winLossMode: "none",
  contactIds: [`contact-${id}`],
  primaryContactId: `contact-${id}`,
  external: {},
});

const contact = (id: string, accountId: string): Contact => ({
  id,
  accountId,
  name: `Demo ${id}`,
  title: "VP Marketing",
  buyingRole: "Champion",
  email: `real-looking@${accountId}.test`,
  external: {},
});

test("chunk splits arrays into bounded groups, including the remainder", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 5), []);
  assert.deepEqual(chunk([1, 2], 10), [[1, 2]]);
});

test("HubSpot pilot selection is bounded and includes representative outcomes", () => {
  const world = emptyWorld("hubspot-test");
  world.accounts = ["acc-1", "acc-2"].map((id) => account(id));
  world.opportunities = [
    opportunity("opp-1", "acc-1", "lost"),
    opportunity("opp-2", "acc-1", "open"),
    opportunity("opp-3", "acc-1", "won"),
    opportunity("opp-4", "acc-2", "won"),
  ];
  world.contacts = world.opportunities.map((opp) => contact(`contact-${opp.id}`, opp.accountId));

  const selected = selectHubSpotDataset(world, { kind: "pilot", accountLimit: 1, dealsPerAccount: 3 });
  assert.equal(selected.accounts.length, 1);
  assert.deepEqual(
    new Set(selected.opportunities.map((opp) => opp.status)),
    new Set(["open", "won", "lost"]),
  );
  assert.equal(selected.contacts.length, 3);
});

test("HubSpot pilot selection rejects out-of-range bounds", () => {
  const world = emptyWorld("hubspot-bounds");
  assert.throws(() => selectHubSpotDataset(world, { kind: "pilot", accountLimit: 0, dealsPerAccount: 3 }));
  assert.throws(() => selectHubSpotDataset(world, { kind: "pilot", accountLimit: 11, dealsPerAccount: 3 }));
  assert.throws(() => selectHubSpotDataset(world, { kind: "pilot", accountLimit: 1, dealsPerAccount: 11 }));
});

test("HubSpot opportunity scope selects exactly one deal's account and buying group", () => {
  const world = emptyWorld("hubspot-opp");
  world.accounts = [account("acc-1"), account("acc-2")];
  world.opportunities = [opportunity("opp-1", "acc-1", "won"), opportunity("opp-2", "acc-2", "open")];
  world.contacts = [contact("contact-opp-1", "acc-1"), contact("contact-opp-2", "acc-2")];

  const selected = selectHubSpotDataset(world, { kind: "opportunity", oppId: "opp-1" });
  assert.deepEqual(
    selected.accounts.map((a) => a.id),
    ["acc-1"],
  );
  assert.deepEqual(
    selected.opportunities.map((o) => o.id),
    ["opp-1"],
  );
  assert.deepEqual(
    selected.contacts.map((c) => c.id),
    ["contact-opp-1"],
  );
});

test("HubSpot opportunity scope rejects an unknown opp id", () => {
  const world = emptyWorld("hubspot-opp-missing");
  assert.throws(() => selectHubSpotDataset(world, { kind: "opportunity", oppId: "opp-999" }), /not found/);
});

test("HubSpot 'all' scope selects the entire ledger, sorted by id", () => {
  const world = emptyWorld("hubspot-all");
  world.accounts = [account("acc-2"), account("acc-1")];
  world.opportunities = [opportunity("opp-2", "acc-2", "open"), opportunity("opp-1", "acc-1", "won")];
  world.contacts = [contact("contact-opp-2", "acc-2"), contact("contact-opp-1", "acc-1")];

  const selected = selectHubSpotDataset(world, { kind: "all" });
  assert.deepEqual(
    selected.accounts.map((a) => a.id),
    ["acc-1", "acc-2"],
  );
  assert.deepEqual(
    selected.opportunities.map((o) => o.id),
    ["opp-1", "opp-2"],
  );
  assert.deepEqual(
    selected.contacts.map((c) => c.id),
    ["contact-opp-1", "contact-opp-2"],
  );
});

test("HubSpot company mapping preserves the real target-account name/domain", () => {
  const company = companyProperties(
    account("acc-1", { name: "Acme Robotics", domain: "acmerobotics.com", source: "outbound-list-2026-q1" }),
  );
  assert.equal(company.name, "Acme Robotics");
  assert.equal(company.domain, "acmerobotics.com");
  assert.equal(company.demo_world_source, "outbound-list-2026-q1");
  assert.ok(company.demo_world_notice?.includes("Real target account"));
});

test("HubSpot company mapping defaults demo_world_source when the account has no provenance", () => {
  const company = companyProperties(account("acc-1"));
  assert.equal(company.demo_world_source, "synthetic");
});

test("HubSpot contact mapping keeps synthetic identity but forces a non-deliverable email", () => {
  const mapped = contactProperties({
    id: "con-1",
    accountId: "acc-1",
    name: "Synthetic Person",
    title: "CMO",
    buyingRole: "Decision Maker",
    email: "synthetic@real.example",
    external: {},
  });
  assert.equal(mapped.email, "con-1@example.com");
  assert.equal(mapped.firstname, "Synthetic");
  assert.equal(mapped.lastname, "Person");
  assert.ok(mapped.demo_world_notice?.includes("fabricated"));
});

test("HubSpot deal mapping keeps the ledger name and marks the deal synthetic out-of-band", () => {
  const pipeline: HubSpotPipeline = {
    id: "default",
    label: "Sales Pipeline",
    displayOrder: 0,
    stages: [
      {
        id: "won-id",
        label: "Closed Won",
        displayOrder: 2,
        metadata: { isClosed: "true", probability: "1" },
      },
    ],
  };
  const owner = {
    id: "rep-1",
    name: "Jordan Rep",
    email: "jordan@example.com",
    region: "NA",
    role: "ic" as const,
    external: {},
  };
  const deal = dealProperties(opportunity("opp-1", "acc-1", "won"), owner, undefined, pipeline);
  // The name mirrors the ledger verbatim — no "[DEMO]"/marker decoration.
  assert.equal(deal.dealname, "opp-1 deal");
  assert.ok(deal.demo_world_notice?.includes("fabricated"));
  assert.equal(deal.demo_world_account_executive, "Jordan Rep");
});

test("HubSpot stage mapping uses the account's pipeline IDs", () => {
  const pipeline: HubSpotPipeline = {
    id: "default",
    label: "Sales Pipeline",
    displayOrder: 0,
    stages: [
      {
        id: "discover",
        label: "Appointment Scheduled",
        displayOrder: 0,
        metadata: { isClosed: "false", probability: "0.2" },
      },
      {
        id: "evaluate",
        label: "Qualified to Buy",
        displayOrder: 1,
        metadata: { isClosed: "false", probability: "0.5" },
      },
      {
        id: "won-id",
        label: "Closed Won",
        displayOrder: 2,
        metadata: { isClosed: "true", probability: "1" },
      },
      {
        id: "lost-id",
        label: "Closed Lost",
        displayOrder: 3,
        metadata: { isClosed: "true", probability: "0" },
      },
    ],
  };

  assert.equal(hubSpotStageFor(opportunity("open", "acc-1", "open"), pipeline), "discover");
  assert.equal(hubSpotStageFor(opportunity("won", "acc-1", "won"), pipeline), "won-id");
  assert.equal(hubSpotStageFor(opportunity("lost", "acc-1", "lost"), pipeline), "lost-id");
});

test("flattenBatchErrors attributes inner errors to the originating record by index", () => {
  const batch = [{ id: "acc-1" }, { id: "acc-2" }];
  const errors = flattenBatchErrors(
    [
      {
        category: "VALIDATION_ERROR",
        message: "One or more records failed validation.",
        errors: [{ message: "domain is required", in: "inputs[1].properties.domain" }],
      },
    ],
    batch,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.entity, "acc-2");
  assert.match(errors[0]?.message ?? "", /domain is required/);
});

test("flattenBatchErrors falls back to a batch-level entity without an inner error index", () => {
  const errors = flattenBatchErrors(
    [{ category: "RATE_LIMIT", message: "Too many requests" }],
    [{ id: "acc-1" }],
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.entity, "batch");
});
