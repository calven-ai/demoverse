/**
 * Universal emitted vocabularies with semantics the engine's samplers depend on
 * (relative price position; deal complexity). Everything else is config-driven:
 * industries/sizes/regions/bands/triggers/tech-stack/loss-reasons come from
 * world.yaml, buying roles from personas.yaml, product feedback from
 * prose.yaml `vocab.product_feedback`.
 */

export const PRICE_FEEDBACK = ["Less expensive", "On par", "More expensive"] as const;

export const COMPLEXITY = ["Low", "Medium", "High"] as const;
