# AGENTS.md: how a coding agent drives Demoverse

Demoverse is **operated by a coding agent, not just a human**. The deterministic
TypeScript engine does all the mechanical, error-prone work. The agent does the
judgment and the prose. This file is the contract for that handoff, readable by
any agent tool (Claude Code, Codex, Cursor, Copilot, …). It has three parts:

1. **The engine contract.** The split of responsibilities, and the
   generation-request protocol that is the core loop.
2. **The onboarding playbook.** How to walk a brand-new user from a fresh clone
   to a living world. `/setup` in Claude Code runs this. Other agents follow it
   directly.
3. **Per-tool notes.**

---

## Part 1: The engine contract

### The split (don't cross it)

| Deterministic engine (code) | Agent (you) |
| --- | --- |
| Ledger I/O, ids, referential integrity | Interpreting directives + nudges |
| Simulation clock, trend evaluation | Choosing nothing structural (the code already did) |
| Sampling the world (accounts/contacts/deals/competitors) | **Writing the prose** for each emitted request |
| Schema validation, coherence lint, reports | Editing `state/directives.md` + `state/trends.json` when direction changes |
| Reconcile (CRM/Drive/Slack upserts via the connector registry) | n/a |

**You never hand-edit `state/world.json`.** Structure is the code's job. You only:
(1) fill generation requests, and (2) when the operator sets new direction, update
`state/directives.md` + `state/trends.json`.

### The generation-request protocol (the core loop)

1. **Plan.** Run `npm run pipeline` for one living increment on demand. It
   equals `npm run apply -- --weeks=1`. Plain `npm run apply` generates only the
   periods the real calendar has produced, and `-- --backfill` covers the first
   big run. The engine advances the world: a couple of new deals, each open deal
   moved along its own cycle (usually one stage, more for a short deal, none at
   all for one that has gone quiet), closes for the deals whose cycle is up.
   Then it writes a request bundle holding **only the touch points those events
   earned**, 1–3 per deal. Never a deal's whole history. Filling that is what
   `--backfill-touchpoints` does:
   ```
   state/requests/<periodIndex>/manifest.json        # index of all requests
   state/requests/<periodIndex>/<artifactId>.prompt.md
   state/requests/<periodIndex>/results/             # ← you write here
   ```
2. **Fill.** Each `.prompt.md` is fully grounded in the exact ledger facts. For
   every request in `manifest.json`, read the prompt and write the result:
   - `output: markdown` → write `results/<artifactId>.md` (the artifact body).
   - `output: slack_messages` → write `results/<artifactId>.json` as
     `{"messages":[{"personaHandle":"…","text":"…"}, …]}`.
   - `output: email_thread` → write `results/<artifactId>.json` as
     `{"emails":[{"from":"…","to":["…"],"subject":"…","body":"…","date":"YYYY-MM-DD"}, …]}`
     (one object per message, in send order).
3. **Ingest.** Run `npm run apply -- --ingest --reconcile`. The engine validates
   each result, files markdown into `state/content/`, attaches Slack messages
   and email threads onto their artifacts, and reconciles into every connector
   that is enabled and has credentials. Anything that fails validation stays
   `planned` and reappears in the next bundle. Refill it and re-ingest.
4. **Verify.** Run `npm run lint`. Fix any `error` findings by editing the
   result and re-ingesting. The cause is usually a missing competitor name or
   win/loss reason in the prose.

### Rules for filling requests (non-negotiable)

The prompt carries `GROUNDING RULES`. Honor them exactly. In short:

- **Use only the given facts.** Never invent competitors, contacts, or companies.
- **Cross-system consistency.** A deal's transcript, win-loss artifact, and Slack
  thread must name the **same competitor(s)** and the **same win/loss reason**
  recorded on the deal. The linter checks this.
- **The primary use case is the dominant theme.** It is what the buyer came
  for, what discovery digs into, what gets demoed, what the objections are
  about. Other capabilities stay secondary.
- **`none`-mode deals:** the `#win-loss` post is the **sole** win/loss signal.
  Make it carry the whole story (outcome + reason + competitors).
- **`#competitive` questions:** write only the **human question**, never an
  answer. Answering is the job of whatever product consumes this data.
