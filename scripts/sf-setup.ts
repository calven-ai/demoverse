/**
 * One-time, idempotent Salesforce schema setup for the demo-world push.
 *
 * Creates the custom fields the reconciler (src/salesforce/reconcile.ts) writes
 * but that the org is missing, as PROPER PICKLISTS where the data is categorical
 * (else Text), and ensures the existing Buying_Role__c / standard Industry
 * picklists accept the values we emit. Safe to re-run: existing fields are
 * skipped, and restricted picklists are only edited when a value is missing.
 *
 *   npx tsx scripts/sf-setup.ts            # create/verify
 *   npx tsx scripts/sf-setup.ts --dry-run  # report what it WOULD do
 *
 * Uses the Tooling API (REST/JSON) for custom fields and the Metadata API (SOAP)
 * only for the standard Industry value set. Auth via SalesforceClient (fetch).
 */

import { SalesforceClient } from "../src/connectors/salesforce/client.js";
import { env } from "../src/util/env.js";

const dryRun = process.argv.includes("--dry-run");
const v = "59.0";

type PicklistSpec = { type: "Picklist"; values: string[] };
type TextSpec = { type: "Text"; length: number };
type DateTimeSpec = { type: "DateTime" };
type FieldSpec = { api: string; label: string } & (PicklistSpec | TextSpec | DateTimeSpec);

const pick = (api: string, label: string, values: string[]): FieldSpec => ({
  api,
  label,
  type: "Picklist",
  values,
});
const text = (api: string, label: string, length = 255): FieldSpec => ({ api, label, type: "Text", length });
const datetime = (api: string, label: string): FieldSpec => ({ api, label, type: "DateTime" });

// The fields the reconciler writes, grouped by object. Categorical → Picklist.
const FIELDS: Record<string, FieldSpec[]> = {
  Account: [
    pick("Company_Size__c", "Company Size", ["Enterprise", "Mid-market", "SMB"]),
    pick("Employee_Band__c", "Employee Band", [
      "1-50",
      "51-200",
      "201-500",
      "501-2000",
      "2001-5000",
      "5000+",
    ]),
    pick("Revenue_Band__c", "Revenue Band", ["<$10M", "$10-50M", "$50-250M", "$250M-1B", ">$1B"]),
    pick("Funding_Stage__c", "Funding Stage", [
      "Bootstrapped",
      "Seed",
      "Series A",
      "Series B",
      "Series C",
      "Series D+",
      "Public",
      "PE-owned",
    ]),
    pick("Region__c", "Region", ["NA", "EMEA", "APAC"]),
    text("Triggers__c", "Triggers"),
    text("Tech_Stack__c", "Tech Stack"),
  ],
  Contact: [text("Seniority__c", "Seniority")],
  Opportunity: [
    pick("Tier__c", "Tier", ["professional", "enterprise"]),
    pick("Billing_Term__c", "Billing Term", ["monthly", "annual"]),
    pick("Complexity__c", "Complexity", ["Low", "Medium", "High"]),
    pick("Price_Feedback__c", "Price Feedback", ["Less expensive", "On par", "More expensive"]),
    // AE-believed loss reason (owner's view) — distinct from Win_Loss_Reason__c (prospect).
    pick("AE_Believed_Loss_Reason__c", "AE-Believed Loss Reason", [
      "Price",
      "Missing feature",
      "Integrations",
      "Incumbent",
      "Brand/trust",
      "No decision",
    ]),
    text("Product_Feedback__c", "Product Feedback"),
    text("Tech_Stack_Requirements__c", "Tech Stack Requirements"),
    text("Account_Executive__c", "Account Executive"),
    text("AE_Email__c", "AE Email"),
    text("Sales_Manager__c", "Sales Manager"),
    // Realistic deal creation instant — the native audit CreatedDate can't be
    // backdated on update, so reconcile writes the demo's true creation date here.
    datetime("Original_Created_Date__c", "Original Created Date"),
  ],
  // Touch-point activities (Task) + transcript files (ContentVersion) need NO
  // custom fields: Tasks are idempotent via the ledger-stored id and cascade-purge
  // with their Opportunity; transcript files purge via their opportunity link.
  // (Custom fields can't be created on Task directly, and FLS isn't settable on
  // Task/ContentVersion — so we deliberately avoid a marker field there.)
};

