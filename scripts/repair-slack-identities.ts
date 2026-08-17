/**
 * One-off, idempotent repair: re-resolve every stored Slack message's persona
 * display name and avatar against the current roster.
 *
 * Messages whose `personaHandle` did not resolve were stored with the raw handle as
 * the display name and no avatar, so they posted as "@dana.pmm" with the controller
 * app's own icon instead of "Dana Alvarez (Head of Product Marketing)" with a profile
 * picture. The resolver now normalizes handles (src/generation/ingest.ts), which fixes
 * new ingests. This brings already-ingested artifacts up to parity.
 *
 * Slack cannot change a message's username or icon on chat.update: that pair is baked
 * in at post time. So an already-posted message can only be corrected by deleting and
 * re-posting it, which is opt-in (`--repost`) because the re-post lands at today's
 * timestamp and loses the original post date.
 *
 *   npx tsx scripts/repair-slack-identities.ts             # report only, no writes
 *   npx tsx scripts/repair-slack-identities.ts --confirm   # repair the ledger
 *   npx tsx scripts/repair-slack-identities.ts --confirm --repost
 *                                                          # also delete the posted
 *                                                            copies and queue them
 *                                                            for the next reconcile
 */

import { loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { loadConfig } from "../src/config/load.js";
import { personaResolver, normalizeHandle } from "../src/generation/ingest.js";
import { SlackClient } from "../src/connectors/slack/client.js";
import { hasEnv } from "../src/util/env.js";
import { SLACK_KINDS } from "../src/connectors/kinds.js";

const confirm = process.argv.includes("--confirm");
const repost = process.argv.includes("--repost");

async function main(): Promise<void> {
  const world = loadWorld();
  const cfg = loadConfig();
  const resolve = personaResolver(world, cfg);

  const stale: { artifactId: string; posted: boolean; changes: string[] }[] = [];
  const unresolved = new Set<string>();

  for (const artifact of world.artifacts) {
    if (!SLACK_KINDS.includes(artifact.kind) || !artifact.messages?.length) continue;
    const changes: string[] = [];
    for (const msg of artifact.messages) {
      const persona = resolve(msg.personaHandle);
      if (!persona) {
        unresolved.add(msg.personaHandle);
        continue; // not on the roster, so not repairable here; reported below
      }
      if (msg.personaDisplay === persona.display && msg.avatar === persona.avatar) continue;
      changes.push(`${msg.personaHandle} -> ${persona.display}${persona.avatar ? " +avatar" : ""}`);
      if (confirm) {
        msg.personaHandle = normalizeHandle(msg.personaHandle);
        msg.personaDisplay = persona.display;
        msg.avatar = persona.avatar;
      }
    }
    if (changes.length === 0) continue;
    stale.push({
      artifactId: artifact.id,
      posted: artifact.messages.some((m) => m.ts),
      changes,
    });
  }

  for (const s of stale) {
    console.log(`  ${s.artifactId}${s.posted ? "  [posted to Slack]" : ""}`);
    for (const c of [...new Set(s.changes)]) console.log(`      ${c}`);
  }
  if (unresolved.size > 0) {
    console.log(`\n! handle(s) not on the roster, left as-is: ${[...unresolved].join(", ")}`);
  }

  const postedCount = stale.filter((s) => s.posted).length;
  console.log(
    `\n${confirm ? "repaired" : "would repair"} ${stale.length} artifact(s); ${postedCount} already posted to Slack`,
  );

  if (!repost || postedCount === 0) {
    if (postedCount > 0) {
      console.log(
        "posted copies keep their old name and icon (Slack cannot edit those). Pass --repost to redo them.",
      );
    }
    if (confirm) saveWorld(world);
    return;
  }

  if (!confirm) {
    console.log("\n(--repost needs --confirm; nothing deleted)");
    return;
  }
  if (!hasEnv("SLACK_BOT_TOKEN")) {
    console.log("\n! SLACK_BOT_TOKEN absent (.env), so the posted copies were left alone");
    saveWorld(world);
    return;
  }

  const client = SlackClient.fromEnv();
  let deleted = 0;
  for (const s of stale.filter((x) => x.posted)) {
    const artifact = world.artifacts.find((a) => a.id === s.artifactId)!;
    const channelName = artifact.external.slackChannel;
    if (!channelName) continue;
    const channelId = await client.channelId(channelName);
    // Delete replies before the thread root: deleting a parent orphans its replies.
    for (const msg of [...artifact.messages!].reverse()) {
      if (!msg.ts) continue;
      await client.deleteMessage(channelId, msg.ts);
      delete msg.ts;
      deleted++;
    }
    delete artifact.external.slackThreadTs;
    artifact.status = "generated"; // the next reconcile re-posts the whole thread
  }
  console.log(
    `deleted ${deleted} posted message(s). Run \`npm run apply -- --ingest --reconcile\` to re-post.`,
  );
  saveWorld(world);
}

void main();
