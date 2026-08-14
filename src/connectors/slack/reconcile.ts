/**
 * Reconcile Slack artifacts (deal threads, win-loss post-mortems, competitive
 * questions) into the dedicated workspace. Each persona message is posted under
 * its own username; the root thread ts and per-message ts are recorded so
 * re-runs update messages in place rather than duplicating threads.
 */

import { hasEnv } from "../../util/env.js";
import type { World } from "../../ledger/schema.js";
import {
  type Connector,
  type ReconcileOptions,
  type ReconcileStats,
  emptyStats,
  disabledStats,
} from "../types.js";
import type { Config } from "../../config/schema.js";
import { CohortIndex } from "../../cohort.js";
import { SlackClient } from "./client.js";
import { SLACK_KINDS } from "../kinds.js";

export async function reconcileSlack(
  world: World,
  cfg: Config,
  opts: ReconcileOptions,
): Promise<ReconcileStats> {
  if (!cfg.connectors.slack.enabled) return disabledStats("slack");
  // Artifact kind → channel, from config/connectors.yaml.
  const channelByKind = cfg.connectors.slack.channels;
  const stats = emptyStats("slack");

  // The demo Slack workspace is reserved for deals the operator adds week by
  // week (`weekly` cohort members). The one-time `seed` backfill deliberately
  // posts nothing: its volume would bury the handful of live threads that are
  // the point of the Slack story. Seed deals that were planted with Slack
  // artifacts before the cohort existed keep them in the repo, unpublished.
  const cohort = opts.cohort ?? new CohortIndex();

  const pending = world.artifacts.filter(
    (a) =>
      SLACK_KINDS.includes(a.kind) &&
      a.status === "generated" &&
      a.messages &&
      a.messages.length > 0 &&
      cohort.allowsSlack(a.dealId) &&
      (!opts.oppId || a.dealId === opts.oppId),
  );
  if (pending.length === 0) {
    stats.note = cohort.active
      ? "no generated slack artifacts for weekly cohort members"
      : "no generated slack artifacts to reconcile";
    return stats;
  }

  if (!hasEnv("SLACK_BOT_TOKEN")) {
    stats.disabled = true;
    stats.note = "Slack credentials absent (.env), skipped";
    stats.skipped = pending.length;
    return stats;
  }

  if (opts.dryRun) {
    stats.note = "dry-run";
    stats.skipped = pending.length;
    return stats;
  }

  const client = SlackClient.fromEnv();

  for (const artifact of pending) {
    try {
      const channelName = channelByKind[artifact.kind] ?? cfg.connectors.slack.fallback_channel;
      const channelId = await client.channelId(channelName);
      let threadTs = artifact.external.slackThreadTs;

      for (const [i, msg] of artifact.messages!.entries()) {
        if (msg.ts) {
          await client.update(channelId, msg.ts, msg.text);
          stats.updated++;
        } else {
          const ts = await client.post(channelId, msg.text, {
            username: msg.personaDisplay,
            avatar: msg.avatar,
            threadTs: i === 0 ? undefined : threadTs,
          });
          msg.ts = ts;
          if (i === 0) threadTs = ts; // first message roots the thread
          stats.created++;
        }
      }

      artifact.external.slackChannel = channelName;
      artifact.external.slackThreadTs = threadTs;
      artifact.status = "reconciled";
    } catch (e) {
      stats.errors.push({ entity: artifact.id, message: (e as Error).message });
    }
  }
  return stats;
}

export const slackConnector: Connector = { name: "slack", reconcile: reconcileSlack };