// Existing picklists we must ensure accept our values (only if restricted).
const BUYING_ROLES = [
  "Champion",
  "Decision Maker",
  "Economic Buyer",
  "Technical Buyer",
  "User",
  "Influencer",
  "Blocker",
  "Sponsor",
];
const INDUSTRIES = [
  "DevTools",
  "Cybersecurity",
  "Data & Analytics",
  "Fintech",
  "HR Tech",
  "Healthtech",
  "E-commerce",
];

function fieldMetadata(spec: FieldSpec): Record<string, unknown> {
  if (spec.type === "Text") return { label: spec.label, type: "Text", length: spec.length };
  if (spec.type === "DateTime") return { label: spec.label, type: "DateTime" };
  return {
    label: spec.label,
    type: "Picklist",
    valueSet: {
      restricted: true,
      valueSetDefinition: {
        sorted: false,
        value: spec.values.map((val) => ({ valueName: val, label: val, default: false })),
      },
    },
  };
}

interface DescField {
  name: string;
  type: string;
  restrictedPicklist?: boolean;
  picklistValues?: { value: string; active: boolean }[];
}

async function main(): Promise<void> {
  const sf = SalesforceClient.fromEnv();
  await sf.login();
  console.log(`✓ connected to ${sf.getInstanceUrl()}${dryRun ? "  (dry-run)" : ""}\n`);

  let created = 0,
    skipped = 0,
    failed = 0;

  for (const [sobject, specs] of Object.entries(FIELDS)) {
    const desc = (await sf.request(`GET`, `/services/data/v${v}/sobjects/${sobject}/describe`)) as {
      fields: DescField[];
    };
    const have = new Set(desc.fields.map((f) => f.name));
    for (const spec of specs) {
      if (have.has(spec.api)) {
        console.log(`  = ${sobject}.${spec.api} (exists)`);
        skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`  + ${sobject}.${spec.api} [${spec.type}] (would create)`);
        continue;
      }
      try {
        await sf.request("POST", `/services/data/v${v}/tooling/sobjects/CustomField`, {
          FullName: `${sobject}.${spec.api}`,
          Metadata: fieldMetadata(spec),
        });
        console.log(`  + ${sobject}.${spec.api} [${spec.type}] created`);
        created++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("DUPLICATE_DEVELOPER_NAME")) {
          console.log(`  = ${sobject}.${spec.api} (exists)`);
          skipped++;
        } else {
          console.log(`  ✗ ${sobject}.${spec.api}: ${msg}`);
          failed++;
        }
      }
    }
  }

  // Existing picklists: only act if restricted AND missing values.
  const contactDesc = (await sf.request(`GET`, `/services/data/v${v}/sobjects/Contact/describe`)) as {
    fields: DescField[];
  };
  const br = contactDesc.fields.find((f) => f.name === "Buying_Role__c");
  await ensurePicklistValues(sf, "Contact", "Buying_Role", br, BUYING_ROLES, dryRun);

  const acctDesc = (await sf.request(`GET`, `/services/data/v${v}/sobjects/Account/describe`)) as {
    fields: DescField[];
  };
  const ind = acctDesc.fields.find((f) => f.name === "Industry");
  await ensureIndustryValues(sf, ind, INDUSTRIES, dryRun);

  // Grant the integration user field-level security on every custom field the
  // reconciler writes (API-created fields get NO FLS by default → "No such
  // column" on write). Done via an idempotent permission set.
  await ensureFls(sf, dryRun);

  console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

