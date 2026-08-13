# Operations

This is the runbook for a world that's already alive: the weekly routine, the two motions and why they must never be confused, cohort curation, steering the story, triaging lint findings, and the reset paths. If you're setting up for the first time, start with [getting-started.md](getting-started.md).

## The weekly routine

Most weeks the whole operation is five steps and zero decisions:

```bash
npm run pipeline                        # 1. one increment: open · progress · close · plan touch points
# 2. fill state/requests/<idx>/results/  (your agent; see request-protocol.md)
npm run apply -- --ingest --reconcile   # 3. validate, file, push
npm run lint                            # 4. verify coherence — fix errors, re-ingest
git add -A && git commit -m "pipeline increment $(date +%F)"
```

The repo ships a `/pipeline-update` command for coding agents that encodes the whole loop, including dispatching one fill subagent per touched deal. Useful per-run knobs:

```bash
npm run apply -- --weeks=4              # jump a month in one go
npm run apply -- --new-opps=5           # one-off heavier intake (trends untouched)
npm run apply -- --weeks=1 --dry-run    # preview the increment, write nothing
npm run apply -- --nudge="close one big enterprise win this week"   # Tier-3 twist
```

If intake should *stay* higher, that's not a flag — it's a Tier-2 change (below).

After each advance, `apply` prints a touch-point table grouped by deal. Rows labeled `(workspace)` — "workspace-level (not tied to one deal)" — are expected, not an error: workspace-level artifacts (the weekly `#competitive` questions) belong to the world as a whole, not to any one opportunity.

