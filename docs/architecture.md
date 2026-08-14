# Architecture

Demoverse is built on one split, applied everywhere. A **deterministic TypeScript engine owns every fact**: accounts, contacts, deals, outcomes, dates, competitors, ids. The **coding agent owns only the prose**, written from prompts that carry the exact facts, so it can never invent one. This document covers the engine side of that line: the ledger, the clock, the generation protocol, the cohort, the steering model, and the verification layer.

![The Demoverse loop: config and state feed the deterministic engine; the engine advances the pipeline and emits grounded generation requests; an agent fills the prose; the engine ingests, lints, and reconciles into the external systems, recording external ids back into the ledger.](assets/architecture-8bit.svg)

## The ledger is the source of truth

`state/world.json` holds every entity: reps, accounts, contacts, opportunities, artifacts, and their external ids. It's versioned JSON, committed to git. Each run computes the *next desired state* of the world, then **reconciles** the external systems to it with idempotent upserts. Every entity records its external id (Salesforce Id, Drive fileId, Slack message ts) after first creation, so re-runs update instead of duplicating, and a wiped destination rebuilds by replay. Because the ledger is committed, git history doubles as the audit trail.

Prose bodies live beside it in `state/content/<artifactId>.md`, as committed markdown. World diffs stay readable, and the whole world (structure *and* words) travels with the repo.

The corollary: **nobody hand-edits `state/world.json`.** Structure is the engine's job. The sanctioned ways to change the world are config, directives, nudges, and the request protocol.

## Entity model

- **Reps** are the fictional sales team, from `config/sales-team.yaml`, with regions and win modifiers.
- **Accounts** are the companies evaluating the fictional vendor: industry, size, revenue band, region, funding stage, and an **ICP-fit tier** (high/medium/low) that biases win rate and is directly steerable.
- **Contacts** are buying-group members with titles and buying roles (economic buyer, champion, user, technical, blocker).
- **Opportunities** carry account, owner, amount, stage, status, created/close dates, competitors-on-deal, win/loss reason, a **win-loss mode** (survey | interview | none), and a **primary use case**.
- **Artifacts** are the prose touch points attached to deals, plus a few standalone kinds: `call_transcript`, `email_exchange`, `ae_note`, `survey`, `interview`, `slack_deal_thread`, `winloss_post`, `competitive_q`, `internal_collateral`. Each carries a status (`planned` → `generated` → `reconciled`), a grounding snapshot, and its external ids.

Every deal is *about* something. Its use case names it (`<Account> - <Use Case>`) and dominates its prose. Assignment is downstream of the competitor on the deal and never feeds back into the outcome. Two knobs do the work: `target_share` for overall frequency, and mean-normalized `competitor_weights` for per-competitor skew, which keeps "this competitor shows up mostly in X deals" discoverable without letting the skew distort overall volume.

## Determinism and the seeded RNG

Everything the engine samples flows through a seeded RNG keyed by the world seed plus a stable stream name (per deal, per artifact, per decision): which account a new deal lands on, deal sizes, cycle lengths, outcomes, win-loss modes, variety draws. Two consequences:

- **Replayability.** The same config and seed produce the same world. `init -- --seed=X` pins it.
- **Stability under growth.** Streams are keyed to entities, not to a global call sequence, so adding a new deal doesn't reshuffle the texture of existing ones.

The same seeding drives the **variety system** (`src/generation/variety.ts` + `config/prose.yaml`). Every deal gets one stable draw per axis (narrative angle, buyer tone, objection themes, timeline pressure), plus a per-artifact structural shape and a banned-phrase list. All of it is injected into prompts as the VARIETY block, and it's what keeps three hundred deals from telling the same story. Two constraints follow: draws are seeded picks over the arrays in `prose.yaml`, so append new entries and never reorder; and axis text must be leak-safe, never implying a deal's eventual outcome, since the same block appears on open-stage and close artifacts.

