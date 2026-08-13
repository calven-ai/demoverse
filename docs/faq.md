# FAQ

Answers to the questions that come up when people first meet Demoverse — what it needs, what it touches, why the data looks the way it does — plus a troubleshooting section for the errors you'll actually hit.

## Do I need Claude Code?

No. The engine's contract is files, not APIs: it emits prompt files, and anything that can read and write files can fill them — Claude Code, Codex, Cursor, another agent entirely, or you with a text editor. The repo ships agent guidance (`AGENTS.md`, `CLAUDE.md`) and slash commands (`/setup`, `/pipeline-update`, `/backfill-opps`) that make Claude Code the smoothest ride, but nothing in the engine knows or cares who wrote the prose. The full spec is [request-protocol.md](request-protocol.md).

## Does it call an LLM API?

No. Demoverse itself is deterministic TypeScript — no API keys for language models, no metered token bill. Prose generation happens inside your coding-agent session, on whatever subscription you already have. That's a deliberate design choice, not a missing feature: it keeps the engine's facts fully deterministic and the cost model flat. An optional API-based filler for unattended runs is on the roadmap; the request protocol is already the seam it would plug into.

## Will it touch my production systems?

Only if you point it at them — so don't. The engine writes exclusively to whatever the credentials in `.env` reach, and the documented setup for every connector is a **dedicated, isolated** environment: a fresh Salesforce Developer Edition org, a brand-new free Slack workspace, a purpose-made Drive folder, a test HubSpot portal. Beyond that, the defaults are defensive: every connector no-ops without credentials, every destructive command is dry-run by default, and only the curated cohort ever leaves the repo. Read the `DISCLAIMER` before connecting anything: isolated orgs you're authorized to use, clearly-fabricated data, no real people, and never posting to real review sites or any real user-facing surface.

## Why do so few closed deals have a win-loss artifact?

Because no real team debriefs every close. The default `mode_mix` leaves ~67% of closed deals with mode `none` — no survey, no interview; their whole win-loss signal is the CRM fields plus a Slack post-mortem. A corpus where every deal has a tidy debrief reads as generated on sight, and — just as important — *absence stops carrying information*. If your world's coverage creeps up, that's a config bug worth fixing before generating more prose ([operations.md](operations.md#the-cohort)).

## Why are the AE notes so… sloppy?

On purpose. Real field notes are sparse, logistical, and frequently capture no insight at all — "Demo done, sending pricing." The prompts explicitly forbid the failure mode where every note dutifully files competitor, sentiment, pricing, and blockers into neat bullets, and forbid derived conclusions ("we always lose when X") that would pre-chew what your analytics layer is supposed to discover. Realism is the product: the data should look like what a real, busy sales team leaves behind, because that's what a real analysis tool has to be good at reading.

## Can it write to CRMs other than Salesforce?

HubSpot ships in the box as a structure-only connector ([connectors/hubspot.md](connectors/hubspot.md)). Anything else is a `Connector` implementation away — the contract is one interface, one registry entry, one config block, and the HubSpot connector is the worked example ([connectors/build-your-own.md](connectors/build-your-own.md)).

## Is a run reproducible?

Structure: yes, exactly. The same config and seed replay to the same accounts, deals, dates, outcomes, and variety draws — the RNG is seeded per entity, so growth doesn't reshuffle existing texture. Prose: no, and by design — that half belongs to whoever fills the requests, and two agents (or the same agent twice) will phrase the same grounded facts differently. What *is* guaranteed about prose is the grounding: whatever the words, the facts they carry are pinned by the prompt and checked by the linter.

## Why templates instead of a bundled example company?

Because a shipped example company would be everyone's example company. Demo data earns belief by being *yours* — your market's vocabulary, your competitors' shapes, your buyers' objections — and a default cast would leak the same fictional vendor into every Demoverse deployment (and every screenshot on the internet). The templates plus the [setup wizard](setup-wizard.md) get you a bespoke world in one session; `prose.yaml` is the one file generic enough to ship working defaults.

## Troubleshooting

**Ingest says a result is invalid.** The report names the artifact and reason: markdown under 20 characters, or malformed JSON for Slack/email results (missing `messages`/`emails` array, empty `personaHandle`/`text`, missing `from`/`subject`/`body`/`date`). Fix the result file and re-run `apply -- --ingest` — invalid artifacts stay `planned` and are picked up again; nothing bad was filed.

**Lint reports errors after ingest.** Usually prose that contradicts the record — a missing competitor name or the wrong win/loss reason. Edit the result (or `apply -- --refill=<artifactId>` for a clean re-emit) and re-ingest. Triage guide: [operations.md](operations.md#lint-triage).

**"Missing config file" on any command.** You're running against a clone whose `config/` hasn't been populated — copy `config/templates/*.yaml` into `config/` (or run `/setup`), then `npm run init`. See [getting-started.md](getting-started.md).

**`apply` prints "world already current" and does nothing.** Working as designed: plain `apply` only generates periods the real calendar has produced. Force an increment with `npm run pipeline` (accepting that `simNow` steps slightly ahead of real time — [explanation](operations.md#when-simnow-runs-ahead-of-real-time)).

**A connector prints `[skipped]` during reconcile.** Read the note — it tells you which case you're in. "disabled in config/connectors.yaml" means flip `enabled: true` when you're ready; "credentials absent (.env)" means the connector is enabled but its env vars are missing. Both are clean no-ops, not errors; reconcile is idempotent, so re-running after fixing picks up where things left off.

**Old files keep appearing in my Drive-ingesting tool after a reset.** Orphans from the previous world generation — `init --force` produces them by design, since the new ledger doesn't claim the old files. `npm run drive:audit` finds them; `-- --purge --confirm` trashes them. Details: [connectors/google-drive.md](connectors/google-drive.md#driveaudit-and-the-orphan-hazard).

**Salesforce rejects `Industry` (or a picklist value).** Provisioning was skipped or the config's verticals changed since — re-run `npm run sf:setup`; it's idempotent and only adds what's missing. Stage-date fields not populating → `npm run sf:stage-fields` (fields must exist *and* have field-level security; the script does both).

**Slack posts all show the same author, or reconcile can't find a channel.** The first is a missing `chat:write.customize` scope (add + reinstall the app); the second means the channel doesn't exist, isn't public, or the names in `config/connectors.yaml` don't match the workspace. Checklist: [connectors/slack.md](connectors/slack.md#troubleshooting).

Still stuck? The architecture doc explains what each layer owns — [architecture.md](architecture.md) — and most confusion resolves to "that's the engine's job" or "that's the filler's job".
