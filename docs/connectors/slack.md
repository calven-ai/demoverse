# Slack connector

Slack carries the world's internal chatter: deal threads, win-loss post-mortems, and competitive questions, posted by a roster of synthetic personas. This guide stands up a dedicated free workspace and the single "controller app" that posts as everyone. That app is the trick that makes an unlimited cast possible on a free plan.

## Two ways to post

| | **A. App only** (default) | **B. Persona accounts** |
| --- | --- | --- |
| Who posts | The controller app, under each persona's name and avatar | Each persona as a real member of the workspace |
| Setup | One app, one token (steps 1 to 5) | A + one Slack member and one user token per persona ([steps](#option-b-persona-accounts)) |
| Upkeep | Nothing per persona | A new persona needs a new member and token |
| Looks like | Persona name + avatar with an "APP" badge | A normal message from a person |
| Seen by a Slack app you are testing | **Only if it accepts messages from other apps** | Yes, like any user message |

Pick **A** unless something has to *react* to the chatter. Messages posted by an app carry a `bot_id`, and many Slack apps (bots, assistants, ingestion integrations) drop every such message, @mentions included, mostly so they never loop by replying to themselves or to other bots. Slack delivers the message either way; whether it is ignored is the receiving app's choice, so check yours. If your app ignores bot messages, the persona chatter is invisible to it under A, and B is the fix.

The two mix per persona: a persona with a user token posts as its member, every other persona keeps posting through the app. You can start with only the personas your app has to hear, for example the ones who ask in `#competitive`.

> **Dedicated workspace only.** Create a brand-new free workspace for this. Never install the app into your company's real workspace, and don't invite real coworkers.

## 1. Create the workspace

1. Go to [slack.com/get-started](https://slack.com/get-started#/createnew) and create a new workspace with an email you control (a `+alias` on your normal address works well).
2. Name it something obviously fabricated, e.g. `Aurora Demo World`.
3. Skip adding teammates. Stay on the **free plan**. The 90-day history window is a feature here: Slack carries the trailing-quarter signal while older history lives in the CRM and Drive.

## 2. Create the channels

The engine routes each artifact kind to a fixed channel. The channels **must already exist** (public, exact names) or reconcile fails with `Slack channel #… not found`:

| Channel | Carries |
| --- | --- |
| `#deals` | Per-deal threads naming the deal, account, rep, and competitors |
| `#win-loss` | Post-mortems. For deals with no survey/interview, this post is the *entire* win-loss signal |
| `#competitive` | Competitor questions (questions only, see below) |
| `#general` | Fallback for any unmapped post kind |

Create each via the **+** next to Channels → Create channel, leave it **Public**, skip adding people. The bot auto-joins public channels when it first posts. You never invite it manually.

## 3. Create the app from the manifest

A ready-to-paste manifest ships at [`docs/slack-app-manifest.json`](../slack-app-manifest.json).

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**.
2. Pick your demo workspace → **Next**.
3. Switch the editor to **JSON**, paste the manifest contents → **Next** → review → **Create**.

The manifest requests a superset of scopes that installs cleanly on a free workspace. The ones the engine actually uses:

| Scope | Why |
| --- | --- |
| `chat:write` | Post messages |
| **`chat:write.customize`** | **The load-bearing one.** Post under a per-message username and avatar |
| `channels:read` | Resolve public channels by name |
| `channels:join` | Auto-join channels before posting |
| `channels:manage` | Channel operations headroom |
| `reactions:write` | Emoji reactions |

## 4. Install and capture the token

1. On the app's **OAuth & Permissions** page: **Install to Workspace** → **Allow**.
2. Copy the **Bot User OAuth Token** (`xoxb-…`) into `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
```

If you ever change scopes, reinstall the app from the same page. The token may change.

## 5. Enable the connector

In `config/connectors.yaml` (ships disabled):

```yaml
slack:
  enabled: true
  channels:
    slack_deal_thread: "#deals"
    winloss_post: "#win-loss"
    competitive_q: "#competitive"
  fallback_channel: "#general"
```

The channel names here must match what you created in step 2. Then reconcile as usual with `npm run apply -- --reconcile`, and the engine posts whatever the cohort has earned. Each posted message's timestamp is recorded in the ledger, so re-runs never double-post.

## How personas work

The free plan caps installed apps at 10 per workspace, so "one app per fake employee" can't scale. Instead, the single controller app holds `chat:write.customize` and posts **each message under a per-message display name and avatar**. The persona roster lives in `config/slack-personas.yaml` and reuses the same identities as the CRM: the rep who owns a deal is the same name discussing it in `#deals`. Display names carry the role in parentheses, as in "Jordan Reyes (Account Executive)". The one visible tradeoff is a small "APP" badge on every message, which is fine for data an analytics tool scans and acceptable for human demos. The less visible one: apps that ignore bot messages won't see these posts ([two ways to post](#two-ways-to-post)).

## Option B: persona accounts

Do steps 1 to 5 first; the app stays as the fallback poster and owns channel lookup.

1. **Add user scopes.** On the app's **OAuth & Permissions** page, under **User Token Scopes**, add `chat:write` and `channels:write` (the second lets a persona join a channel on its first post).
2. **Create one member per persona.** Invite a **full member** (not a guest) for each `handle` in `config/slack-personas.yaml` you want to move, plus each deal-owning rep whose deal threads should count. `+alias` addresses on one inbox keep it manageable (`you+priya@…`). In each profile set the full name and title to match the persona's `display` and role, and upload the avatar from its `avatar` URL. Add the member to `#deals`, `#win-loss` and `#competitive`.
3. **Get each member's token.** Add the member under the app's **Collaborators**. Then, signed in to api.slack.com as that member (a private window helps), open the app → **Install to Workspace** → **Allow**, and copy the **User OAuth Token** (`xoxp-…`).
4. **Hand the tokens to the engine** as one JSON map, keyed by persona handle, in `.env`:

   ```bash
   SLACK_USER_TOKENS={"taylor.ceo":"xoxp-...","priya.se":"xoxp-..."}
   ```

   One variable per handle also works and wins over the map: `priya.se` → `SLACK_USER_TOKEN_PRIYA_SE`. For scheduled runs, add the same JSON as the `SLACK_USER_TOKENS` secret ([automation](../automation.md)).
5. **Move what is already posted** (optional). Slack can't change who posted a message, so existing threads are deleted and re-posted, at today's timestamp:

   ```bash
   npm run slack:repost-as-users                         # report: which threads, which personas still lack a token
   npm run slack:repost-as-users -- --channel=#competitive --confirm   # delete + queue
   npm run apply -- --reconcile                          # re-post as the members
   ```

A user-posted message shows the member's own profile, so the name and avatar come from Slack, not from `slack-personas.yaml`. The ledger records which messages were posted as users, so later edits and deletes go through the right token. A persona whose token is missing silently falls back to the app, so check the first run.

## Content rules

Two content rules the engine enforces at generation time:

- **`#competitive` posts are questions only.** The engine writes the human side. Whatever bot or product you're demoing supplies the answers. Pre-writing answers would fake the very output a demo exists to show.
- **`#win-loss` posts for "none"-mode deals carry the whole story.** Outcome, reason, competitors. Those deals deliberately have no survey or interview ([why](../faq.md#why-do-so-few-closed-deals-have-a-win-loss-artifact)).

## The weekly-members-only rule

Slack is the one destination with an extra gate beyond the cohort: only cohort members with `source: weekly` get Slack artifacts at all. Those are the deals created by the living weekly runs. Deals from the one-time historical seed (`source: seed`) never do. The reason is the 90-day history window: chatter about long-closed historical deals would either be invisible or, worse, visibly timestamped *now* about deals that closed months ago. Suppression happens at planning time, not push time, so no Slack prose is ever generated for a deal that can't receive it.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `invalid_auth` / `not_authed` | Token missing or wrong in `.env`. Re-copy the `xoxb-` token |
| `missing_scope` | Add the scope under OAuth & Permissions, then **reinstall** the app |
| `Slack channel #deals not found` | Create the channel; it must be public and not archived |
| `channel_not_found` on join | The channel is private. Recreate it as public |
| Every persona shows the same name | `chat:write.customize` is missing. Add it and reinstall |
| The app you are testing ignores the persona posts | It drops messages posted by apps. Use [persona accounts](#option-b-persona-accounts) |
| A persona still posts with the "APP" badge | No user token for that handle. `npm run slack:repost-as-users` lists them; the key is the exact `handle` |
| `not_in_channel` for a persona | Add the member to the channel, or grant the `channels:write` user scope and reinstall as that member |

Back to [getting started](../getting-started.md) · other connectors: [Salesforce](salesforce.md) · [Drive](google-drive.md) · [HubSpot](hubspot.md)
