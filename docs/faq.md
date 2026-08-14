# FAQ

What Demoverse needs, what it touches, and why the data looks the way it does, plus a troubleshooting section for the errors you'll actually hit.

## Do I need Claude Code?

No, though you do need *a* coding agent, because the agent's model is what generates the transcripts, emails and Slack threads. Which one is up to you. The engine's contract is files, not APIs: it emits prompt files, and anything that can read and write files can fill them, whether that's Claude Code, Codex, Cursor, another agent, or a script of your own against a model API. Nothing in the engine knows or cares what produced a result. The repo ships agent guidance (`AGENTS.md`, `CLAUDE.md`) and slash commands (`/setup`, `/pipeline-update`, `/backfill-opps`), which make Claude Code the smoothest ride. Filling a request by hand is worth doing once to see the contract, but a world's worth of prose is not a hand-writing job. The full spec is [request-protocol.md](request-protocol.md).

## Is the prose AI-generated? Does Demoverse call an LLM?

Yes to the first, no to the second, and the distinction matters. Every transcript, email thread, Slack post and win-loss interview is written by a language model, but the engine is not the thing calling it. Demoverse is deterministic TypeScript with no model client in its dependencies, no model API key in its config, and no network call to a model provider anywhere in the codebase. It emits grounded prompt files and validates whatever comes back.

The model call happens one layer out, in the coding-agent session that drives the repo, so the tokens come out of the subscription you already have rather than a metered API bill. That keeps the engine's *facts* deterministic while the *prose* stays model-written, and it means any writer can fill a request.

For unattended runs, point your own filler at the [request protocol](request-protocol.md): read `manifest.json`, send each `.prompt.md` to the model of your choice, write the result files, then let `npm run apply -- --ingest` validate them exactly as it would an agent's work. Demoverse ships no first-party filler on purpose, so the engine keeps no opinion about which model wrote the prose.

## Will it touch my production systems?

Only if you point it at them. So don't. The engine writes exclusively to whatever the credentials in `.env` reach, and the documented setup for every connector is a **dedicated, isolated** environment: a fresh Salesforce Developer Edition org, a brand-new free Slack workspace, a purpose-made Drive folder, a test HubSpot portal. Beyond that, the defaults are defensive. Every connector no-ops without credentials, every destructive command is dry-run by default, and only the curated cohort ever leaves the repo. Read the [DISCLAIMER](../DISCLAIMER.md) before connecting anything.

## Why do so few closed deals have a win-loss artifact?

Because no real team debriefs every close. The default `mode_mix` leaves ~67% of closed deals with mode `none`: no survey, no interview, their whole win-loss signal being the CRM fields plus a Slack post-mortem. A corpus where every deal has a tidy debrief reads as generated on sight, and the second cost is the worse one: *absence stops carrying information*. If your world's coverage creeps up, that's a config bug worth fixing before generating more prose ([operations.md](operations.md#the-cohort)).

## Why are the AE notes so… sloppy?

On purpose. Real field notes are sparse, logistical, and frequently capture no insight at all. "Demo done, sending pricing." The prompts explicitly forbid the failure mode where every note dutifully files competitor, sentiment, pricing, and blockers into neat bullets. They also forbid derived conclusions ("we always lose when X") that would pre-chew what your analytics layer is supposed to discover. The data should look like what a real, busy sales team leaves behind, because that's what a real analysis tool has to be good at reading.

## Can it write to CRMs other than Salesforce?

HubSpot ships in the box as a structure-only connector ([connectors/hubspot.md](connectors/hubspot.md)). Anything else is a `Connector` implementation away: one interface, one registry entry, one config block, with the HubSpot connector as the worked example ([connectors/build-your-own.md](connectors/build-your-own.md)).

## Is a run reproducible?

Structure: yes, exactly. The same config and seed replay to the same accounts, deals, dates, outcomes, and variety draws. The RNG is seeded per entity, so growth doesn't reshuffle existing texture. Prose: no, by design. That half belongs to whoever fills the requests, and two agents (or the same agent twice) will phrase the same grounded facts differently. What *is* guaranteed is the grounding. Whatever the words, the facts they carry are pinned by the prompt and checked by the linter.

## Why templates instead of a bundled example company?

Because a shipped example company would be everyone's example company. Demo data earns belief by being *yours*: your market's vocabulary, your competitors' shapes, your buyers' objections. A default cast would leak the same fictional vendor into every Demoverse deployment, and into every screenshot on the internet. The templates plus the [setup wizard](setup-wizard.md) get you a bespoke world in one session. `prose.yaml` is the one file generic enough to ship working defaults.

## Troubleshooting

**Ingest says a result is invalid.** The report names the artifact and reason: markdown under 20 characters, or malformed JSON for Slack/email results (missing `messages`/`emails` array, empty `personaHandle`/`text`, missing `from`/`subject`/`body`/`date`). Fix the result file and re-run `apply -- --ingest`. Invalid artifacts stay `planned` and get picked up again. Nothing bad was filed.

**Lint reports errors after ingest.** Usually prose that contradicts the record: a missing competitor name, or the wrong win/loss reason. Edit the result and re-ingest. For a clean re-emit, use `apply -- --refill=<artifactId>` instead. Triage guide: [operations.md](operations.md#lint-triage).

**"Missing config file" on any command.** You're running against a clone whose `config/` hasn't been populated. Copy `config/templates/*.yaml` into `config/` (or run `/setup`), then `npm run init`. See [getting-started.md](getting-started.md).

**`apply` prints "world already current" and does nothing.** Working as designed. Plain `apply` only generates periods the real calendar has produced. Force an increment with `npm run pipeline`, accepting that `simNow` steps slightly ahead of real time ([explanation](operations.md#when-simnow-runs-ahead-of-real-time)).

**A connector prints `[skipped]` during reconcile.** Read the note: "disabled in config/connectors.yaml" means flip `enabled: true` when you're ready, and "credentials absent (.env)" means the connector is enabled but its env vars are missing. Both are clean no-ops rather than errors, and reconcile is idempotent, so re-running after a fix picks up where things left off.

**Old files keep appearing in my Drive-ingesting tool after a reset.** Orphans from the previous world generation, which `init --force` produces by design since the new ledger doesn't claim the old files. `npm run drive:audit` finds them, and `-- --purge --confirm` trashes them. Details: [connectors/google-drive.md](connectors/google-drive.md#driveaudit-and-the-orphan-hazard).

**Salesforce rejects `Industry` (or a picklist value).** Provisioning was skipped, or the config's verticals changed since. Re-run the idempotent `npm run sf:setup`, which only adds what's missing. Stage-date fields not populating → `npm run sf:stage-fields` (fields must exist *and* have field-level security; the script does both).

**Slack posts all show the same author, or reconcile can't find a channel.** The first is a missing `chat:write.customize` scope: add it, then reinstall the app. The second means the channel doesn't exist, isn't public, or the names in `config/connectors.yaml` don't match the workspace. Checklist: [connectors/slack.md](connectors/slack.md#troubleshooting).

Still stuck? [architecture.md](architecture.md) explains what each layer owns. Most confusion resolves to "that's the engine's job" or "that's the filler's job".
