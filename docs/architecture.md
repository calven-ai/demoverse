# Architecture

Demoverse is built on one split, applied everywhere: a **deterministic TypeScript engine owns every fact** — accounts, contacts, deals, outcomes, dates, competitors, ids — and a **coding agent owns only the prose**, written from prompts that carry the exact facts and can never invent one. This document explains the machinery on the engine side: the ledger, the clock, the generation protocol, the cohort, the steering model, and the verification layer that holds it all coherent.

![The Demoverse loop: config and state feed the deterministic engine; the engine advances the pipeline and emits grounded generation requests; an agent fills the prose; the engine ingests, lints, and reconciles into the external systems, recording external ids back into the ledger.](assets/architecture.svg)

## The ledger is the source of truth

`state/world.json` — versioned JSON, committed to git — holds every entity: reps, accounts, contacts, opportunities, artifacts, and their external ids. Each run computes the *next desired state* of the world, then **reconciles** the external systems to it with idempotent upserts. Because every entity records its external id (Salesforce Id, Drive fileId, Slack message ts) after first creation, re-runs update instead of duplicating; because the ledger is committed, git history doubles as the audit trail, and a wiped destination can be rebuilt by replay.

Prose bodies live beside it in `state/content/<artifactId>.md` — committed markdown, so world diffs are readable and the whole world (structure *and* words) travels with the repo.

The corollary: **nobody hand-edits `state/world.json`.** Structure is the engine's job; the sanctioned ways to change the world are config, directives, nudges, and the request protocol.

## Entity model

- **Reps** — the fictional sales team, from `config/sales-team.yaml`, with regions and win modifiers.
- **Accounts** — companies evaluating the fictional vendor: industry, size, revenue band, region, funding stage, and an **ICP-fit tier** (high/medium/low) that biases win rate and is directly steerable.
- **Contacts** — buying-group members with titles and buying roles (economic buyer, champion, user, technical, blocker).
- **Opportunities** — account, owner, amount, stage, status, created/close dates, competitors-on-deal, win/loss reason, a **win-loss mode** (survey | interview | none), and a **primary use case**.
- **Artifacts** — the prose touch points attached to deals (and a few standalone kinds): `call_transcript`, `email_exchange`, `ae_note`, `survey`, `interview`, `slack_deal_thread`, `winloss_post`, `competitive_q`, `internal_collateral`. Each carries a status (`planned` → `generated` → `reconciled`), a grounding snapshot, and its external ids.

Every deal is *about* something: its use case names it (`<Account> - <Use Case>`) and dominates its prose. Use-case assignment is downstream of the competitor on the deal and never feeds back into the outcome — two separate knobs (`target_share` for overall frequency, mean-normalized `competitor_weights` for per-competitor skew) keep "this competitor shows up mostly in X deals" discoverable without letting the skew distort overall volume.

## Determinism and the seeded RNG

Everything the engine samples — which account a new deal lands on, deal sizes, cycle lengths, outcomes, win-loss modes, variety draws — flows through a seeded RNG keyed by the world seed plus a stable stream name (per deal, per artifact, per decision). Two consequences:

- **Replayability.** The same config and seed produce the same world. `init -- --seed=X` pins it.
- **Stability under growth.** Streams are keyed to entities, not to a global call sequence, so adding a new deal doesn't reshuffle the texture of existing ones.

The same seeding drives the **variety system** (`src/generation/variety.ts` + `config/prose.yaml`): every deal gets one stable draw per axis — a narrative angle (why this buyer is looking), a buyer tone, objection themes, a timeline pressure — plus a per-artifact structural shape, and a banned-phrase list. These are injected into prompts as the VARIETY block, and they are what keeps three hundred deals from telling the same story. Because draws are seeded picks over the arrays in `prose.yaml`, order matters: append new entries, never reorder. All axis text must be leak-safe — it may never imply a deal's eventual outcome, because the same block appears on open-stage and close artifacts.

## Clock, periods, and advance

The world advances in **periods** (default one week), tracked in `state/clock.json` as `simNow`. Plain `npm run apply` generates only the periods the real calendar has produced — run it when `simNow` is already current and it does nothing ("world already current"). `npm run pipeline` (= `apply -- --weeks=1`) *forces* one period on demand, stepping `simNow` ahead of the real date when needed; the engine warns how far ahead the world sits. That is the accepted cost of a world that moves when you want it to.

Each advanced period, the engine:

1. **Opens** new deals (rate from `state/trends.json` `volume.newOppsPerWeek`), drawing accounts, buying groups, competitors, a use case, and a full deterministic schedule.
2. **Progresses** open deals along the configured stages, on each deal's own 2–8-week cycle.
3. **Closes** deals whose cycle is up, sampling outcome from the current win-rate trajectory (biased by ICP fit and competitor strength) and a loss reason from the configured weights; assigns the win-loss mode.
4. **Plans touch points** — only the artifacts these events earned *this period*: a discovery call and maybe an intro email for a new deal, an evaluation call for a deal that just reached Evaluation, a win-loss artifact and post-mortem for a close. Grounding for each artifact is snapshotted at planning time, so an early-stage transcript reflects the world as it was at the call date and never leaks the eventual outcome.