- **Detail levels** come from the prompt (`low`/`medium`/`high`): interviews are
  long and conversational, surveys are terse, transcripts are medium.
- **The VARIETY block is part of the grounding contract.** Deal prompts carry a
  seeded per-deal texture (backstory, buyer tone, objections, timeline) plus a
  per-artifact shape, and a banned-phrase list. Write from them. They are what
  keeps hundreds of deals from telling the same story. (Story banks live in
  `config/prose.yaml`; Slack persona voice cards in `config/slack-personas.yaml`.)
- **No em dashes in the artifact body.** Rewrite the sentence instead. They are
  the loudest tell that a corpus was machine-written, and `npm run lint` warns
  on every one it finds.
- All output is **clearly-fabricated demo data**. Never reference real people.

### Detail-layer backfill contract (bulk filling of existing deals)

The living increment adds 1–3 touch points per deal per week (0 for a stalled
deal that period, and a fast-track deal may end its whole life with 2). The
one-time historical seed instead fills a deal's **whole** sales cycle. Per
opportunity:

1. `npm run apply -- --next=N` lists the next opps needing work: `untouched`,
   or `planned:K` for planted-but-unfilled, which is resumable.
2. Per opp: `npm run apply -- --backfill-touchpoints --opp=<id>` (idempotent).
   **Capture the manifest immediately; the next plant overwrites it.**
3. Fill via ONE dedicated agent context per opportunity (never batch deals).
4. `npm run apply -- --ingest --opp=<id>` → fix invalid →
   `npm run lint -- --opp=<id>` → fix errors via `--refill=<artifactId>` + a
   scoped re-fill → `npm run apply -- --ingest --reconcile --opp=<id>` →
   commit `"detail layer: <id> (<Account>)"`.

`--refill` is the sanctioned way to regenerate a bad result, since you never
hand-edit `world.json`. It refuses once the artifact has external records,
because regenerating would duplicate them.

### Setting direction (Tier 2 / Tier 3)

- **Tier 3 nudge** (one period, not remembered): pass it at trigger time, as in
  `npm run apply -- --nudge="2× losses to Pricing this week"`. The engine echoes
  how it resolved it.
- **Tier 2 directive** (durable): append an entry under `## Active` in
  `state/directives.md`, **and** materialize it in `state/trends.json`. Examples:
  - "ramp velocity" → raise `volume.newOppsPerWeek`; note it in `directiveEffects`.
  - "Competitor A is getting tougher" → set
    `competitors.<name>.driftPerQuarter` positive; drop the `winRate` trend.
  Amending = move the entry to `## Superseded` and adjust from that date forward.

### Ergonomics you can rely on

- Every command is **idempotent** and supports `--dry-run`.
- Output is machine-readable enough to branch on (counts, `filled/pending/invalid`).
- `npm run lint` exits non-zero on coherence errors, so it is safe to gate a
  commit on.
- Nothing external is touched unless a connector is enabled in
  `config/connectors.yaml` **and** its credentials are present. Otherwise you
  get a clean, labeled skip.
- **Only cohort members reach external systems** (`state/cohort.json`, ~50
  curated deals). Never widen the cohort to "push everything".
- `apply -- --next=N` prints a read-only queue of opps still needing a detail
  layer.
- `apply -- --refill=<artifactId>` resets one artifact to `planned` and re-emits
  its prompt. It refuses if external records exist.
- `lint -- --opp=<id>` scopes cross-system checks to one deal.
- `npm run lint` also warns, per artifact, on any em dash in generated prose.
  Real reps don't type them, so they read as machine-written. Fix with
  `--refill=<artifactId>` and a rewritten sentence.
- `lint -- --repetition` is a warn-only repeated-phrase detector. Promote
  persistent offenders into `banned_phrases` in `config/prose.yaml`.
- Fills parallelize freely, since they write distinct result files. `apply`/`lint`
  runs must stay **serial**, because `state/world.json` is written whole
  (last-writer-wins).

---

## Part 2: The onboarding playbook (fresh clone → living world)

Claude Code users: run **`/setup`**, which executes exactly this. Any other
agent: when the user asks to get started, follow these steps in order,
checking off what already exists (every step is resumable).

