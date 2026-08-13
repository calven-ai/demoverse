/**
 * Slack controller-app client. See DESIGN.md §9.
 *
 * ONE controller app posts every message under a per-message username + avatar
 * via chat:write.customize, rendering an unlimited roster of "people" from one
 * app (free Slack caps installed apps at 10). Channel ids are resolved + cached;
 * the app self-joins public channels it needs.
 */

import { WebClient, type ChatPostMessageArguments } from "@slack/web-api";
import { env } from "../../util/env.js";

export interface PostOptions {
  username: string;
  avatar?: string; // raw emoji is ignored; :emoji: -> icon_emoji, http(s) -> icon_url
  threadTs?: string;
}

export class SlackClient {
  private web: WebClient;
  private channelCache = new Map<string, string>();

  constructor(token: string) {
    this.web = new WebClient(token);
  }

  static fromEnv(): SlackClient {
    return new SlackClient(env("SLACK_BOT_TOKEN", true)!);
  }

  /** Resolve "#deals" or "deals" to a channel id, joining if needed. Cached. */
  async channelId(name: string): Promise<string> {
    const clean = name.replace(/^#/, "");
    const cached = this.channelCache.get(clean);
    if (cached) return cached;

    let cursor: string | undefined;
    do {
      const res = await this.web.conversations.list({
        types: "public_channel",
        limit: 200,
        cursor,
        exclude_archived: true,
      });
      for (const ch of res.channels ?? []) {
        if (ch.name === clean && ch.id) {
          this.channelCache.set(clean, ch.id);
          if (!ch.is_member) await this.web.conversations.join({ channel: ch.id }).catch(() => {});
          return ch.id;
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new Error(`Slack channel #${clean} not found. Create it in the workspace (RUNBOOK §Setup).`);
  }

  private iconFields(avatar?: string): { icon_emoji?: string; icon_url?: string } {
    if (!avatar) return {};
    if (/^https?:\/\//.test(avatar)) return { icon_url: avatar };
    if (/^:.+:$/.test(avatar)) return { icon_emoji: avatar };
    return {}; // raw unicode emoji can't be used as an icon; username only
  }

  /** Post a message as a persona. Returns the message ts. */
  async post(channelId: string, text: string, opts: PostOptions): Promise<string> {
    const args = {
      channel: channelId,
      text,
      username: opts.username,
      thread_ts: opts.threadTs,
      ...this.iconFields(opts.avatar),
    } as unknown as ChatPostMessageArguments;
    const res = await this.web.chat.postMessage(args);
    return res.ts!;
  }

  /** Update a previously-posted message in place (idempotent re-runs). */
  async update(channelId: string, ts: string, text: string): Promise<void> {
    await this.web.chat.update({ channel: channelId, ts, text });
  }

  /** Delete a previously-posted message (used to re-post under a changed
   * username/avatar — Slack can't change those on chat.update). */
  async deleteMessage(channelId: string, ts: string): Promise<void> {
    await this.web.chat.delete({ channel: channelId, ts }).catch(() => {});
  }

  /** Smoke test: post -> delete a temp message (Phase A). */
  async smokeTest(channelName: string): Promise<void> {
    const ch = await this.channelId(channelName);
    const ts = await this.post(ch, "smoke test — please ignore", { username: "Demo-World Bot" });
    await this.web.chat.delete({ channel: ch, ts }).catch(() => {});
  }
}
