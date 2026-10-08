/**
 * Move already-posted Slack threads from the controller app onto the personas'
 * own user accounts, once `SLACK_USER_TOKEN_<HANDLE>` tokens exist (client.ts).
 *
 * A thread qualifies when at least one of its posted messages was posted by the
 * app but belongs to a persona that now has a user token. The whole thread is
 * deleted (replies before the root) and queued for reconcile, which re-posts it
 * with each persona's token. Re-posts land at today's timestamp.
 *
 *   npx tsx scripts/slack-repost-as-users.ts                          # report only
 *   npx tsx scripts/slack-repost-as-users.ts --channel=#competitive   # one channel
 *   npx tsx scripts/slack-repost-as-users.ts --confirm                # delete + queue
 *   npm run apply -- --reconcile                                      # re-post
 */

import { loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { SlackClient } from "../src/connectors/slack/client.js";
import { hasEnv } from "../src/util/env.js";
import { SLACK_KINDS } from "../src/connectors/kinds.js";

const confirm = process.argv.includes("--confirm");
const channelArg = process.argv.find((a) => a.startsWith("--channel="))?.split("=")[1];
const channelFilter = channelArg ? `#${channelArg.replace(/^#/, "")}` : undefined;

async function main(): Promise<void> {
  if (!hasEnv("SLACK_BOT_TOKEN")) {
    console.log("! SLACK_BOT_TOKEN absent (.env), nothing to do");
    return;
  }
  const world = loadWorld();
  const client = SlackClient.fromEnv();

  const targets = world.artifacts.filter(
    (a) =>
      SLACK_KINDS.includes(a.kind) &&
      a.external.slackChannel &&
      (!channelFilter || a.external.slackChannel === channelFilter) &&
      a.messages?.some((m) => m.ts && !m.postedAsUser && client.postsAsUser(m.personaHandle)),
  );

  const missing = new Set<string>();
  for (const a of world.artifacts) {
    if (!SLACK_KINDS.includes(a.kind)) continue;
    for (const m of a.messages ?? [])
      if (m.ts && !client.postsAsUser(m.personaHandle)) missing.add(m.personaHandle);
  }

  for (const a of targets) {
    const handles = [...new Set(a.messages!.map((m) => m.personaHandle))].join(", ");
    console.log(`  ${a.id}  ${a.external.slackChannel}  ${a.messages!.length} msg(s)  ${handles}`);
  }
  console.log(`\n${confirm ? "re-queueing" : "would re-queue"} ${targets.length} thread(s)`);
  if (missing.size > 0) {
    console.log(
      `personas with posted messages but no user token (stay app-posted): ${[...missing].sort().join(", ")}`,
    );
  }
  if (!confirm) {
    if (targets.length > 0) console.log("pass --confirm to delete and queue them for re-post");
    return;
  }

  let deleted = 0;
  for (const a of targets) {
    const channelId = await client.channelId(a.external.slackChannel!);
    // Delete replies before the thread root: deleting a parent orphans its replies.
    for (const msg of [...a.messages!].reverse()) {
      if (!msg.ts) continue;
      await client.deleteMessage(channelId, msg.ts, msg.postedAsUser ? msg.personaHandle : undefined);
      delete msg.ts;
      delete msg.postedAsUser;
      deleted++;
    }
    delete a.external.slackThreadTs;
    a.status = "generated"; // reconcile re-posts the whole thread
  }
  saveWorld(world);
  console.log(`deleted ${deleted} message(s); run \`npm run apply -- --reconcile\` to re-post`);
}

void main();
