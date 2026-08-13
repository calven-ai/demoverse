# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] — first public release

### Added
- Deterministic world engine: seeded weekly simulation of accounts, buying
  groups, opportunities, stage progression and correlated win/loss outcomes.
- Grounded prose pipeline: per-artifact prompt emission, agent-driven filling
  (Claude Code / Codex / Cursor via AGENTS.md), validated ingest, and a
  cross-system coherence linter with a repetition detector.
- Connector registry with Salesforce, Google Drive, Slack and a
  structure-only HubSpot connector; per-destination wiring in
  `config/connectors.yaml`; cohort gating so only curated deals leave the repo.
- Config templates for a fully user-defined fictional company
  (`config/templates/`), including editable prose story banks (`prose.yaml`).
- `/setup` wizard (agent-driven onboarding) plus a tool-neutral onboarding
  playbook in `AGENTS.md`.
- Documentation: getting started, per-connector setup guides,
  build-your-own-connector, architecture, request/result protocol spec,
  operations runbook, FAQ.