**Step 0 · Preflight.** Verify `node -v` ≥ 20 and `npm ci` has run. If
`config/world.yaml` already exists, ask whether to amend or start over. Never
silently overwrite a configured world.

**Step 1 · Interview the user.** Demoverse ships templates, not a canned
company. The user's fictional company is invented here. Ask one topic at a
time, and offer to invent plausible details from a one-line seed idea
("a devtools SaaS selling error monitoring") whenever the user shrugs:

1. *The company*: name, colloquial short name, a `.example` domain (or one
   they own), a one-line product description, category.
2. *Product surface*: 2–4 product domains/modules, each with named
   capabilities ("agents"/features) and the pain each solves.
3. *Market*: 3–5 competitors, **invented by default**. Real vendor names are
   allowed if the user explicitly wants them (point them at `DISCLAIMER.md`:
   fabricated outcomes about real companies stay in their private systems).
   Industries served, company sizes, regions.
4. *Sales motion*: typical deal size band (derive pricing tiers), team size
   (generate a fictional manager/AE roster), rough win rate, dominant loss
   reasons.
5. *Buying group*: propose the template personas (Champion, Economic Buyer,
   Technical Buyer, User, Influencer); ask which roles matter and typical
   titles in their market.
6. *Prose texture*: the shipped `prose.yaml` works as-is. Offer to tailor the
   narrative angles and objection themes to the invented product (recommended).

**Step 2 · Write the config.** Copy each file from `config/templates/` to
`config/` and fill it from the interview. Keep every schema key; replace
placeholders. Then show the user a one-screen summary (company, modules,
competitors, segments, team, pricing) and get an explicit confirm before
proceeding.

**Step 3 · Validate.** Run `npm run init`. Zod validation errors name the file
and the key. Fix the config (or re-ask the user) and re-run until clean.

**Step 4 · First light.** Run `npm run apply -- --weeks=1 --dry-run` and show
the user the plan ("would create N opps, plan K artifacts"). Then run
`npm run pipeline` for real, open one generated
`state/requests/<n>/<artifactId>.prompt.md`, and fill it as the hello-world.
Ingest with `npm run apply -- --ingest`, run `npm run lint`, and show the
result. The world now exists. Entirely locally, zero credentials.

**Step 5 · Connectors (optional, one at a time).** For each system the user
wants (Salesforce / Google Drive / Slack / HubSpot): follow the matching guide
in `docs/connectors/`, write the credentials into `.env`, flip
`enabled: true` in `config/connectors.yaml`, and **verify with the cheapest
real call** before declaring success (Salesforce: a scoped
`apply -- --ingest --reconcile --opp=<one-cohort-id> --dry-run` then real;
Drive/Slack: reconcile and confirm the file/post appears). Remind the user:
isolated, dedicated orgs and workspaces only.

**Step 6 · Wrap.** Commit everything
(`git commit -m "demoverse: initial world for <Company>"`), and print the
weekly routine: `npm run pipeline` → fill → `npm run apply -- --ingest
--reconcile` → `npm run lint` → commit.

---

## Part 3: Per-tool notes

**Claude Code** gets the richest integration. `/setup` (this playbook),
`/pipeline-update` (the weekly increment end to end), and `/backfill-opps N`
(the detail-layer loop) live in `.claude/skills/`. The `opp-filler` subagent
(`.claude/agents/opp-filler.md`) fills one opportunity per subagent, so the main
context stays lean. `CLAUDE.md` imports this file. For a long backfill, run
`/backfill-opps` iteratively and commit per opportunity.

**Codex / Cursor / other AGENTS.md-aware tools**: this file is the whole
contract, with no extra setup. Follow Part 2 for onboarding and Part 1 for the
weekly loop. Mirror the context-hygiene rule by hand: fill **one opportunity
per session/task**, keep `apply`/`lint` serial, and commit per opportunity
during backfills.

**No agent at all**: the engine itself runs fine without one, but nothing in the
repo generates the prose for you, so the artifacts stay empty until a model
writes them. The prompts in `state/requests/` are self-contained briefs a human
can fill by hand, which is useful for a handful of artifacts and hopeless for a
world of them. The realistic no-agent path is scripting your own filler:
`docs/request-protocol.md` specifies the result formats for any generator you
point at a model API of your choosing.
