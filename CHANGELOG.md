# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added
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

## [0.1.0] - first public release

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
