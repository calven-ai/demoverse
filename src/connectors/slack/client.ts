/**
 * Slack controller-app client. See docs/architecture.md#connectors.
 *
 * ONE controller app posts every message under a per-message username + avatar
 * via chat:write.customize, rendering an unlimited roster of "people" from one
 * app (free Slack caps installed apps at 10). Channel ids are resolved + cached;
 * the app self-joins public channels it needs.
 *
 * Optional per-persona USER tokens (`SLACK_USER_TOKEN_<HANDLE>`, xoxp-...): when a
 * persona has one, its messages are posted as that real workspace member instead
 * of by the app. Some Slack consumers ignore every app-posted message (anything
 * carrying a bot_id), so persona chatter they must read has to come from users.
 * A user-posted message renders with the member's own name and profile picture;
 * username/avatar overrides do not apply. Personas without a token fall back to
 * the controller app.
 */

import { WebClient, type ChatPostMessageArguments } from "@slack/web-api";
import { env } from "../../util/env.js";

/** A persona's user token: its own `SLACK_USER_TOKEN_<HANDLE>` var, else its entry
 * in `SLACK_USER_TOKENS`, a JSON map of handle -> token (one secret in CI). */
export function envUserToken(handle: string): string | undefined {
  const own = process.env[userTokenEnvKey(handle)];
  if (own) return own;
  const all = process.env.SLACK_USER_TOKENS;
  if (!all) return undefined;
  let map: Record<string, string>;
  try {
    map = JSON.parse(all) as Record<string, string>;
  } catch {
    throw new Error('SLACK_USER_TOKENS is not valid JSON (expected {"handle": "xoxp-..."})');
  }
  return map[handle] || undefined;
}

/** Env var holding a persona's user token: priya.se -> SLACK_USER_TOKEN_PRIYA_SE. */
export function userTokenEnvKey(handle: string): string {
  return `SLACK_USER_TOKEN_${handle
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}`;
}

export interface PostOptions {
  username: string;
  avatar?: string; // raw emoji is ignored; :emoji: -> icon_emoji, http(s) -> icon_url
  threadTs?: string;
  /** Persona handle; selects the persona's user token when one is configured. */
  handle?: string;
}

export class SlackClient {
  private web: WebClient;
  private channelCache = new Map<string, string>();
  private userClients = new Map<string, WebClient | null>();
  private userJoined = new Set<string>();

  constructor(
    token: string,
    private userTokenFor: (handle: string) => string | undefined = envUserToken,
  ) {
    this.web = new WebClient(token);
  }

  /** The persona's own client, or null when it has no user token. */
  private userClient(handle?: string): WebClient | null {
    if (!handle) return null;
    if (!this.userClients.has(handle)) {
      const token = this.userTokenFor(handle);
      this.userClients.set(handle, token ? new WebClient(token) : null);
    }
    return this.userClients.get(handle)!;
  }

  /** True when messages for this persona are posted as a real workspace member. */
  postsAsUser(handle?: string): boolean {
    return this.userClient(handle) !== null;
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

    throw new Error(
      `Slack channel #${clean} not found. Create it in the workspace (docs/connectors/slack.md).`,
    );
  }

  private iconFields(avatar?: string): { icon_emoji?: string; icon_url?: string } {
    if (!avatar) return {};
    if (/^https?:\/\//.test(avatar)) return { icon_url: avatar };
    if (/^:.+:$/.test(avatar)) return { icon_emoji: avatar };
    return {}; // raw unicode emoji can't be used as an icon; username only
  }

  /** Post a message as a persona. Returns the message ts. */
  async post(channelId: string, text: string, opts: PostOptions): Promise<string> {
    const user = this.userClient(opts.handle);
    if (user) {
      const key = `${opts.handle}:${channelId}`;
      if (!this.userJoined.has(key)) {
        // Needs the channels:write user scope; a member who already joined passes either way.
        await user.conversations.join({ channel: channelId }).catch(() => {});
        this.userJoined.add(key);
      }
      const res = await user.chat.postMessage({ channel: channelId, text, thread_ts: opts.threadTs });
      return res.ts!;
    }
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

  /** Update a previously-posted message in place (idempotent re-runs). Only the
   * poster can edit a message, so pass the handle of a user-posted one. */
  async update(channelId: string, ts: string, text: string, asUserHandle?: string): Promise<void> {
    const client = this.userClient(asUserHandle) ?? this.web;
    await client.chat.update({ channel: channelId, ts, text });
  }

  /** Delete a previously-posted message (used to re-post under a changed
   * username/avatar, which chat.update cannot do). */
  async deleteMessage(channelId: string, ts: string, asUserHandle?: string): Promise<void> {
    const client = this.userClient(asUserHandle) ?? this.web;
    await client.chat.delete({ channel: channelId, ts }).catch(() => {});
  }

  /** Smoke test: post -> delete a temp message. */
  async smokeTest(channelName: string): Promise<void> {
    const ch = await this.channelId(channelName);
    const ts = await this.post(ch, "smoke test, please ignore", { username: "Demo-World Bot" });
    await this.web.chat.delete({ channel: ch, ts }).catch(() => {});
  }
}
