# Automation: the weekly run on GitHub Actions

Once a world exists, it advances itself. [`.github/workflows/pipeline-update.yml`](../.github/workflows/pipeline-update.yml) runs every Sunday at 19:00 UTC and does what `/pipeline-update` does by hand:

1. Claude Code runs headless (`claude -p`, Sonnet) through steps 1-4 of the skill: advance one week, fill the touch points with one `opp-filler` subagent per deal, ingest, then lint and refill.
2. The workflow pushes to every connector that has secrets (`npm run apply -- --ingest --reconcile`). Claude never sees the connector credentials.
3. The workflow commits the result to `main` as `pipeline increment <date>` and posts Claude's report plus the push outcome to the run's summary page.

A run takes about 5 minutes. To run by hand instead, or to add knobs such as `--new-opps` or `--nudge`, see [operations.md](operations.md#running-it-manually).

## One-time setup

**1. Use a private repo.** The workflow commits your world (`state/`, `config/`) to `main`. Clone Demoverse and push it to a new private repository rather than forking. GitHub does not run scheduled workflows on forks until you enable them, and a public fork would publish your world.

**2. Finish `/setup` and commit `config/`.** Without `config/world.yaml` the workflow skips with a green check. That is why it stays quiet in the upstream repo.

**3. Create the `automation` environment.** In **Settings → Environments → New environment**, name it `automation`. Under **Deployment branches and tags**, choose **Selected branches** and add `main`, so that a branch or pull request cannot read the secrets.

**4. Add the secrets to that environment.** Use the UI, or run `gh secret set <NAME> --env automation` (it prompts for the value):

| Secret                                                            | Required         | Value                                                                              |
| ----------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`                                         | one of these two | `claude setup-token`, which bills your Claude subscription                         |
| `ANTHROPIC_API_KEY`                                               | one of these two | a [Console](https://console.anthropic.com/) key, which bills per token             |
| `SF_LOGIN_URL`, `SF_USERNAME`, `SF_PASSWORD`, `SF_SECURITY_TOKEN` | for Salesforce   | the same values as `.env` ([guide](connectors/salesforce.md))                      |
| `GOOGLE_SERVICE_ACCOUNT_JSON`                                     | for Drive        | the whole contents of `service-account.json` ([guide](connectors/google-drive.md)) |
| `DRIVE_ROOT_FOLDER_ID`                                            | for Drive        | as in `.env`                                                                       |
| `SLACK_BOT_TOKEN`                                                 | for Slack        | as in `.env` ([guide](connectors/slack.md))                                        |
| `SLACK_USER_TOKENS`                                               | optional, Slack  | as in `.env`, only for [persona accounts](connectors/slack.md#option-b-persona-accounts) |

A connector also has to be `enabled: true` in `config/connectors.yaml`. A connector with no secrets is skipped, as it is locally. HubSpot is not part of the weekly push. It is driven by `npm run hubspot:*` ([guide](connectors/hubspot.md)).

**5. Do the first run by hand.** Open **Actions → Weekly pipeline increment → Run workflow**. Check the summary page, then `git pull`.

## When a run goes red

| Failed step        | Meaning                                                                                         | Fix                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Preflight          | No Claude credential in `automation`                                                            | Add one of the two secrets                                                                                            |
| Advance and fill   | Claude crashed or timed out. Nothing was committed, so the world is still at the last good week | Read the step log, then run the workflow again.                                                                       |
| Push to connectors | A connector errored, most often an expired Salesforce password. The prose **was** committed     | Update the secret, then **Run workflow** with **reconcile_only** checked. That pushes without advancing another week. |

If Claude stopped on purpose (the world is far ahead of the calendar, the win-loss mix drifted, or a deal planted too many artifacts), the run is green and the report says why. Deal with it as [operations.md](operations.md) describes.

## Adjusting

- **Time:** edit the `cron` line. It is in UTC.
- **Weeks per run:** a manual run takes a `weeks` input. A standing change in intake belongs in `state/trends.json`, not here.
- **Model:** `--model` in the "Advance and fill" step.
- **Pause:** **Actions → Weekly pipeline increment → ⋯ → Disable workflow**.
- **Working locally between runs:** `git pull` before you run anything. Both sides commit `state/world.json`, and it does not merge well.