## Clock, periods, and advance

The world advances in **periods** (default one week), tracked in `state/clock.json` as `simNow`. Plain `npm run apply` generates only the periods the real calendar has produced, and does nothing ("world already current") when `simNow` is already caught up. `npm run pipeline` (= `apply -- --weeks=1`) *forces* one period on demand, stepping `simNow` ahead of the real date when needed and warning how far ahead the world sits.

Each advanced period, the engine:

1. **Opens** new deals (rate from `state/trends.json` `volume.newOppsPerWeek`), drawing accounts, buying groups, competitors, a use case, and a full deterministic schedule.
2. **Progresses** open deals along the configured stages, on each deal's own cycle. Length is drawn per deal from a shape archetype (`src/pipeline/shape.ts`): most land inside `pipeline.avg_sales_cycle_weeks`, while a small share close in a week, grind for a quarter, or stall and go quiet for a month. Stages follow from elapsed fraction, so a short deal genuinely skips some and a stalled one holds still, earning nothing.
3. **Closes** deals whose cycle is up, sampling outcome from the current win-rate trajectory (biased by ICP fit and competitor strength) and a loss reason from the configured weights; assigns the win-loss mode.
4. **Plans touch points**: only the artifacts these events earned *this period*, such as a discovery call for a new deal or a win-loss artifact and post-mortem for a close. Grounding is snapshotted at planning time, so an early-stage transcript reflects the world as it was at the call date and never leaks the eventual outcome.

![One deal accumulating history week by week: discovery call and intro email in week 1, demo call and Slack thread during Evaluation, an AE note, a proposal email, and finally a win-loss interview and post-mortem when it closes. Six weeks is this deal's cycle, not every deal's.](assets/living-week-8bit.svg)

