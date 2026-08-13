# Slack connector

Slack carries the world's internal chatter: deal threads, win-loss post-mortems, and competitive questions, posted by a roster of synthetic personas. This guide stands up a dedicated free workspace and the single "controller app" that posts as everyone — the trick that makes an unlimited cast possible on a free plan.

> **Dedicated workspace only.** Create a brand-new free workspace for this. Never install the app into your company's real workspace, and don't invite real coworkers.

## 1. Create the workspace

1. Go to [slack.com/get-started](https://slack.com/get-started#/createnew) and create a new workspace with an email you control (a `+alias` on your normal address works well).
2. Name it something obviously fabricated — e.g. `Aurora Demo World`.
3. Skip adding teammates. Stay on the **free plan** — the 90-day history window is a feature here: Slack carries the trailing-quarter signal while older history lives in the CRM and Drive.

## 2. Create the channels

The engine routes each artifact kind to a fixed channel. The channels **must already exist** (public, exact names) or reconcile fails with `Slack channel #… not found`:

| Channel | Carries |
| --- | --- |
| `#deals` | Per-deal threads naming the deal, account, rep, and competitors |
| `#win-loss` | Post-mortems — for deals with no survey/interview, this post is the *entire* win-loss signal |
| `#competitive` | Competitor questions (questions only — see below) |
| `#general` | Fallback for any unmapped post kind |

Create each via the **+** next to Channels → Create channel, leave it **Public**, skip adding people. The bot auto-joins public channels when it first posts — you never invite it manually.

## 3. Create the app from the manifest

A ready-to-paste manifest ships at [`docs/slack-app-manifest.json`](slack-app-manifest.json).

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**.
2. Pick your demo workspace → **Next**.
3. Switch the editor to **JSON**, paste the manifest contents → **Next** → review → **Create**.

The manifest requests a superset of scopes that installs cleanly on a free workspace. The ones the engine actually uses:

| Scope | Why |
| --- | --- |
| `chat:write` | Post messages |
| **`chat:write.customize`** | **The load-bearing one** — post under a per-message username and avatar |
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

If you ever change scopes, reinstall the app from the same page — the token may change.

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

The channel names here must match what you created in step 2. Then reconcile as usual — `npm run apply -- --reconcile` — and the engine posts whatever the cohort has earned. Each posted message's timestamp is recorded in the ledger, so re-runs never double-post.

## How personas work

The free plan caps installed apps at 10 per workspace, so "one app per fake employee" can't scale. Instead, the single controller app holds `chat:write.customize` and posts **each message under a per-message display name and avatar**. The persona roster lives in `config/slack-personas.yaml` and reuses the same identities as the CRM: the rep who owns a deal in the CRM is the same name discussing it in `#deals`. Display names carry the persona's role in parentheses — "Jordan Reyes (Account Executive)" — so a reader always knows who's speaking. The one visible tradeoff: messages carry a small "APP" badge. That's fine for data an analytics tool scans and acceptable for human demos.

Two content rules the engine enforces at generation time:

- **`#competitive` posts are questions only.** The engine writes the human side; whatever bot or product you're demoing supplies the answers. Pre-writing answers would fake the very output a demo exists to show.
- **`#win-loss` posts for "none"-mode deals carry the whole story** — outcome, reason, competitors — because those deals deliberately have no survey or interview ([why](../faq.md#why-do-so-few-closed-deals-have-a-win-loss-artifact)).

## The weekly-members-only rule

Slack is the one destination with an extra gate beyond the cohort: only cohort members with `source: weekly` — deals created by the living weekly runs — get Slack artifacts at all. Deals from the one-time historical seed (`source: seed`) never do. The reason is the 90-day history window: chatter about long-closed historical deals would either be invisible or, worse, visibly timestamped *now* about deals that closed months ago. Suppression happens at planning time, not push time, so no Slack prose is ever generated for a deal that can't receive it.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `invalid_auth` / `not_authed` | Token missing or wrong in `.env` — re-copy the `xoxb-` token |
| `missing_scope` | Add the scope under OAuth & Permissions, then **reinstall** the app |
| `Slack channel #deals not found` | Create the channel; it must be public and not archived |
| `channel_not_found` on join | The channel is private — recreate it as public |
| Every persona shows the same name | `chat:write.customize` is missing — add it and reinstall |

Back to [getting started](../getting-started.md) · other connectors: [Salesforce](salesforce.md) · [Drive](google-drive.md) · [HubSpot](hubspot.md)
