# CLAUDE.md: Claude Code operating notes for Demoverse

@AGENTS.md

The engine contract, the onboarding playbook, and the fill rules all live in
[`AGENTS.md`](AGENTS.md) (imported above). This file adds only what is
Claude-Code-specific.

## Skills

| Skill | What it runs |
| --- | --- |
| `/setup` | The onboarding playbook (AGENTS.md Part 2): interview → config → init → first increment → optional connectors |
| `/pipeline-update [weeks]` | The routine weekly increment, end to end: advance → fill via `opp-filler` subagents → ingest → lint → fix → reconcile → commit |
| `/backfill-opps [N]` | The detail-layer loop for N opportunities: plant → fill (one subagent per opp) → ingest → lint → fix → reconcile → commit per opp |

## Subagent strategy (critical for context health)

Never write result-file prose inline in the main context. Every fill goes
through the **`opp-filler`** subagent (`.claude/agents/opp-filler.md`, Read/
Write/Glob only), **one subagent per opportunity, never batched**. The main
context only runs shell commands (`apply`, `lint`, `git`) and dispatches
subagents. If a subagent hits a session limit, re-launch it for the remaining
artifacts of that same deal only.

All `apply`/`lint`/`git` commands stay serial in the main context.
`state/world.json` is written whole, last-writer-wins. Fills parallelize
freely (distinct result files).

## Overnight backfill

For a bulk detail-layer backfill, run the skill as a self-paced loop:
`/loop /backfill-opps 5`. Each iteration is independently resumable, thanks to
idempotent planting, planned-only ingest, upsert reconcile and per-opp commits.
Stop when `npm run apply -- --next=1` prints nothing.

## Session hygiene

- Past ~150k context, suggest wrapping up and continuing fresh (or `/compact`
  at a natural boundary).
- Keep tool output small: pipe long logs through `tail`/`grep`.
- Read each request prompt once; don't re-read files already in context.
