# AGENTS.md — how a coding agent drives Demoverse

Demoverse is **operated by a coding agent, not just a human**. The deterministic
TypeScript engine does all the mechanical, error-prone work; the agent does the
judgment + prose. This file is the contract for that handoff, readable by any
agent tool (Claude Code, Codex, Cursor, Copilot, …). It has three parts:

1. **The engine contract** — the split of responsibilities and the
   generation-request protocol (the core loop).
2. **The onboarding playbook** — how to walk a brand-new user from a fresh
   clone to a living world (`/setup` in Claude Code runs this; other agents
   follow it directly).
3. **Per-tool notes.**

---

## Part 1 — The engine contract

### The split (don't cross it)

| Deterministic engine (code) | Agent (you) |
| --- | --- |
| Ledger I/O, ids, referential integrity | Interpreting directives + nudges |
| Simulation clock, trend evaluation | Choosing nothing structural — the code already did |
| Sampling the world (accounts/contacts/deals/competitors) | **Writing the prose** for each emitted request |
| Schema validation, coherence lint, reports | Editing `state/directives.md` + `state/trends.json` when direction changes |
| Reconcile (CRM/Drive/Slack upserts via the connector registry) | — |

**You never hand-edit `state/world.json`.** Structure is the code's job. You only:
(1) fill generation requests, and (2) when the operator sets new direction, update
`state/directives.md` + `state/trends.json`.

### The generation-request protocol (the core loop)

