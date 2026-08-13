import type { HubSpotClient, HubSpotObjectType, HubSpotPropertySpec } from "./client.js";

const text = (
  groupName: string,
  name: string,
  label: string,
  description: string,
  hasUniqueValue = false,
): HubSpotPropertySpec => ({
  groupName,
  name,
  label,
  description,
  hasUniqueValue,
  type: "string",
  fieldType: "text",
});

const datetime = (
  groupName: string,
  name: string,
  label: string,
  description: string,
): HubSpotPropertySpec => ({
  groupName,
  name,
  label,
  description,
  type: "datetime",
  fieldType: "date",
});

const notice = (group: string, description: string) =>
  text(group, "demo_world_notice", "Demo World Notice", description);

export const HUBSPOT_PROPERTIES: Record<HubSpotObjectType, HubSpotPropertySpec[]> = {
  companies: [
    text(
      "companyinformation",
      "demo_world_id",
      "Demo World ID",
      "Stable demo-world source identifier.",
      true,
    ),
    notice(
      "companyinformation",
      "Notes that this is a real target account with a synthetic sales pipeline layered on top for CRM-connector testing.",
    ),
    text(
      "companyinformation",
      "demo_world_source",
      "Demo World Source",
      'Provenance of this account: the prospect list it came from, or "synthetic" if not drawn from a real target list.',
    ),
    text("companyinformation", "demo_world_industry", "Demo Industry", "Synthetic industry segment."),
    text(
      "companyinformation",
      "demo_world_company_size",
      "Demo Company Size",
      "Synthetic company-size segment.",
    ),
    text(
      "companyinformation",
      "demo_world_employee_band",
      "Demo Employee Band",
      "Synthetic employee-count band.",
    ),
    text(
      "companyinformation",
      "demo_world_revenue_band",
      "Demo Revenue Band",
      "Synthetic annual-revenue band.",
    ),
    text("companyinformation", "demo_world_funding_stage", "Demo Funding Stage", "Synthetic funding stage."),
    text("companyinformation", "demo_world_region", "Demo Region", "Synthetic sales region."),
    text(
      "companyinformation",
      "demo_world_triggers",
      "Demo Buying Triggers",
      "Semicolon-separated synthetic buying triggers.",
    ),
    text(
      "companyinformation",
      "demo_world_tech_stack",
      "Demo Tech Stack",
      "Semicolon-separated synthetic technology stack.",
    ),
  ],
  contacts: [
    text(
      "contactinformation",
      "demo_world_id",
      "Demo World ID",
      "Stable demo-world source identifier.",
      true,
    ),
    notice("contactinformation", "Marks clearly-fabricated data created for integration testing."),
    text("contactinformation", "demo_world_buying_role", "Demo Buying Role", "Synthetic buying-group role."),
    text("contactinformation", "demo_world_seniority", "Demo Seniority", "Synthetic contact seniority."),
  ],
  deals: [
    text("dealinformation", "demo_world_id", "Demo World ID", "Stable demo-world source identifier.", true),
    notice("dealinformation", "Marks clearly-fabricated data created for integration testing."),
    text(
      "dealinformation",
      "demo_world_source_stage",
      "Demo Source Stage",
      "Synthetic source pipeline stage.",
    ),
    text(
      "dealinformation",
      "demo_world_source_status",
      "Demo Source Status",
      "Synthetic source opportunity status.",
    ),
    text("dealinformation", "demo_world_tier", "Demo Tier", "Synthetic product tier."),
    text(
      "dealinformation",
      "demo_world_billing_term",
      "Demo Billing Term",
      "Synthetic contract billing term.",
    ),
    text("dealinformation", "demo_world_complexity", "Demo Complexity", "Synthetic deal complexity."),
    text(
      "dealinformation",
      "demo_world_competitors",
      "Demo Competitors",
      "Semicolon-separated synthetic deal competitors.",
    ),
    text(
      "dealinformation",
      "demo_world_win_loss_reason",
      "Demo Win/Loss Reason",
      "Synthetic buyer-reported outcome reason.",
    ),
    text(
      "dealinformation",
      "demo_world_ae_loss_reason",
      "Demo AE Loss Reason",
      "Synthetic account-executive belief about the loss.",
    ),
    text("dealinformation", "demo_world_price_feedback", "Demo Price Feedback", "Synthetic price feedback."),
    text(
      "dealinformation",
      "demo_world_product_feedback",
      "Demo Product Feedback",
      "Semicolon-separated synthetic product feedback.",
    ),
    text(
      "dealinformation",
      "demo_world_tech_requirements",
      "Demo Tech Requirements",
      "Semicolon-separated synthetic technology requirements.",
    ),
    text(
      "dealinformation",
      "demo_world_win_loss_mode",
      "Demo Win/Loss Mode",
      "Synthetic win/loss research mode.",
    ),
    text(
      "dealinformation",
      "demo_world_account_executive",
      "Demo Account Executive",
      "Synthetic deal owner name.",
    ),
    text("dealinformation", "demo_world_ae_email", "Demo AE Email", "Synthetic deal owner email."),
    text("dealinformation", "demo_world_sales_manager", "Demo Sales Manager", "Synthetic manager name."),
    datetime(
      "dealinformation",
      "demo_world_original_created_at",
      "Demo Original Created At",
      "Synthetic source creation timestamp.",
    ),
  ],
};

export async function ensureHubSpotSchema(
  client: HubSpotClient | undefined,
  options: { dryRun?: boolean; log?: (message: string) => void } = {},
): Promise<{ created: number; existing: number }> {
  const log = options.log ?? (() => undefined);
  let created = 0;
  let existing = 0;

  for (const [objectType, specs] of Object.entries(HUBSPOT_PROPERTIES) as [
    HubSpotObjectType,
    HubSpotPropertySpec[],
  ][]) {
    for (const spec of specs) {
      if (options.dryRun) {
        log(`  ~ ${objectType}.${spec.name}`);
        continue;
      }
      if (!client) throw new Error("HubSpot client is required outside dry-run mode");
      const result = await client.ensureProperty(objectType, spec);
      if (result === "created") created++;
      else existing++;
      log(`  ${result === "created" ? "+" : "="} ${objectType}.${spec.name} (${result})`);
    }
  }
  return { created, existing };
}
