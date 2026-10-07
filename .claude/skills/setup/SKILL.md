---
name: setup
description: Guided first-run onboarding for Demoverse. Interview the user to invent their fictional company, write the config from templates, initialize the world, run the first weekly increment, and optionally connect Salesforce/Drive/Slack/HubSpot with per-connector verification. Use on a fresh clone, or to amend an existing world's config. Resumable; every step checks what already exists.
---

# /setup: from fresh clone to living world

Execute **Part 2 of [AGENTS.md](../../../AGENTS.md) (the onboarding playbook)**.
It is the canonical script for this skill. Operational notes for Claude Code:

## Flow control

- Work **one step at a time**, confirming completion before moving on. Every
  step is resumable: on entry, check what already exists (`config/*.yaml`,
  `state/world.json`, `.env`) and skip or offer to amend done steps.
- Use AskUserQuestion for each interview topic (Step 1). Ask one topic per
  question round, with concrete suggested options where possible. Whenever the
  user is unsure, offer to invent plausible details from their one-line seed
  idea and show them for approval.
- If `config/world.yaml` exists on entry, STOP and ask: amend the existing
  world, or reset with `npm run init -- --force`. Explain that it clears the
  local world and derived state, and print its external-purge guidance.

## Writing the config (Step 2)

- Copy each template from `config/templates/` to `config/` and fill it from
  the interview. Keep every key; the zod schemas are the contract.
- `prose.yaml`: default to the shipped generic banks, then offer to tailor
  `narrative_angles` and `objection_themes` to the invented product. This is
  recommended. 10 minutes of tailoring is the single biggest realism win.
- `connectors.yaml`: leave every connector `enabled: false` at this stage.
- Before `init`, show a one-screen summary table (company, modules,
  competitors, segments, team size, pricing band) and get an explicit confirm.

## Validation + first light (Steps 3–4)

```bash
npm run init                          # zod-validates everything; loop back on errors
npm run apply -- --weeks=1 --dry-run  # show the user the plan
npm run pipeline                      # the real first increment
```

Fill ONE emitted prompt yourself as the hello-world. Inline is fine for this
single artifact, and it doubles as showing the user what the prompts look like.
Then run `npm run apply -- --ingest` and `npm run lint`. Show the user the filed
artifact in `state/content/`.

For the remaining requests of the first increment, dispatch `opp-filler`
subagents (one per opportunity) as in `/pipeline-update`.

## Connectors (Step 5, optional, one at a time)

For each system the user wants, follow the matching guide and **verify with a
real call before declaring done**:

| System | Guide | Verify |
| --- | --- | --- |
| Salesforce | `docs/connectors/salesforce.md` | `npm run sf:setup` then a scoped `apply -- --ingest --reconcile --opp=<id>` |
| Google Drive | `docs/connectors/google-drive.md` | reconcile, then `npm run drive:audit` |
| Slack | `docs/connectors/slack.md` | reconcile a weekly-cohort deal; confirm the post |
| HubSpot | `docs/connectors/hubspot.md` | `npm run hubspot:import -- --dry-run` then verify |

Remind the user each time: **dedicated, isolated orgs/workspaces only** (see
DISCLAIMER.md). Credentials go in `.env` (gitignored), never into config files.

## Commit (Step 6)

```bash
git add -A && git commit -m "demoverse: initial world for <Company>"
```

## Automate (Step 7, recommended)

Offer to make the weekly run hands-off (`docs/automation.md`). With a yes:

1. The repo must be a **private** GitHub repo. If `git remote -v` shows none,
   or a public one, have the user create a private repo and push to it.
2. Create the `automation` environment with a `main`-only deployment branch
   policy (the UI, or `gh api` on `repos/{owner}/{repo}/environments/automation`).
3. Secrets: a Claude credential (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`,
   or `ANTHROPIC_API_KEY`) plus the values of every connector enabled in Step 5.
   Have the user run `! gh secret set <NAME> --env automation` for each, so
   values never pass through you. For Drive, `GOOGLE_SERVICE_ACCOUNT_JSON` is the
   key file's contents:
   `gh secret set GOOGLE_SERVICE_ACCOUNT_JSON --env automation < service-account.json`.
4. Push, then `gh workflow run pipeline-update.yml` and `gh run watch`. On green,
   `git pull` and show the run's summary.

Close by telling the user the world now advances every Sunday at 19:00 UTC, and
that `/pipeline-update` still runs a week by hand. If they declined automation,
print the manual routine instead:

```
npm run pipeline → fill requests → npm run apply -- --ingest --reconcile → npm run lint → commit
```