1. **Plan** — run `npm run pipeline` (one living increment, on demand; equals
   `npm run apply -- --weeks=1`), or plain `npm run apply` to generate only the
   periods the real calendar has produced, or `-- --backfill` for the first big
   run. The engine advances the world — a couple of new deals, one stage forward
   for each open deal, closes for the deals whose cycle is up — and writes a
   request bundle holding **only the touch points those events earned** (1–3 per
   deal, never a deal's whole history; that is `--backfill-touchpoints`):
   ```
   state/requests/<periodIndex>/manifest.json        # index of all requests
   state/requests/<periodIndex>/<artifactId>.prompt.md
   state/requests/<periodIndex>/results/             # ← you write here
   ```
2. **Fill** — for each request in `manifest.json`, read its `.prompt.md` (it is
   fully grounded in the exact ledger facts) and write the result:
   - `output: markdown` → write `results/<artifactId>.md` (the artifact body).
   - `output: slack_messages` → write `results/<artifactId>.json` as
     `{"messages":[{"personaHandle":"…","text":"…"}, …]}`.
   - `output: email_thread` → write `results/<artifactId>.json` as
     `{"emails":[{"from":"…","to":["…"],"subject":"…","body":"…","date":"YYYY-MM-DD"}, …]}`
     (one object per message, in send order).
3. **Ingest** — run `npm run apply -- --ingest --reconcile`. The engine validates
   each result, files markdown into `state/content/`, attaches Slack messages
   and email threads onto their artifacts, and reconciles into every connector
   that is enabled and has credentials. Anything that fails validation stays
   `planned` and reappears in the next bundle — just refill and re-ingest.
4. **Verify** — run `npm run lint`. Fix any `error` findings (usually a missing
   competitor name or win/loss reason in the prose) by editing the result and
   re-ingesting.

### Rules for filling requests (non-negotiable)

The prompt carries `GROUNDING RULES`; honor them exactly. In short:

- **Use only the given facts.** Never invent competitors, contacts, or companies.
- **Cross-system consistency.** A deal's transcript, win-loss artifact, and Slack
  thread must name the **same competitor(s)** and the **same win/loss reason**
  recorded on the deal. The linter checks this.
- **The primary use case is the dominant theme.** It is what the buyer came
  for, what discovery digs into, what gets demoed, what the objections are
  about. Other capabilities stay secondary.
- **`none`-mode deals:** the `#win-loss` post is the **sole** win/loss signal —
  make it carry the whole story (outcome + reason + competitors).
- **`#competitive` questions:** write only the **human question**, never an
  answer — answering is the job of whatever product consumes this data.
- **Detail levels** come from the prompt (`low`/`medium`/`high`): interviews are
  long and conversational; surveys are terse; transcripts are medium.
- **The VARIETY block is part of the grounding contract.** Deal prompts carry a
  seeded per-deal texture (backstory, buyer tone, objections, timeline) plus a
  per-artifact shape, and a banned-phrase list. Write from them — they are what
  keeps hundreds of deals from telling the same story. (Story banks live in
  `config/prose.yaml`; Slack persona voice cards in `config/slack-personas.yaml`.)
- All output is **clearly-fabricated demo data**; never reference real people.

### Detail-layer backfill contract (bulk filling of existing deals)

The living increment adds 1–3 touch points per deal per week; the one-time
historical seed instead fills a deal's **whole** sales cycle. Per opportunity:

1. `npm run apply -- --next=N` — list the next opps needing work
   (`untouched`, or `planned:K` = planted-but-unfilled, i.e. resumable).
2. Per opp: `npm run apply -- --backfill-touchpoints --opp=<id>` (idempotent).
   **Capture the manifest immediately; the next plant overwrites it.**
3. Fill via ONE dedicated agent context per opportunity (never batch deals).
4. `npm run apply -- --ingest --opp=<id>` → fix invalid →
   `npm run lint -- --opp=<id>` → fix errors via `--refill=<artifactId>` + a
   scoped re-fill → `npm run apply -- --ingest --reconcile --opp=<id>` →
   commit `"detail layer: <id> (<Account>)"`.

`--refill` is the sanctioned way to regenerate a bad result (you never hand-edit
`world.json`); it refuses once the artifact has external records, because
regenerating would duplicate them.

### Setting direction (Tier 2 / Tier 3)

- **Tier 3 nudge** (one period, not remembered): pass at trigger time —
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
- `npm run lint` exits non-zero on coherence errors — safe to gate a commit on it.
- Nothing external is touched unless a connector is enabled in
  `config/connectors.yaml` **and** its credentials are present; otherwise a
  clean, labeled skip.
- **Only cohort members reach external systems** (`state/cohort.json`, ~50
  curated deals). Never widen the cohort to "push everything".
- `apply -- --next=N` — read-only queue of opps still needing a detail layer.
- `apply -- --refill=<artifactId>` — reset one artifact to `planned` and
  re-emit its prompt (refuses if external records exist).
- `lint -- --opp=<id>` — scope cross-system checks to one deal.
- `lint -- --repetition` — warn-only repeated-phrase detector; promote
  persistent offenders into `banned_phrases` in `config/prose.yaml`.
- Fills parallelize freely (distinct result files); `apply`/`lint` runs must stay
  **serial** — `state/world.json` is written whole (last-writer-wins).

---

## Part 2 — The onboarding playbook (fresh clone → living world)

Claude Code users: run **`/setup`**, which executes exactly this. Any other
agent: when the user asks to get started, follow these steps in order,
checking off what already exists (every step is resumable).

**Step 0 · Preflight.** Verify `node -v` ≥ 20 and `npm ci` has run. If
`config/world.yaml` already exists, ask whether to amend or start over —
never silently overwrite a configured world.

**Step 1 · Interview the user.** Demoverse ships templates, not a canned
company — the user's fictional company is invented here. Ask, one topic at a
time, and offer to invent plausible details from a one-line seed idea
("a devtools SaaS selling error monitoring") whenever the user shrugs:

1. *The company*: name, colloquial short name, a `.example` domain (or one
   they own), a one-line product description, category.
2. *Product surface*: 2–4 product domains/modules, each with named
   capabilities ("agents"/features) and the pain each solves.
3. *Market*: 3–5 competitors — **invented by default**; real vendor names are
   allowed if the user explicitly wants them (point them at `DISCLAIMER.md`:
   fabricated outcomes about real companies stay in their private systems).
   Industries served, company sizes, regions.
4. *Sales motion*: typical deal size band (derive pricing tiers), team size
   (generate a fictional manager/AE roster), rough win rate, dominant loss
   reasons.
5. *Buying group*: propose the template personas (Champion, Economic Buyer,
   Technical Buyer, User, Influencer); ask which roles matter and typical
   titles in their market.
6. *Prose texture*: the shipped `prose.yaml` works as-is; offer to tailor the
   narrative angles and objection themes to the invented product (recommended).

**Step 2 · Write the config.** Copy each file from `config/templates/` to
`config/` and fill it from the interview. Keep every schema key; replace
placeholders. Then show the user a one-screen summary (company, modules,
competitors, segments, team, pricing) and get an explicit confirm before
proceeding.

**Step 3 · Validate.** Run `npm run init`. Zod validation errors name the file
and key — fix the config (or re-ask the user) and re-run until clean.

**Step 4 · First light.** Run `npm run apply -- --weeks=1 --dry-run` and show
the user the plan ("would create N opps, plan K artifacts"). Then run
`npm run pipeline` for real, open one generated
`state/requests/<n>/<artifactId>.prompt.md`, and fill it as the hello-world.
Ingest with `npm run apply -- --ingest`, run `npm run lint`, and show the
result. The world now exists — entirely locally, zero credentials.

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

## Part 3 — Per-tool notes

**Claude Code** — richest integration: `/setup` (this playbook),
`/pipeline-update` (the weekly increment end to end), `/backfill-opps N` (the
detail-layer loop) live in `.claude/skills/`; the `opp-filler` subagent
(`.claude/agents/opp-filler.md`) fills one opportunity per subagent so the main
context stays lean. `CLAUDE.md` imports this file. For a long backfill, run
`/backfill-opps` iteratively and commit per opportunity.

**Codex / Cursor / other AGENTS.md-aware tools** — this file is the whole
contract; no extra setup. Follow Part 2 for onboarding and Part 1 for the
weekly loop. Mirror the context-hygiene rule by hand: fill **one opportunity
per session/task**, keep `apply`/`lint` serial, and commit per opportunity
during backfills.

**No agent at all** — everything works manually: the prompts in
`state/requests/` are self-contained briefs a human can write from, and
`docs/request-protocol.md` specifies the result formats for any external
generator you script yourself.
