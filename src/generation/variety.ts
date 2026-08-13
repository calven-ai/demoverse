/**
 * Seeded prose-variety axes. See DESIGN.md §7.1 (grounded prompts).
 *
 * The structural facts of a deal (competitors, reason, amounts) are grounded by
 * the ledger; but when one LLM writes hundreds of deals it converges on the same
 * NARRATIVE and the same pet phrases. These axes give every deal a distinct,
 * deterministic texture the prompt builders inject next to the fact block.
 *
 * The axis TEXT lives in `config/prose.yaml` (the story banks); this module
 * owns only the deterministic draw logic.
 *
 * Determinism contract: every draw here uses a FRESH Rng stream keyed on
 * `${seed}|variety|…` / `${seed}|shape|…` / `${seed}|cast|…`. Nothing consumes
 * from the streams advance.ts uses, so adding/changing axes never disturbs the
 * simulated world — only the prompts. Within prose.yaml, ORDER matters: draws
 * are seeded picks over the arrays, so reordering entries re-textures deals.
 */

import { Rng } from "../util/rng.js";
import type { Artifact } from "../ledger/schema.js";
import type { ProseConfig } from "../config/schema.js";

export interface DealVariety {
  narrativeAngle: string;
  buyerTone: string;
  objections: string[];
  timelinePressure: string;
}

/** One stable draw per deal — identical across all of the deal's artifacts. */
export function dealVariety(seed: string, dealId: string, prose: ProseConfig): DealVariety {
  const rng = new Rng(`${seed}|variety|${dealId}`);
  const objectionCount = rng.chance(0.4) ? 2 : 1;
  return {
    narrativeAngle: rng.pick(prose.narrative_angles),
    buyerTone: rng.pick(prose.buyer_tones),
    objections: rng.shuffle(prose.objection_themes).slice(0, objectionCount),
    timelinePressure: rng.pick(prose.timeline_pressures),
  };
}

/** Render the per-deal variety block the prompt builders insert after the facts. */
export function varietyBlock(seed: string, dealId: string, prose: ProseConfig): string {
  const v = dealVariety(seed, dealId, prose);
  return [
    "VARIETY (this deal's specific texture — keep it consistent across ALL of this deal's artifacts):",
    `- Backstory / why they're looking: ${v.narrativeAngle}`,
    `- Buying-group communication style: ${v.buyerTone}`,
    `- Live objection(s) the rep must handle: ${v.objections.join("; ")}`,
    `- Timeline: ${v.timelinePressure}`,
  ].join("\n");
}

// --- Per-artifact structural shapes ------------------------------------------
// One draw per ARTIFACT (not per deal), so the same deal's two AE notes or two
// calls don't share a template either.

/** How each kind's drawn shape line is labeled in the prompt. */
const SHAPE_LABEL: Record<string, string> = {
  call_transcript: "Call texture: ",
  ae_note: "",
  survey: "Respondent style: ",
  interview: "Respondent mood: ",
  email_exchange: "Thread texture: ",
  slack_deal_thread: "Thread texture: ",
};

/** A seeded structural variant for one artifact; empty string when a kind has no bank. */
export function artifactShape(seed: string, artifact: Artifact, prose: ProseConfig): string {
  const bank = prose.artifact_shapes[artifact.kind];
  if (!bank || bank.length === 0) return "";
  const rng = new Rng(`${seed}|shape|${artifact.id}`);
  return `${SHAPE_LABEL[artifact.kind] ?? ""}${rng.pick(bank)}`;
}

/** Seeded subset of items (used to rotate the internal-Slack cast per artifact). */
export function castSubset<T>(
  seed: string,
  artifactId: string,
  items: readonly T[],
  min: number,
  max: number,
): T[] {
  const rng = new Rng(`${seed}|cast|${artifactId}`);
  const n = Math.min(items.length, rng.int(min, max));
  return rng.shuffle(items).slice(0, n);
}

// --- Anti-repetition blocklist ------------------------------------------------
// A STATIC curated list in prose.yaml (a live scan of state/content would make
// prompts depend on generation order — non-reproducible). Promote new offenders
// there as `npm run lint -- --repetition` surfaces them.

/** The prompt rule rendering the blocklist; empty string when the list is empty. */
export function bannedPhrasesRule(prose: ProseConfig): string {
  if (prose.banned_phrases.length === 0) return "";
  return `- Do NOT use any of these phrases (overused across other deals): ${prose.banned_phrases.join("; ")}.`;
}
