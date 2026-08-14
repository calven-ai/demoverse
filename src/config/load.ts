/** Load + validate all Tier-1 config with friendly, located errors. */

import { z } from "zod";
import { readYaml, repoPath, fileExists } from "../util/fs.js";
import { DRIVE_FILE_KINDS, SLACK_KINDS } from "../connectors/kinds.js";
import {
  WorldConfigSchema,
  CompetitorsConfigSchema,
  SurveysConfigSchema,
  SlackPersonasConfigSchema,
  IcpConfigSchema,
  PersonasConfigSchema,
  SalesTeamConfigSchema,
  ProductConfigSchema,
  UseCasesConfigSchema,
  ProseConfigSchema,
  ConnectorsConfigSchema,
  type Config,
} from "./schema.js";

class ConfigError extends Error {
  constructor(file: string, issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`);
    super(`Invalid config in ${file}:\n${lines.join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Where an operator's filled config lives. Tests point elsewhere (see below). */
export const DEFAULT_CONFIG_DIR = "config";

function loadOne<S extends z.ZodTypeAny>(dir: string, file: string, schema: S): z.infer<S> {
  const path = repoPath(dir, file);
  if (!fileExists(path)) {
    throw new Error(
      `Missing config file: ${dir}/${file}. Copy config/templates/${file} to config/ and fill it in ` +
        `(the /setup wizard does this interactively; see docs/getting-started.md).`,
    );
  }
  const raw = readYaml(path);
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(`${dir}/${file}`, result.error.issues);
  return result.data;
}

/**
 * Load and validate the full Tier-1 config bundle. Throws on any error.
 *
 * `dir` is repo-relative and defaults to the operator's `config/`. The test
 * suite passes `config/templates` instead, so a contributor can run `npm test`
 * on a fresh clone (where `config/` holds only templates), and so an operator's
 * own world can never make the shipped tests fail.
 */
export function loadConfig(dir: string = DEFAULT_CONFIG_DIR): Config {
  const world = loadOne(dir, "world.yaml", WorldConfigSchema);
  const competitors = loadOne(dir, "competitors.yaml", CompetitorsConfigSchema);
  const surveys = loadOne(dir, "surveys.yaml", SurveysConfigSchema);
  const slackPersonas = loadOne(dir, "slack-personas.yaml", SlackPersonasConfigSchema);
  const icp = loadOne(dir, "icp.yaml", IcpConfigSchema);
  const personas = loadOne(dir, "personas.yaml", PersonasConfigSchema);
  const salesTeam = loadOne(dir, "sales-team.yaml", SalesTeamConfigSchema);
  const product = loadOne(dir, "product.yaml", ProductConfigSchema);
  const useCases = loadOne(dir, "use-cases.yaml", UseCasesConfigSchema);
  const prose = loadOne(dir, "prose.yaml", ProseConfigSchema);
  const connectors = loadOne(dir, "connectors.yaml", ConnectorsConfigSchema);

  const cfg = {
    world,
    useCases,
    competitors,
    surveys,
    slackPersonas,
    icp,
    personas,
    salesTeam,
    product,
    prose,
    connectors,
  };
  validateCrossRefs(cfg);
  return cfg;
}

/** A few sanity checks that span multiple files. */
function validateCrossRefs(cfg: Config): void {
  const warnings: string[] = [];

  // Slack channels referenced in posts should exist in the channel list.
  const modeSum =
    cfg.world.winloss.mode_mix.interview +
    cfg.world.winloss.mode_mix.survey +
    cfg.world.winloss.mode_mix.none;
  if (Math.abs(modeSum - 1) > 0.001) {
    warnings.push(`winloss.mode_mix sums to ${modeSum.toFixed(3)}, expected ~1.0 (it will be normalized).`);
  }

  // Use-case domains must speak the product_modules vocabulary. The win-loss
  // surveys report product_module, so a drifted label would split one concept
  // into two in the downstream analysis.
  const modules = new Set(cfg.world.company.product_modules);
  for (const uc of cfg.useCases.use_cases) {
    if (!modules.has(uc.domain)) {
      warnings.push(
        `use-cases.yaml "${uc.name}" has domain "${uc.domain}" which is not in world.yaml company.product_modules.`,
      );
    }
  }
  // Competitor weights must name real competitors, or the skew silently no-ops.
  const competitorNames = new Set(cfg.competitors.competitors.map((c) => c.name));
  for (const uc of cfg.useCases.use_cases) {
    for (const name of Object.keys(uc.competitor_weights)) {
      if (!competitorNames.has(name)) {
        warnings.push(`use-cases.yaml "${uc.name}" weights unknown competitor "${name}".`);
      }
    }
  }

  // Every destination-bound artifact kind needs its connectors.yaml mapping,
  // and every open pipeline stage needs a Salesforce StageName. A missing entry
  // falls back at runtime (Misc folder / fallback channel / first stage), which
  // is survivable but almost never intended.
  for (const kind of DRIVE_FILE_KINDS) {
    if (!cfg.connectors.drive.folders[kind]) {
      warnings.push(`connectors.yaml drive.folders is missing "${kind}" (files would land in "Misc").`);
    }
  }
  for (const kind of SLACK_KINDS) {
    if (!cfg.connectors.slack.channels[kind]) {
      warnings.push(
        `connectors.yaml slack.channels is missing "${kind}" (posts would land in ${cfg.connectors.slack.fallback_channel}).`,
      );
    }
  }
  for (const stage of cfg.world.pipeline.stages) {
    if (stage === "Closed") continue; // mapped from deal status, not stage
    if (!cfg.connectors.salesforce.stage_map[stage]) {
      warnings.push(`connectors.yaml salesforce.stage_map is missing pipeline stage "${stage}".`);
    }
  }

  // A competitor's typical loss reasons must exist in the loss-reason
  // vocabulary, or its skew silently no-ops and the data quietly flattens.
  const lossReasons = new Set(Object.keys(cfg.world.winloss.loss_reasons));
  for (const c of cfg.competitors.competitors) {
    for (const reason of c.typical_loss_reasons) {
      if (!lossReasons.has(reason)) {
        warnings.push(
          `competitors.yaml "${c.name}" typical_loss_reason "${reason}" is not in world.yaml winloss.loss_reasons.`,
        );
      }
    }
  }

  // Rep personas should line up with sales-team members by display name.
  const repNames = new Set([...cfg.salesTeam.managers, ...cfg.salesTeam.ics].map((r) => r.name));
  for (const p of cfg.slackPersonas.rep_personas) {
    if (!repNames.has(p.display)) {
      warnings.push(
        `slack-personas.yaml rep_persona "${p.display}" has no matching member in sales-team.yaml (cross-system identity will break).`,
      );
    }
  }

  // Every IC must report to a real manager; ids must be unique across the org.
  const managerIds = new Set(cfg.salesTeam.managers.map((m) => m.id));
  const allIds = [...cfg.salesTeam.managers, ...cfg.salesTeam.ics].map((r) => r.id);
  if (new Set(allIds).size !== allIds.length) warnings.push(`sales-team.yaml has duplicate member ids.`);
  for (const ic of cfg.salesTeam.ics) {
    if (!managerIds.has(ic.reports_to)) {
      warnings.push(
        `sales-team.yaml IC "${ic.name}" reports_to "${ic.reports_to}" which is not a manager id.`,
      );
    }
  }

  // Select questions must source their options from somewhere, and the
  // product_modules question needs a non-empty company module list to draw on.
  const hasModules = cfg.world.company.product_modules.length > 0;
  for (const [outcome, survey] of [
    ["win", cfg.surveys.win],
    ["loss", cfg.surveys.loss],
  ] as const) {
    for (const group of survey.groups) {
      for (const q of group.questions) {
        const needsOptions = q.type === "single_select" || q.type === "multi_select";
        if (needsOptions && !q.options?.length && !q.options_from && !q.options_from_config) {
          warnings.push(
            `surveys.yaml ${outcome} question "${q.id}" is type=${q.type} but has no options source.`,
          );
        }
        if (q.options_from_config === "product_modules" && !hasModules) {
          warnings.push(
            `surveys.yaml ${outcome} question "${q.id}" sources product_modules, but world.yaml company.product_modules is empty.`,
          );
        }
      }
    }
  }

  // Per-stage call attendees must reference real persona roles and real stages.
  {
    const personaRoles = new Set(cfg.personas.personas.map((p) => p.role));
    const stages = new Set(cfg.world.pipeline.stages);
    for (const [stage, roles] of Object.entries(cfg.personas.attendees_by_stage)) {
      if (!stages.has(stage)) {
        warnings.push(
          `personas.yaml attendees_by_stage has stage "${stage}" not in world.yaml pipeline.stages.`,
        );
      }
      for (const role of roles) {
        if (!personaRoles.has(role)) {
          warnings.push(`personas.yaml attendees_by_stage.${stage} role "${role}" has no matching persona.`);
        }
      }
    }
  }

  // Market-intelligence cohort references must resolve to real entities.
  const mi = cfg.world.market_intelligence;
  if (mi) {
    const competitorNames = new Set(cfg.competitors.competitors.map((c) => c.name));
    if (!competitorNames.has(mi.competitor)) {
      warnings.push(
        `world.yaml market_intelligence.competitor "${mi.competitor}" is not in competitors.yaml.`,
      );
    }
    const personaRoles = new Set(cfg.personas.personas.map((p) => p.role));
    for (const role of [mi.primary_role, ...mi.driver_roles]) {
      if (!personaRoles.has(role)) {
        warnings.push(
          `world.yaml market_intelligence role "${role}" has no matching persona in personas.yaml.`,
        );
      }
    }
    if (!mi.driver_roles.includes(mi.primary_role)) {
      warnings.push(
        `world.yaml market_intelligence.primary_role "${mi.primary_role}" should also be listed in driver_roles.`,
      );
    }
    // MI firmographic bands must be a subset of the Enterprise bands (coherence).
    const ent = cfg.world.segments.by_size["Enterprise"];
    if (ent) {
      const check = (label: string, mine: Record<string, number>, base: Record<string, number>) => {
        for (const k of Object.keys(mine)) {
          if (!(k in base)) {
            warnings.push(
              `world.yaml market_intelligence.firmographics.${label} "${k}" is not a segments.by_size.Enterprise band (accounts would be incoherent).`,
            );
          }
        }
      };
      check("employee_bands", mi.firmographics.employee_bands, ent.employee_bands);
      check("revenue_bands", mi.firmographics.revenue_bands, ent.revenue_bands);
      check("funding_stages", mi.firmographics.funding_stages, ent.funding_stages);
    }
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`⚠️  config: ${w}`);
  }
}
