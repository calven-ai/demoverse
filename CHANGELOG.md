# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added
- Slack persona accounts: a persona with a user token (`SLACK_USER_TOKENS`
  JSON map, or `SLACK_USER_TOKEN_<HANDLE>`) posts as its own workspace member
  instead of through the controller app, so Slack apps that ignore bot
  messages can read the chatter. Mixes per persona; `npm run
  slack:repost-as-users` moves already-posted threads. Both options are
  compared in `docs/connectors/slack.md`.
- Weekly GitHub Actions workflow (`.github/workflows/pipeline-update.yml`) that
  runs `/pipeline-update` headless every Sunday, pushes to the configured
  connectors and commits the result. It is now the default way a world
  advances; setup in `docs/automation.md`. A `reconcile_only` run retries a
  failed push without advancing.
- Post-sale customer calls on won deals: a check-in 3 to 6 weeks after the
  close and a review about 3 months after (`world.yaml`
  `artifacts.customer_checkin` / `customer_review`, with attendees in
  `personas.yaml` and briefs in `prose.yaml` `stage_focus`). They carry the
  gains that pre-sale calls lack.
- Customer-voice arcs in `state/trends.json` (`voice.arcs`, `voice.gainShare`):
  dated themes that calls, surveys and interviews voice in proportion to their
  weight at the artifact's date, so a theme rises and fades across the corpus.
  Empty by default, which leaves prompts unchanged.

### Changed
- `AGENTS.md` is the one instruction file: `CLAUDE.md` is gone, because Claude
  Code 2.1.277 and later read `AGENTS.md` directly. The skills table, the
  subagent rule and the bulk-backfill loop moved into its Part 3.
- Post-sale calls are on by default (rates 0.9 and 0.8). Existing worlds start
  earning them on the next run; set `rate: 0` to opt out. A missing
  `stage_focus` entry for an enabled post-sale stage is now a config warning.
- `apply -- --ingest --reconcile` exits non-zero when any connector reports an
  error, so unattended runs fail visibly.

### Fixed
- Rep Slack handles fold accents ("José Núñez" is `jose.nunez`, was
  `jos.n.ez`). Handles stored the old way still resolve; run
  `npm run repair:slack-identities -- --confirm` to rewrite them, and rename
  any accented handle under `rep_personas` in `config/slack-personas.yaml` so
  its avatar keeps binding.

## [0.1.0] - 2026-08-14

First public release.

### Added
- Deterministic world engine: seeded weekly simulation of accounts, buying
  groups, opportunities, stage progression and correlated win/loss outcomes.
- Grounded prose pipeline: per-artifact prompt emission, agent-driven filling
  (Claude Code / Codex / Cursor via AGENTS.md), validated ingest, and a
  cross-system coherence linter with a repetition detector.
- Connector registry with Salesforce, Google Drive, Slack and a structure-only
  HubSpot connector. Per-destination wiring lives in `config/connectors.yaml`,
  and cohort gating means only curated deals leave the repo.
- Config templates for a fully user-defined fictional company
  (`config/templates/`), including editable prose story banks (`prose.yaml`).
- `/setup` wizard (agent-driven onboarding) plus a tool-neutral onboarding
  playbook in `AGENTS.md`.
- Documentation: getting started, per-connector setup guides,
  build-your-own-connector, architecture, request/result protocol spec,
  operations runbook, FAQ.
- `--help` on the three main entrypoints (`apply`, `init`, `lint`), backed by a
  shared argv/usage helper in `src/util/cli.ts`. Flag documentation moved out of
  file header comments and into output a user can actually reach.
- `docs/operations.md` now documents the optional `world.prospects` block: what
  it does, the CSV column contract, and the guardrails around demoing with real
  company names.
- A regression test pinning every `generate` and `detail` Zod default to what
  `config/templates/world.yaml` sets, so the two cannot drift apart again.

### Changed
- Tests load `config/templates/*.yaml` directly (see `tests/fixture.ts`) instead
  of an operator's `config/`. `npm ci && npm test` now works on a fresh clone,
  which is what `CONTRIBUTING.md` always claimed, and a configured world can no
  longer make the shipped suite fail. CI drops its `cp config/templates` step
  and runs exactly what a fresh clone runs.
- `CONTRIBUTING.md` explains the tool-vs-world split, what must never appear in
  an upstream PR, why domain `lint` is not in CI, and how `secrets:hook` works.

### Fixed
- Zod defaults in `src/config/schema.ts` contradicted the templates:
  `generate.ae_notes` and `generate.emails` defaulted to `false` (template:
  `true`), `generate.internal_collateral` to `true` (template: `false`), and
  three `detail` levels disagreed. Omitting a key produced a different world
  from the documented one.
- `DAYS_PER_QUARTER` was 91 in `scripts/init.ts` and 91.3125 in the advance and
  trend evaluators, so the clock's start date and the quarters-elapsed used for
  trends drifted apart over a long history. Now one exported constant.
- Source comments cited `DESIGN.md` (20 files) and `crm-shared.ts`, neither of
  which exists in this repo. They now point at `docs/architecture.md`,
  `DISCLAIMER.md`, or the config key that actually holds the vocabulary.
- `.github/CODEOWNERS` used a bare org login, which GitHub matches to no
  reviewer, so review requests were never assigned.

[Unreleased]: https://github.com/calven-ai/demoverse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/calven-ai/demoverse/releases/tag/v0.1.0