![A single deal accumulating history across six weekly runs: discovery call and intro email in week 1, demo call and Slack thread during Evaluation, an AE note, a proposal email, and finally a win-loss interview and post-mortem when it closes in week 6.](assets/living-week.svg)

This is the **living increment**, and it's the core motion: a deal accumulates its history across many runs, exactly as a real one does. The complementary motion — the **detail-layer backfill** (`apply -- --backfill-touchpoints --opp=`) — plants the *whole* cycle of *one* deal at once, and exists solely for seeding history. The failure mode the split prevents is a freshly-opened deal with a complete past. See [operations.md](operations.md#the-two-motions) for when to use which.

## The generation-request protocol

Prose is produced through a two-phase handoff, specified fully in [request-protocol.md](request-protocol.md):

1. **Emit** — `apply` writes `state/requests/<periodIndex>/` with a `manifest.json` and one fully-grounded `<artifactId>.prompt.md` per planned artifact: fact block, grounding rules, variety block, format instructions.
2. **Fill** — the agent (or a human) writes `results/<artifactId>.md` or `.json`. Fills parallelize freely; distinct files never conflict.
3. **Ingest** — `apply -- --ingest` schema-validates each result, files markdown into `state/content/`, attaches Slack/email structures onto their artifacts, and flips status to `generated`. Failures leave the artifact `planned`, so it is simply re-requested — bad data is never filed.
4. **Reconcile** — `apply -- --reconcile` pushes generated artifacts and CRM structure through the connector chain, recording external ids.

The engine never calls an LLM. Generation runs inside whatever agent session drives the repo, which is both a cost model (subscription tokens, not metered API) and a portability guarantee (any agent — or `vi` — can fill requests).

## Connectors

Each destination is a `Connector` (`src/connectors/types.ts`) run in registry order — CRM first, so accounts exist before documents and chatter group under them. Every connector no-ops cleanly when disabled in `config/connectors.yaml` or when its credentials are absent, honors `--dry-run` and single-opportunity scoping, gates on the cohort, and records external ids. Details and the build-your-own guide: [connectors/build-your-own.md](connectors/build-your-own.md).

## The cohort

The ledger deliberately holds far more deals than any destination shows. Only members of `state/cohort.json` — a curated ~50 — are ever pushed externally; the full multi-hundred-deal history exists to make the statistics real (win rate, per-competitor win rates, ICP effects are computed over the whole ledger). Membership is the *only* thing stored; everything derived (pushed? complete?) is computed live against the ledger, so the two can't drift. Selection is deterministic (`cohort:select`) and quota-based across use cases, so every use case has enough deals in the visible window to say something about. Weekly runs auto-enroll the deals they create.

## Steering: three tiers of instruction

The design goal is that a routine week takes **zero input** — direction is set occasionally, and the engine remembers it.

| Tier | Lives in | Touched | Controls |
| --- | --- | --- | --- |
| 1 · Standing config | `config/*.yaml` | rarely | What to generate, detail levels, all distributions |
| 2 · Active directives | `state/directives.md` → materialized in `state/trends.json` | ~quarterly | Durable trajectory changes that persist until amended |
| 3 · Per-run nudge | `apply -- --nudge="…"` | one-off | A single period's twist; not remembered |

`state/trends.json` is the load-bearing middle: the live trajectories the engine actually samples from (win-rate baseline and per-quarter trend, per-competitor strength and drift, intake volume), plus a `directiveEffects` log tying each value back to the directive that set it. `directives.md` is the human-readable intent; `trends.json` is the auditable materialization; the engine echoes back how it resolved any Tier-2/Tier-3 instruction before applying it. Worked example: [operations.md](operations.md#changing-the-story).

## Verification: the coherence linter

`npm run lint` (`src/lint.ts`) is a first-class feature, not an afterthought. Two layers:

- **Structural integrity** over the whole ledger — dangling references, lost deals without loss reasons, malformed artifacts. These are `error` severity and exit non-zero.
- **Cross-system coherence** over closed deals (`--sample=N` to sample, `--opp=` to scope) — does each deal's prose name the same competitors and the same win/loss reason recorded on the deal? Prose drift on a still-fillable artifact is a `warn`; on a finalized one, an `error`.

A third mode, `--repetition`, is a warn-only cross-deal phrase detector: distinctive prose recurring across many deals gets flagged for promotion into `prose.yaml`'s `banned_phrases`, which future prompts then prohibit. The variety system prevents repetition by construction; the detector catches what slips through.

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
  clock.ts       # simulation clock
  trends.ts      # trajectory evaluation (Tier 2 materialized)
  directives.ts  # directive parsing
  cohort.ts      # cohort index + gate
  icp.ts         # ICP-fit scoring
  lint.ts        # structural + coherence + repetition checks
  reconcile.ts   # the orchestrator running connectors in registry order
  report.ts      # per-run summaries (runs/<date>-report.md)
scripts/         # init · apply · lint · cohort-* · sf-* · hubspot-* · drive-audit · preflight
config/          # the Tier-1 world definition (templates in config/templates/)
state/           # world.json · clock.json · trends.json · directives.md ·
                 # cohort.json · content/ · requests/ (gitignored scratch)
```

Next: the full [request protocol](request-protocol.md) · the [operations runbook](operations.md) · [getting started](getting-started.md)
