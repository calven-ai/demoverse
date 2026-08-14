/**
 * Provision real Salesforce Users for the deal-owning AEs, so each Opportunity
 * can be OWNED by its account executive (OwnerId).
 *
 * The owners are the operator's own admin users (config/sales-team.yaml):
 *   - an existing user is REUSED when one already has the rep's email;
 *   - otherwise a new System Administrator is created with that email, a real
 *     account, so Salesforce sends the usual activation email.
 *
 * Idempotent: reused on re-runs.
 */

import type { World } from "../../ledger/schema.js";
import type { SalesforceClient } from "./client.js";

export interface UsersResult {
  created: number;
  reused: number;
}

const soqlStr = (s: string) => s.replace(/'/g, "\\'");

export async function ensureAeUsers(client: SalesforceClient, world: World): Promise<UsersResult> {
  const result: UsersResult = { created: 0, reused: 0 };
  const ics = world.reps.filter((r) => r.role === "ic");
  if (ics.length === 0) return result;

  // 1. Profile for any new admin users we create.
  const adminProfileId = (
    await client.query<{ Id: string }>("SELECT Id FROM Profile WHERE Name='System Administrator' LIMIT 1")
  ).records[0]?.Id;
  if (!adminProfileId) throw new Error("No 'System Administrator' profile found.");
  const orgId = (await client.query<{ Id: string }>("SELECT Id FROM Organization LIMIT 1")).records[0]!.Id;

  // 2. For each owner: reuse the existing user with that email, else create one.
  for (const rep of ics) {
    const found = (
      await client.query<{ Id: string }>(
        `SELECT Id FROM User WHERE Email='${soqlStr(rep.email)}' AND IsActive=true LIMIT 1`,
      )
    ).records[0];
    if (found) {
      rep.external.salesforceId = found.Id;
      result.reused++;
      continue;
    }
    const [first, ...rest] = rep.name.split(" ");
    const last = rest.length ? rest.join(" ") : first!;
    const base: Record<string, unknown> = {
      Email: rep.email,
      FirstName: rest.length ? first : undefined,
      LastName: last,
      Alias:
        rep.email
          .split("@")[0]!
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 8) || "user",
      ProfileId: adminProfileId,
      TimeZoneSidKey: "America/Los_Angeles",
      LocaleSidKey: "en_US",
      EmailEncodingKey: "UTF-8",
      LanguageLocaleKey: "en_US",
      IsActive: true,
    };
    let id: string;
    try {
      id = await client.upsert("User", { ...base, Username: rep.email });
    } catch (e) {
      // Username must be globally unique across all Salesforce. Fall back.
      if (String((e as Error).message).includes("DUPLICATE_USERNAME")) {
        const [lp, dom] = rep.email.split("@");
        id = await client.upsert("User", { ...base, Username: `${lp}.${orgId.toLowerCase()}@${dom}` });
      } else throw e;
    }
    rep.external.salesforceId = id;
    result.created++;
  }
  return result;
}
