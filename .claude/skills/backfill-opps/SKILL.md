---
name: backfill-opps
description: Autonomously generate the detail layer for the next N opportunities of the demo world — plant touch points, fill prose via opp-filler subagents (one per opportunity), ingest, lint, fix, reconcile, and commit per opp. Use for the detail-layer backfill or whenever multiple opportunities need their artifacts generated. Args - N (number of opps, default 5).
---

# /backfill-opps [N]

Processes the next N opportunities (default 5) end-to-end with zero operator
input. The main context runs ONLY shell commands and subagent dispatch — all
prose is written by `opp-filler` subagents (model: sonnet, one per opportunity).
**Never fill result files inline in the main context.**

## The loop

### 0. Pick targets

```bash
npm run apply -- --next=N
```

Output is one opp per line: `oppId<TAB>status<TAB>accountName<TAB>untouched|planned:K`.
`planned:K` rows are planted-but-unfilled deals from an interrupted run — they
resume identically (replanting is an idempotent no-op that re-emits prompts).
If the list is empty, report "all opportunities filled" and stop.

### 1. Process in waves of 3

For each wave of up to 3 opportunities:

**a. Plant (serial — the ledger is last-writer-wins, never parallelize apply):**

For each opp in the wave:
```bash
npm run apply -- --backfill-touchpoints --opp=<oppId>
```
Then IMMEDIATELY read `state/requests/<periodIndex>/manifest.json` (the period
index is printed by the command) and record this opp's request list —
`{artifactId, kind, output, promptFile, resultFile}` per entry. The manifest is
OVERWRITTEN by the next plant, so capture it before planting the next opp.

**b. Fill (parallel):** launch the wave's `opp-filler` subagents **in ONE
message** — one subagent per opportunity, each given the absolute request dir
and only ITS opp's request list. Result files are distinct, so parallel fills
never conflict.

**c. Ingest + lint + fix + reconcile + commit (serial, one opp at a time):**

```bash
npm run apply -- --ingest --opp=<oppId>          # validate + file (no push yet)
```
- If it reports `invalid > 0`: re-launch `opp-filler` for that opp in fix mode
  with the invalid artifact ids + reasons, then re-run the ingest.

```bash
npm run lint -- --opp=<oppId>
```
- On `error` findings, run up to 2 fix rounds:
  1. For each offending artifact: `npm run apply -- --refill=<artifactId>`
     (resets it to `planned` and re-emits its prompt).
  2. Re-launch `opp-filler` in fix mode scoped to those artifacts, quoting the
     lint error messages verbatim.
  3. `npm run apply -- --ingest --opp=<oppId>` and re-lint.
- Still failing after 2 rounds → append the opp + errors to
  `runs/backfill-notes.md`, **skip the commit for this opp**, continue with the
  next one. Never stall the batch on one deal.

```bash
npm run apply -- --ingest --reconcile --opp=<oppId>   # push to SF/Drive/Slack
git add -A && git commit -m "detail layer: <oppId> (<AccountName>)"
```

### 2. Batch epilogue

```bash
npm run lint -- --sample=40 --repetition
```

Summarize for the operator: opps completed / skipped (with why), fix rounds
needed, reconcile errors, and any repetition warnings (candidates for
`BANNED_PHRASES` in `src/generation/variety.ts`).

## Rules

- **One `opp-filler` subagent per opportunity, never batched** — a subagent that
  runs out of context mid-deal gets re-launched for that same deal's remaining
  artifacts only.
- All `npm run apply` / `npm run lint` / `git` commands run serially in the main
  context (`state/world.json` writes are last-writer-wins).
- `--refill` refuses artifacts that already have external records — that is
  correct; it means the artifact was already pushed and must not be regenerated.
- Never hand-edit `state/world.json`; never pre-fill the product's derived outputs.

## Overnight operation

For the full backfill, run as a self-paced loop: `/loop /backfill-opps 5`.
Each iteration is independently resumable (idempotent planting, planned-only
ingest, upsert reconcile, per-opp commits). The loop's stop condition:
`npm run apply -- --next=1` prints nothing.