/** All custom fields the reconciler writes — must be readable+editable by the user. */
const RECONCILED_FIELDS: Record<string, string[]> = {
  Account: [
    "Demo_World_Id__c",
    "Company_Size__c",
    "Employee_Band__c",
    "Revenue_Band__c",
    "Funding_Stage__c",
    "Region__c",
    "Triggers__c",
    "Tech_Stack__c",
  ],
  Contact: ["Demo_World_Id__c", "Buying_Role__c", "Seniority__c"],
  Opportunity: [
    "Demo_World_Id__c",
    "Tier__c",
    "Billing_Term__c",
    "Complexity__c",
    "Competitors__c",
    "Win_Loss_Reason__c",
    "AE_Believed_Loss_Reason__c",
    "Price_Feedback__c",
    "Product_Feedback__c",
    "Tech_Stack_Requirements__c",
    "Win_Loss_Mode__c",
    "Account_Executive__c",
    "AE_Email__c",
    "Sales_Manager__c",
    "Original_Created_Date__c",
  ],
};

async function ensureFls(sf: SalesforceClient, dry: boolean): Promise<void> {
  const psName = "Demo_World_Integration";
  let psId = (await sf.query<{ Id: string }>(`SELECT Id FROM PermissionSet WHERE Name='${psName}'`))
    .records[0]?.Id;
  if (!psId) {
    if (dry) {
      console.log(`  ~ would create permission set ${psName} + FLS for all reconciled fields`);
      return;
    }
    psId = await sf.upsert("PermissionSet", { Name: psName, Label: "Demo World Integration" });
    console.log(`  + permission set ${psName}`);
  }
  // System permission to set CreatedDate/CreatedById on insert, so reconcile can
  // backdate the activity timeline to when each touch point happened. Requires
  // the org-level "Set Audit Fields upon Record Creation" toggle (Setup → User
  // Interface) to be ON, else this PATCH fails. Idempotent — safe to re-PATCH.
  if (dry) {
    console.log(`  ~ would grant ${psName}.PermissionsCreateAuditFields`);
  } else {
    try {
      await sf.request("PATCH", `/services/data/v${v}/sobjects/PermissionSet/${psId}`, {
        PermissionsCreateAuditFields: true,
      });
      console.log(`  ~ ${psName}.PermissionsCreateAuditFields = true`);
    } catch (e) {
      console.log(
        `  ! PermissionsCreateAuditFields: ${e instanceof Error ? e.message : e} (is "Set Audit Fields upon Record Creation" enabled in Setup → User Interface?)`,
      );
    }
  }
  const existing = new Set(
    (
      await sf.query<{ Field: string }>(`SELECT Field FROM FieldPermissions WHERE ParentId='${psId}'`)
    ).records.map((r) => r.Field),
  );
  let granted = 0;
  for (const [sobject, fields] of Object.entries(RECONCILED_FIELDS)) {
    for (const fld of fields) {
      const key = `${sobject}.${fld}`;
      if (existing.has(key)) continue;
      if (dry) {
        console.log(`  ~ would grant FLS ${key}`);
        continue;
      }
      try {
        await sf.request("POST", `/services/data/v${v}/sobjects/FieldPermissions`, {
          ParentId: psId,
          SObjectType: sobject,
          Field: key,
          PermissionsRead: true,
          PermissionsEdit: true,
        });
        granted++;
      } catch (e) {
        console.log(`  ! FLS ${key}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  // Assign the permission set to the integration user.
  const username = env("SF_USERNAME", true)!;
  const userId = (
    await sf.query<{ Id: string }>(`SELECT Id FROM User WHERE Username='${username.replace(/'/g, "\\'")}'`)
  ).records[0]?.Id;
  if (userId) {
    const assigned =
      (
        await sf.query(
          `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId='${psId}' AND AssigneeId='${userId}'`,
        )
      ).records.length > 0;
    if (!assigned && !dry) {
      await sf.upsert("PermissionSetAssignment", { PermissionSetId: psId, AssigneeId: userId });
      console.log(`  + assigned ${psName} to ${username}`);
    } else console.log(`  = ${psName} ${assigned ? "already assigned" : "(dry-run)"}`);
  }
  if (granted) console.log(`  ~ granted FLS on ${granted} field(s)`);
}

/** Add missing values to an existing CUSTOM picklist (Tooling), if restricted. */
async function ensurePicklistValues(
  sf: SalesforceClient,
  sobject: string,
  devName: string,
  f: DescField | undefined,
  want: string[],
  dry: boolean,
): Promise<void> {
  if (!f) {
    console.log(`  ! ${sobject}.${devName}__c absent — skipping value check`);
    return;
  }
  const active = new Set((f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value));
  const missing = want.filter((v2) => !active.has(v2));
  if (f.restrictedPicklist === false) {
    console.log(`  = ${sobject}.${devName}__c unrestricted — values accepted as-is`);
    return;
  }
  if (missing.length === 0) {
    console.log(`  = ${sobject}.${devName}__c has all values`);
    return;
  }
  if (dry) {
    console.log(`  ~ ${sobject}.${devName}__c would add: ${missing.join(", ")}`);
    return;
  }
  // Fetch the field's tooling record + metadata, merge values, PATCH.
  // CustomField is a Tooling-only sObject → use the Tooling query endpoint.
  const soql = `SELECT Id FROM CustomField WHERE DeveloperName='${devName}' AND TableEnumOrId='${sobject}'`;
  const q = (
    (await sf.request("GET", `/services/data/v${v}/tooling/query?q=${encodeURIComponent(soql)}`)) as {
      records: { Id: string }[];
    }
  ).records;
  if (!q.length) {
    console.log(`  ! ${sobject}.${devName}__c not found in Tooling CustomField`);
    return;
  }
  const rec = (await sf.request("GET", `/services/data/v${v}/tooling/sobjects/CustomField/${q[0]!.Id}`)) as {
    Metadata: Record<string, unknown>;
  };
  const md = rec.Metadata;
  // Replace the value set wholesale with exactly the canonical values — the
  // existing set may carry differently-cased entries (e.g. "champion") that
  // would collide on a merge. Our data only ever emits these `want` values.
  md.valueSet = {
    restricted: true,
    valueSetDefinition: {
      sorted: false,
      value: want.map((val) => ({ valueName: val, label: val, default: false })),
    },
  };
  await sf.request("PATCH", `/services/data/v${v}/tooling/sobjects/CustomField/${q[0]!.Id}`, {
    Metadata: md,
  });
  console.log(`  ~ ${sobject}.${devName}__c set to: ${want.join(", ")}`);
}

/** Add missing values to the STANDARD Industry value set via Metadata API SOAP. */
async function ensureIndustryValues(
  sf: SalesforceClient,
  f: DescField | undefined,
  want: string[],
  dry: boolean,
): Promise<void> {
  if (!f) {
    console.log(`  ! Account.Industry absent`);
    return;
  }
  const active = (f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value);
  const missing = want.filter((v2) => !active.includes(v2));
  if (f.restrictedPicklist === false) {
    console.log(`  = Account.Industry unrestricted — values accepted as-is`);
    return;
  }
  if (missing.length === 0) {
    console.log(`  = Account.Industry has all values`);
    return;
  }
  if (dry) {
    console.log(`  ~ Account.Industry would add: ${missing.join(", ")}`);
    return;
  }
  const all = [...active, ...missing];
  const values = all
    .map(
      (val) =>
        `<met:standardValue><met:fullName>${xmlEsc(val)}</met:fullName><met:label>${xmlEsc(val)}</met:label><met:default>false</met:default></met:standardValue>`,
    )
    .join("");
  const sid = (sf as unknown as { accessToken: string }).accessToken;
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header><met:SessionHeader><met:sessionId>${sid}</met:sessionId></met:SessionHeader></soapenv:Header>
  <soapenv:Body><met:updateMetadata><met:metadata xsi:type="met:StandardValueSet"><met:fullName>Industry</met:fullName>${values}</met:metadata></met:updateMetadata></soapenv:Body>
</soapenv:Envelope>`;
  const res = await fetch(`${sf.getInstanceUrl()}/services/Soap/m/${v}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: "updateMetadata" },
    body: envelope,
  });
  const xml = await res.text();
  const ok = /<success>true<\/success>/.test(xml);
  if (ok) console.log(`  ~ Account.Industry added: ${missing.join(", ")}`);
  else
    console.log(
      `  ✗ Account.Industry update failed: ${xml.match(/<message>([^<]*)<\/message>/)?.[1] ?? `HTTP ${res.status}`}`,
    );
}

const xmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