A note on run modes, since three commands advance the world: `npm run pipeline` forces exactly one week; plain `npm run apply` generates every period the real calendar has produced (on a fresh world whose clock starts quarters in the past, that's the *entire* back-catalog at once); `npm run apply -- --backfill` is the same catch-up run under its intent flag — the one-time historical seed, a large fill job best driven by an agent loop. The first-run fork is laid out in [getting-started.md](getting-started.md#the-clock-starts-in-the-past--pick-your-first-run-path).

## The two motions — never confuse them

| | Living increment | Detail-layer backfill |
| --- | --- | --- |
| Command | `npm run pipeline` (`/pipeline-update`) | `apply -- --backfill-touchpoints --opp=` (`/backfill-opps`) |
| Motion | a thin slice across **many** deals | the **whole** sales cycle of **one** deal |
| Per deal | 1–3 touch points, this stage only | every artifact the deal will ever have |
| When | the routine run, forever | once, to seed history |

The living increment is the core motion and what keeps the world believable: a deal opened this week has one discovery call and maybe an intro email — its Evaluation call happens in a *later* run, when it actually reaches Evaluation. The backfill exists to give historical deals their past. The failure mode the split prevents is generating a full detail layer for a freshly-opened deal — a deal born with a complete history reads as fake on sight.

The backfill loop, per opportunity (resume-safe, one deal at a time):

```bash
npm run apply -- --next=10                          # list opps still needing a detail layer
npm run apply -- --backfill-touchpoints --opp=<id>  # plant + emit prompts for one deal
# … fill results …
npm run apply -- --ingest --opp=<id>
npm run lint -- --opp=<id>
npm run apply -- --ingest --reconcile --opp=<id>
git add -A && git commit -m "detail layer: <id>"
```

Stop when `--next=1` prints nothing. A bad result mid-loop: `npm run apply -- --refill=<artifactId>` resets it to `planned` and re-emits the prompt (refuses once external records exist — see [request-protocol.md](request-protocol.md#refilling-a-bad-result)).

## The cohort

Only deals in `state/cohort.json` ever reach external systems — a curated ~50-deal window over a ledger that holds hundreds. The ledger's depth is what makes the statistics real; the cohort's smallness is what keeps the demo browsable and the destinations under their caps. Never widen the cohort to "just push everything"; add deals via selection or let weekly runs auto-enroll the ones they create.

```bash
npm run cohort                          # status table + regenerate the summary
npm run cohort -- --pending             # members still needing generation
npm run cohort:select                   # (re)pick membership — deterministic
npm run cohort:prune-slack              # drop unfilled Slack artifacts from seed members
npm run cohort:prune-winloss            # report win-loss coverage across the cohort
npm run sf:purge -- --noncohort         # shrink the CRM org to the cohort (dry-run by default)
```

Two mix rules worth checking after any bulk generation, because config is not self-evidently correct — the mix it produces is the check:

- **Win-loss scarcity.** Roughly one closed deal in three carries a survey or interview (`world.yaml` `winloss.mode_mix`, `none` ≈ 0.67). If most of your cohort's closed deals have one, reconcile the config before generating prose — a world where every close gets a debrief reads as generated, and absence stops meaning anything.
- **Slack is weekly-members-only.** Seed-sourced cohort members never get Slack artifacts ([why](connectors/slack.md#the-weekly-members-only-rule)).

## Changing the story

When direction changes durably — "from now on, win rate climbs" — it becomes a **Tier-2 directive**: recorded in `state/directives.md`, materialized in `state/trends.json`, applied automatically every run until amended. Worked example, "ramp win rate over the next two quarters":

1. Append under `## Active` in `state/directives.md`:

   ```markdown
   - **2026-08-13 · Win rate ramp** — climb from ~48% toward ~56% over two quarters, then hold.
     → trends.json: winRate.baseline 0.48, winRate.trendPerQuarter +0.04.
   ```

2. Materialize it in `state/trends.json` and log it in `directiveEffects`:

   ```jsonc
   "winRate": { "baseline": 0.48, "trendPerQuarter": 0.04 }
   ```

The common mappings: deal velocity → `volume.newOppsPerWeek`; a competitor getting tougher → `competitors.<name>.driftPerQuarter`; win-rate trajectory → `winRate.baseline` / `winRate.trendPerQuarter`. Amending later moves the old entry to `## Superseded` and adjusts the trajectory from that date forward — data already written stays; only the path ahead changes. The engine echoes back how it resolved any directive or nudge before applying it; read the echo.

## Lint triage

`npm run lint` exits non-zero on errors — safe to gate commits on.

- **`error`** — must fix. Structural breakage (dangling references, a lost deal with no loss reason) or finalized prose that contradicts the record (wrong competitor, wrong reason on an artifact that can no longer be refilled). Fix structure by rerunning the engine step that owns it; fix prose via `--refill` + re-fill + re-ingest.
- **`warn`** — judgment. Prose drift on a still-fillable artifact, thin coverage, mix skews. Batch these up; fix opportunistically.

Scope with `--opp=<id>` while iterating on one deal, `--sample=N` to bound the cross-system pass on big ledgers.

**The repetition detector** (`npm run lint -- --repetition`, warn-only) flags distinctive phrases recurring across deals — the tell of agent-generated corpora. Promote persistent offenders into `config/prose.yaml` `banned_phrases`; every future prompt then prohibits them. Run it after any bulk fill.

## When simNow runs ahead of real time

`npm run pipeline` *forces* a period, so records land a few days in the future and the engine warns how far ahead the world sits — accepted cost of a world that moves on demand. Plain `npm run apply` (no flags) generates only what the real calendar has produced, and prints "world already current" when there's nothing to do; the gap self-heals as real time catches up. Don't force weeks faster than you want the demo's "today" to drift.

## Purge and reset

External purges (all dry-run by default; add `--confirm`):

```bash
npm run sf:purge -- --noncohort|--sample|--activities|--all   # Salesforce (recycle bin, 15 days)
npm run hubspot:purge                                          # HubSpot (recycling bin, 90 days)
npm run drive:audit -- --purge                                 # Drive orphans (trash, 30 days)
```

Slack posts age out on their own on the free plan's 90-day window.

**Full reset** — a genuinely new world:

```bash
npm run init -- --force        # regenerate state/ from config; the old ledger is gone
```

Order matters when destinations are connected: purge the external systems *first* (`sf:purge -- --all`, `hubspot:purge`), because the new ledger carries no external ids and cannot clean up after the old one. Drive is the sharpest edge — after any `init --force`, run `npm run drive:audit` and purge the orphans, or a watched-folder integration will happily ingest ghosts of the previous world ([details](connectors/google-drive.md#driveaudit-and-the-orphan-hazard)).

## Command reference

| Command | What |
| --- | --- |
| `npm run init [-- --force] [-- --seed=X]` | Scaffold (or regenerate) `state/` from config |
| `npm run pipeline` | One forced weekly increment (= `apply -- --weeks=1`) |
| `npm run apply` | Generate every period the real calendar has produced (a fresh world's whole back-catalog) |
| `npm run apply -- --ingest [--reconcile] [--opp=]` | Validate + file results (+ push) |
| `npm run apply -- --backfill` | The one-time historical seed — the same catch-up run, under its intent flag |
| `npm run apply -- --backfill-touchpoints --opp=` | Plant one deal's full detail layer |
| `npm run apply -- --next=N` / `--refill=<artifactId>` | Backfill queue / reset one artifact |
| `npm run lint [-- --sample=N] [-- --opp=] [-- --repetition]` | Coherence linter |
| `npm run cohort` / `cohort:select` / `cohort:prune-*` | Cohort status / selection / pruning |
| `npm run sf:setup` / `sf:stage-fields` / `sf:purge` | Salesforce provisioning / purge |
| `npm run hubspot:setup` / `import` / `verify` / `purge` | HubSpot lifecycle |
| `npm run drive:audit` | Drive orphan audit |
| `npm run preflight` | Verify planted trends are statistically visible; export CSVs |
| `npm run test` / `typecheck` / `lint:code` / `format` | Engine development checks |

Everything supports `--dry-run`; everything destructive defaults to it.
