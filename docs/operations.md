# Operations

This is the runbook for a world that's already alive: the weekly routine, the two motions and why they must never be confused, cohort curation, steering the story, triaging lint findings, and the reset paths. If you're setting up for the first time, start with [getting-started.md](getting-started.md).

## The weekly routine

Most weeks the whole operation is five steps and zero decisions:

```bash
npm run pipeline                        # 1. one increment: open · progress · close · plan touch points
# 2. fill state/requests/<idx>/results/  (your agent; see request-protocol.md)
npm run apply -- --ingest --reconcile   # 3. validate, file, push
npm run lint                            # 4. verify coherence, fix errors, re-ingest
git add -A && git commit -m "pipeline increment $(date +%F)"
```

The repo ships a `/pipeline-update` command for coding agents that encodes the whole loop, including dispatching one fill subagent per touched deal. Useful per-run knobs:

```bash
npm run apply -- --weeks=4              # jump a month in one go
npm run apply -- --new-opps=5           # one-off heavier intake (trends untouched)
npm run apply -- --weeks=1 --dry-run    # preview the increment, write nothing
npm run apply -- --nudge="close one big enterprise win this week"   # Tier-3 twist
```

If intake should *stay* higher, that's not a flag. That's a Tier-2 change (below).

After each advance, `apply` prints a touch-point table grouped by deal. Some rows are labeled `(workspace)`, meaning "workspace-level (not tied to one deal)". Those are expected, not an error. The weekly `#competitive` questions belong to the world as a whole, not to any one opportunity.

Three commands advance the world, so a note on run modes. `npm run pipeline` forces exactly one week. Plain `npm run apply` generates every period the real calendar has produced. On a fresh world whose clock starts quarters in the past, that's the *entire* back-catalog at once. `npm run apply -- --backfill` is the same catch-up run under its intent flag: the one-time historical seed, a large fill job best driven by an agent loop. The first-run fork is laid out in [getting-started.md](getting-started.md#the-clock-starts-in-the-past-so-pick-your-first-run-path).

## The two motions

| | Living increment | Detail-layer backfill |
| --- | --- | --- |
| Command | `npm run pipeline` (`/pipeline-update`) | `apply -- --backfill-touchpoints --opp=` (`/backfill-opps`) |
| Motion | a thin slice across **many** deals | the **whole** sales cycle of **one** deal |
| Per deal | 1–3 touch points, this stage only | every artifact the deal will ever have |
| When | the routine run, forever | once, to seed history |

The living increment is the core motion, and what keeps the world believable. A deal opened this week has one discovery call and maybe an intro email. Its Evaluation call happens in a *later* run, once it reaches Evaluation. The backfill exists to give historical deals their past. Confuse the two and you generate a full detail layer for a freshly-opened deal, and a deal born with a complete history reads as fake on sight.

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