This is the **living increment**, the core motion: a deal accumulates its history across many runs, exactly as a real one does. Its complement is the **detail-layer backfill** (`apply -- --backfill-touchpoints --opp=`), which plants the *whole* cycle of *one* deal at once and exists solely for seeding history. The split prevents a freshly-opened deal with a complete past. See [operations.md](operations.md#the-two-motions) for when to use which.

## The generation-request protocol

Prose is produced through a two-phase handoff, specified fully in [request-protocol.md](request-protocol.md):

1. **Emit.** `apply` writes `state/requests/<periodIndex>/` with a `manifest.json` and one fully-grounded `<artifactId>.prompt.md` per planned artifact: fact block, grounding rules, variety block, format instructions.
2. **Fill.** The agent (or a human) writes `results/<artifactId>.md` or `.json`. Fills parallelize freely, and distinct files never conflict.
3. **Ingest.** `apply -- --ingest` schema-validates each result, files markdown into `state/content/`, attaches Slack/email structures onto their artifacts, and flips status to `generated`. A failure leaves the artifact `planned`, so it is simply re-requested. Bad data is never filed.
4. **Reconcile.** `apply -- --reconcile` pushes generated artifacts and CRM structure through the connector chain, recording external ids.

Step 2 is the only model-written step, and it happens outside the engine. Demoverse ships no model client and no model key; the model that writes the prose is the one already running your agent session. That buys a cost model (subscription tokens, not a metered API bill) and portability at once: any agent can fill requests, and so can a script of your own against any model API.

## Connectors

Each destination is a `Connector` (`src/connectors/types.ts`), run in registry order. CRM goes first, so accounts exist before documents and chatter group under them. Every connector no-ops cleanly when disabled in `config/connectors.yaml` or when its credentials are absent, honors `--dry-run` and single-opportunity scoping, gates on the cohort, and records external ids. Details and the build-your-own guide: [connectors/build-your-own.md](connectors/build-your-own.md).

## The cohort

The ledger deliberately holds far more deals than any destination shows. Only members of `state/cohort.json`, a curated ~50, are ever pushed externally; the full multi-hundred-deal history exists to make the statistics real, since win rate, per-competitor win rates and ICP effects are all computed over the whole ledger. Membership is the *only* thing stored. Everything derived (pushed? complete?) is computed live against the ledger, so the two can't drift. Selection is deterministic (`cohort:select`) and quota-based across use cases, so every use case has enough deals in the visible window to say something about. Weekly runs auto-enroll the deals they create.

## Steering: three tiers of instruction

A routine week takes **zero input**. You set direction occasionally, and the engine remembers it.

| Tier | Lives in | Touched | Controls |
| --- | --- | --- | --- |
| 1 · Standing config | `config/*.yaml` | rarely | What to generate, detail levels, all distributions |
| 2 · Active directives | `state/directives.md` → materialized in `state/trends.json` | ~quarterly | Durable trajectory changes that persist until amended |
| 3 · Per-run nudge | `apply -- --nudge="…"` | one-off | A single period's twist; not remembered |

`state/trends.json` is the load-bearing middle: the live trajectories the engine samples from (win-rate baseline and per-quarter trend, per-competitor strength and drift, intake volume), plus a `directiveEffects` log tying each value back to the directive that set it. `directives.md` holds the human-readable intent; `trends.json` is its auditable materialization. Before applying any Tier-2 or Tier-3 instruction, the engine echoes back how it resolved it. Worked example: [operations.md](operations.md#changing-the-story).

## Verification: the coherence linter

`npm run lint` (`src/lint.ts`) is a first-class feature, not an afterthought. Two layers:

- **Structural integrity** over the whole ledger: dangling references, lost deals without loss reasons, malformed artifacts. These are `error` severity and exit non-zero.
- **Cross-system coherence** over closed deals (`--sample=N` to sample, `--opp=` to scope). Does each deal's prose name the same competitors and the same win/loss reason recorded on the deal? Prose drift on a still-fillable artifact is a `warn`. On a finalized one, an `error`.

A third mode, `--repetition`, is a warn-only cross-deal phrase detector. Distinctive prose recurring across many deals gets flagged for promotion into `prose.yaml`'s `banned_phrases`, which future prompts then prohibit. The variety system prevents repetition by construction; the detector catches what slips through.

## Module map

```
src/
  config/        # YAML schemas + loaders (zod) for every config file
  ledger/        # world schema + ledger I/O; the World zod model
  generation/    # advance (the simulation step), prompts (grounded builders),
                 # requests (emit/read bundles), ingest (validate + file),
                 # variety (seeded texture axes), names, vocab
  connectors/    # types.ts (the contract) · registry.ts · salesforce/ hubspot/ drive/ slack/
  pipeline/      # stage machinery (incl. stage-date field derivation)
  domain/        # the firmographic band vocabulary, the one copy in code
  util/          # seeded RNG · argv/usage helper · fs/date/env helpers
  clock.ts       # simulation clock
  trends.ts      # trajectory evaluation (Tier 2 materialized)
  directives.ts  # directive parsing
  cohort.ts      # cohort index + gate
  icp.ts         # ICP-fit scoring
  lint.ts        # structural + coherence + repetition checks
  reconcile.ts   # the orchestrator running connectors in registry order
  report.ts      # per-run summaries (runs/<date>-report.md)
  sales-team.ts  # rep roster builder + per-AE time-dependent win modifiers
  use-cases.ts   # primary-use-case assignment and lookup
scripts/         # init · apply · lint · cohort-* · sf-* · hubspot-* · drive-audit ·
                 # preflight · assign-use-cases · backfill-created-at ·
                 # check-secrets · lint-prose
config/          # the Tier-1 world definition (templates in config/templates/)
state/           # world.json · clock.json · trends.json · directives.md ·
                 # cohort.json · content/ · requests/ (gitignored scratch)
```

Next: the full [request protocol](request-protocol.md) · the [operations runbook](operations.md) · [getting started](getting-started.md)
