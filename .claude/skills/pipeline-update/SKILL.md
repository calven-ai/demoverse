---
name: pipeline-update
description: Advance the demo world one living increment — move open deals a stage, close the ones whose cycle is up, open a couple of new deals, and generate ONLY the one-or-two touch points each of them earned this period. Use for the routine "make the pipeline move" run. Args - weeks (default 1), --new-opps=N for a one-off heavier intake.
---

# /pipeline-update

The heartbeat of the demo world. One increment = one week of a real B2B SaaS
pipeline: a couple of deals open, the open ones each take one step forward, the
ones that have run their cycle close, and every one of those events leaves the
one or two touch points a real team would have left behind.

**This is not `/backfill-opps`.** That one takes a deal that already exists and
generates its *entire* sales cycle at once — the historical seed motion. This one
adds a thin slice of new life to *many* deals. Never generate a full detail layer
for a deal here: a deal born this week has had exactly one discovery call, and
maybe an intro email. Its Evaluation call has not happened yet — it happens in a
later increment, when the deal reaches Evaluation.

## Steps

1. **Advance.** `npm run pipeline` (one week). For a longer jump or a heavier
   intake: `npm run apply -- --weeks=N --new-opps=M`.

   The engine echoes the active Tier-2 directives, the resolved increment, and
   any `--new-opps` override before writing anything — read that back and confirm
   it is what was asked for. It then prints **touch points planted this
   increment**, grouped by deal:

   ```
   opp-291  Acme Corp — Discovery/open      art-xxx:call_transcript art-xxy:email_exchange
   opp-285  Daktela — Negotiation/open      art-xxz:call_transcript
   opp-278  Orchard Ledger — Closed/lost    art-xya:survey art-xyb:ae_note
   ```

   That grouping is the work list. A forced increment steps `simNow` past the
   real calendar; the engine warns how far ahead the world will sit. If it is
   already several periods ahead, say so and let the operator decide before
   continuing.

2. **Fill — one `opp-filler` subagent per deal, in parallel.** An increment is
   small (a handful of artifacts spread over several deals), so launch the whole
   wave at once: one subagent per `opp-` line above, plus one for any unattached
   artifacts (`competitive_q`). Give each the request dir
   (`state/requests/<periodIndex>/`) and only *its* artifact ids.

   Never write result prose inline in the main context, and never give one
   subagent two deals.

   Output contracts (also in each prompt file):
   - `output: markdown` → `results/<artifactId>.md`
   - `output: slack_messages` → `results/<artifactId>.json` = `{"messages":[{"personaHandle","text"}]}`
   - `output: email_thread` → `results/<artifactId>.json` = `{"emails":[{"from","to":[…],"subject","body","date","contactRef"}]}`

   **What "one increment of a deal" means for the prose.** Each artifact is a
   single moment in an ongoing relationship, not a recap of the whole deal:
   - A **new** deal's discovery call is a first conversation — nobody has seen a
     demo, pricing has not come up, the buying group is half-formed.
   - A **progressed** deal's artifact picks up where the last one left off. The
     prompt carries the deal's recorded facts (stage, competitors, buying group,
     use case); the new touch point moves exactly one stage's worth of ground.
   - A **closing** deal's artifacts carry the recorded outcome and reason.
   - The deal's **primary use case stays the dominant theme** across every
     artifact it will ever have, increment after increment.

3. **Ingest.** `npm run apply -- --ingest`. Anything that fails validation stays
   `planned` and is listed — re-launch that deal's `opp-filler` in fix mode for
   just those artifacts, then ingest again.

4. **Lint.** `npm run lint`. Fix `error` findings (usually a competitor name or
   loss reason that drifted from the record) with
   `npm run apply -- --refill=<artifactId>` → refill → re-ingest. Cap at two
   rounds; report anything still failing rather than grinding.

5. **Push.** `npm run apply -- --ingest --reconcile`. Only cohort members reach
   Salesforce/Drive/Slack — deals created by this run auto-enroll as `weekly`
   (full layer, Slack included); pre-existing non-cohort deals progress in the
   ledger only, which is intended.

6. **Commit.** `git add -A && git commit -m "pipeline increment $(date +%F)"`.

7. **Report** to the operator: deals opened, deals progressed (with the stage
   they entered), deals closed won/lost, artifacts generated, and anything left
   unresolved.

## Watch for

- **Detail-layer creep.** If a single deal in the work list has more than ~3
  artifacts this increment, something is wrong — check whether
  `--backfill-touchpoints` was run by mistake. The whole point is that a deal
  accumulates its history a slice at a time.
- **Win-loss scarcity.** ~2 closed deals in 3 carry no survey or interview
  (`config/world.yaml` `winloss.mode_mix`, `none: 0.67`). If most of an
  increment's closes have one, stop and reconcile the config before generating —
  see CLAUDE.md.
- **Clock drift.** Every forced increment moves the world a week past reality.
  Run one when you want the pipeline to move; do not run five in a row to
  simulate five weeks unless the operator asked for exactly that.
- **Standing volume vs. one-off.** `--new-opps` is a one-off. To change the rate
  for good, amend `state/directives.md` + `state/trends.json`
  (`volume.newOppsPerWeek`) — Tier 2, per CLAUDE.md.