Stop when `--next=1` prints nothing. Got a bad result mid-loop? `npm run apply -- --refill=<artifactId>` resets it to `planned` and re-emits the prompt. It refuses once external records exist (see [request-protocol.md](request-protocol.md#refilling-a-bad-result)).

## The cohort

Only deals in `state/cohort.json` ever reach external systems. It's a curated ~50-deal window over a ledger that holds hundreds. The ledger's depth is what makes the statistics real. The cohort's smallness is what keeps the demo browsable and the destinations under their caps. Never widen the cohort to "just push everything". Add deals via selection, or let weekly runs auto-enroll the ones they create.

```bash
npm run cohort                          # status table + regenerate the summary
npm run cohort -- --pending             # members still needing generation
npm run cohort:select                   # (re)pick membership, deterministic
npm run cohort:prune-slack              # drop unfilled Slack artifacts from seed members
npm run cohort:prune-winloss            # report win-loss coverage across the cohort
npm run sf:purge -- --noncohort         # shrink the CRM org to the cohort (dry-run by default)
```

Two mix rules are worth checking after any bulk generation. Config is not self-evidently correct, and the mix it produces is the check:

- **Win-loss scarcity.** Roughly one closed deal in three carries a survey or interview (`world.yaml` `winloss.mode_mix`, `none` ≈ 0.67). If most of your cohort's closed deals have one, reconcile the config before generating prose. A world where every close gets a debrief reads as generated, and absence stops meaning anything.
- **Slack is weekly-members-only.** Seed-sourced cohort members never get Slack artifacts ([why](connectors/slack.md#the-weekly-members-only-rule)).

## Changing the story

Some direction changes durably. "From now on, win rate climbs." That's a **Tier-2 directive**: recorded in `state/directives.md`, materialized in `state/trends.json`, applied automatically every run until amended. Worked example, "ramp win rate over the next two quarters":

1. Append under `## Active` in `state/directives.md`:

   ```markdown
   - **2026-08-13 · Win rate ramp.** Climb from ~48% toward ~56% over two quarters, then hold.
     → trends.json: winRate.baseline 0.48, winRate.trendPerQuarter +0.04.
   ```

2. Materialize it in `state/trends.json` and log it in `directiveEffects`:

   ```jsonc
   "winRate": { "baseline": 0.48, "trendPerQuarter": 0.04 }
   ```

The common mappings: deal velocity → `volume.newOppsPerWeek`; a competitor getting tougher → `competitors.<name>.driftPerQuarter`; win-rate trajectory → `winRate.baseline` / `winRate.trendPerQuarter`. Amending later moves the old entry to `## Superseded` and adjusts the trajectory from that date forward. Data already written stays. Only the path ahead changes. The engine echoes back how it resolved any directive or nudge before applying it, so read the echo.

## Lint triage

`npm run lint` exits non-zero on errors. Safe to gate commits on.

- **`error`**. Must fix. Structural breakage (dangling references, a lost deal with no loss reason), or finalized prose that contradicts the record (wrong competitor, wrong reason on an artifact that can no longer be refilled). Fix structure by rerunning the engine step that owns it. Fix prose via `--refill` + re-fill + re-ingest.
- **`warn`**. Judgment. Prose drift on a still-fillable artifact, thin coverage, mix skews. Batch these up and fix opportunistically.

Scope with `--opp=<id>` while iterating on one deal, `--sample=N` to bound the cross-system pass on big ledgers.

**The em-dash check** (part of every `npm run lint`, warn-only) flags any artifact whose prose contains an em dash. Nobody types one into a CRM note, so a corpus full of them reads as generated on sight. The prompts already prohibit them; a warning means one slipped through. Fix it with `apply -- --refill=<artifactId>` and a re-fill, not a hand-edit.

**The repetition detector** (`npm run lint -- --repetition`, warn-only) flags distinctive phrases recurring across deals. That's the tell of an agent-generated corpus. Promote persistent offenders into `config/prose.yaml` `banned_phrases`, and every future prompt then prohibits them. Run it after any bulk fill.

## When simNow runs ahead of real time

`npm run pipeline` *forces* a period, so records land a few days in the future and the engine warns how far ahead the world sits. That's the accepted cost of a world that moves on demand. Plain `npm run apply` (no flags) generates only what the real calendar has produced, and prints "world already current" when there's nothing to do. The gap self-heals as real time catches up. Don't force weeks faster than you want the demo's "today" to drift.

## Purge and reset

External purges (all dry-run by default; add `--confirm`):

```bash
npm run sf:purge -- --noncohort|--sample|--activities|--all   # Salesforce (recycle bin, 15 days)
npm run hubspot:purge                                          # HubSpot (recycling bin, 90 days)
npm run drive:audit -- --purge                                 # Drive orphans (trash, 30 days)
```

Slack posts age out on their own on the free plan's 90-day window.

**Full reset**, for a genuinely new world:

```bash
npm run init -- --force        # regenerate state/ from config; the old ledger is gone
```

Order matters when destinations are connected. Purge the external systems *first* (`sf:purge -- --all`, `hubspot:purge`), because the new ledger carries no external ids and cannot clean up after the old one. Drive is the sharpest edge. After any `init --force`, run `npm run drive:audit` and purge the orphans. Otherwise a watched-folder integration will happily ingest ghosts of the previous world ([details](connectors/google-drive.md#driveaudit-and-the-orphan-hazard)).

## Real target-account names (optional, advanced)

By default every account is invented: names come from the engine's own name
banks and nothing in the world corresponds to a real company. That is the
recommended setup, and it is what you get if you do nothing.

If you have curated lists of real *logos* you are allowed to demo with, the
`prospects` block in `config/world.yaml` points the generator at them. The
engine then draws each account's **name, domain, industry and firmographics**
from your CSVs. Everything else stays synthetic: contacts, the buying group,
the pipeline, the outcomes, the prose.

```yaml
prospects:
  enabled: true
  dir: data/prospects          # relative to the repo root, and yours to gitignore
  files:
    - { file: fintech.csv, industry: Financial Services }
    - { file: mixed-emea.csv, region: EMEA }
```

Each CSV needs a header row. Columns are matched by name, first hit wins, and
everything except the first two is optional:

| Field | Accepted headers |
| --- | --- |
| Company name (required) | `Company`, `Name` |
| Domain (required) | `Website`, `Domain`, `Domains` |
| Industry | `Sub-Category`, `Industry/Vertical`, `Vertical`, `Industry` |
| Employee count | `Est. Employees`, `Employees` |
| Headquarters | `Headquarters (City; Country)`, `Location`, `HQ`, `Headquarters` |
| Funding status | `Funding/Acquisition Status`, `Acquisition Status`, `Funding` |

Rows without a usable name and domain are dropped. So are rows whose industry
resolves outside `segments.industries`, because letting them in would skew the
planted industry mix. A per-file `industry:` maps a single-vertical list
wholesale; leave it off for mixed lists and let `segments.industry_keywords`
route each row. Lists are merged and deduplicated by domain, and the pool falls
back to synthetic names whenever a bucket runs dry, so generation never fails
because a list was short.

Three things worth being deliberate about:

- **The CSVs live outside the ledger.** Nothing is copied into `state/`. Keep
  the source lists wherever you keep them and gitignore `dir` if it sits in
  the repo.
- **Real logos, never real people.** Contacts keep fabricated names on
  non-resolving `.example` domains. Do not "improve" this by importing
  contact rows.
- **The outcomes are fabricated.** A real company name now sits on an invented
  won/lost deal with invented pricing feedback and invented quotes. That
  belongs in your private demo systems and nowhere else. See
  [DISCLAIMER.md](../DISCLAIMER.md).

Set `enabled: false` (or delete the block) to go back to fully synthetic. The
golden snapshot runs with the pool disabled, so the synthetic path stays the
tested default.

## Command reference

| Command | What |
| --- | --- |
| `npm run init [-- --force] [-- --seed=X]` | Scaffold (or regenerate) `state/` from config |
| `npm run pipeline` | One forced weekly increment (= `apply -- --weeks=1`) |
| `npm run apply` | Generate every period the real calendar has produced (a fresh world's whole back-catalog) |
| `npm run apply -- --ingest [--reconcile] [--opp=]` | Validate + file results (+ push) |
| `npm run apply -- --backfill` | The one-time historical seed: the same catch-up run, under its intent flag |
| `npm run apply -- --backfill-touchpoints --opp=` | Plant one deal's full detail layer |
| `npm run apply -- --next=N` / `--refill=<artifactId>` | Backfill queue / reset one artifact |
| `npm run lint [-- --sample=N] [-- --opp=] [-- --repetition]` | Coherence linter |
| `npm run cohort` / `cohort:select` / `cohort:prune-*` | Cohort status / selection / pruning |
| `npm run sf:setup` / `sf:stage-fields` / `sf:purge` | Salesforce provisioning / purge |
| `npm run hubspot:setup` / `import` / `verify` / `purge` | HubSpot lifecycle |
| `npm run drive:audit` | Drive orphan audit |
| `npm run preflight` | Verify planted trends are statistically visible; export CSVs |
| `npm run test` / `typecheck` / `lint:code` / `format` | Engine development checks |

Everything supports `--dry-run`; everything destructive defaults to it. The
three main entrypoints document themselves: `npm run apply -- --help`,
`npm run init -- --help`, `npm run lint -- --help`.
