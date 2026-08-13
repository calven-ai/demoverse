/**
 * Which artifact kinds each destination carries. Shared by the reconcilers,
 * the config cross-validation (every kind here must have a folder/channel
 * mapping in connectors.yaml), and the tests — without dragging the heavy API
 * clients into config loading.
 */

import type { Artifact } from "../ledger/schema.js";

/** File-based artifacts that reconcile into Drive. */
export const DRIVE_FILE_KINDS: Artifact["kind"][] = [
  "call_transcript",
  "survey",
  "interview",
  "internal_collateral",
  "ae_note",
];

/** Chat artifacts that reconcile into Slack. */
export const SLACK_KINDS: Artifact["kind"][] = ["slack_deal_thread", "winloss_post", "competitive_q"];
