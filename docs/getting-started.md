# Getting started

This guide takes you from a fresh clone to a living synthetic sales world — deals opening, progressing, and closing, with grounded prompts ready for prose — **without a single credential**. Connecting real systems (Salesforce, Google Drive, Slack, HubSpot) comes later, one at a time, whenever you're ready.

## Prerequisites

- **Node.js ≥ 20** (`node --version`)
- **A coding agent** — Claude Code, Codex, Cursor, or any agent that can read and write files. The engine emits fully-grounded prompt files; your agent (or you, by hand) writes the prose. Demoverse never calls an LLM API itself.
- **Git.** Your clone *is* your world: the ledger, config, and generated prose are all committed to it.

If your npm setup blocks lifecycle scripts ("allow-scripts" warnings at install time), that's fine — the engine runs via `tsx` and needs no postinstall scripts.

## Clone and install

Demoverse is a GitHub template repository — you clone it and own the copy. Your company's config and your world's state get committed to *your* clone; there is nothing to sync back.

```bash
git clone <your-copy-of-the-template> my-demo-world
cd my-demo-world
npm ci
```

At this point `state/` contains only a README and `config/` contains only the `templates/` folder — there is no active YAML until you copy or generate it. The engine won't run until the config exists — that's next.

## Configure your fictional company

Every world is built around a fictional vendor — *your* fictional company, selling *your* kind of product. Two routes:

### Route A: the setup wizard (recommended)

Open the repo in your coding agent and run:

```
/setup
```

The wizard interviews you — company, product surface, market and competitors, sales motion, buying group, prose texture — then writes every `config/*.yaml` file and echoes a summary for you to confirm before anything is saved. Full walkthrough: [setup-wizard.md](setup-wizard.md).

### Route B: manual

Copy the templates and edit them yourself:

```bash
cp config/templates/*.yaml config/
```

Then work through each file — they're heavily commented. The ones that need real thought:

| File | What you define |
| --- | --- |
| `world.yaml` | Company name/domain, pipeline stages, deal volume, win rate, segments |
| `competitors.yaml` | Your fictional competitor roster + relative strength |
| `use-cases.yaml` | What buyers come asking for (each deal gets one primary use case) |
| `product.yaml` | Product surface the reps position and demo |
| `sales-team.yaml` | Your fake rep roster |
| `personas.yaml` | Buying-group roles and who attends calls at each stage |
| `icp.yaml` | The ICP-fit scorecard |
| `surveys.yaml` | Win/loss questionnaires |
| `slack-personas.yaml` | Internal Slack voices |
| `prose.yaml` | Variety axes, artifact shapes, banned phrases — **works as-is**, tune later |
| `connectors.yaml` | External destinations — **ships with everything disabled**, leave it for now |

Either route ends the same way — initialize the world:

```bash
npm run init
```

This scaffolds `state/`: the rep roster, the simulation clock, and the trend trajectories, all derived from your config. Commit it — `state/` is meant to be versioned:

```bash
git add -A && git commit -m "world zero"
```

## Your first increment

### The clock starts in the past — pick your first-run path

`npm run init` set the simulation clock back by `window.history_quarters` quarters (default 4, in `world.yaml`). That's deliberate: a fresh world's first increments carry **historical dates**, and that history is what makes the demo believable — a CRM born last Tuesday convinces no one. From here there are three ways to run, and `init`'s own closing output prints the same fork:

- **`npm run pipeline`** — one week per run. The recommended first step, and the routine motion forever after: the clock catches up toward today as you run more weeks.
- **`npm run apply -- --backfill`** — plan the entire historical back-catalog in one shot. A large one-time fill job — hundreds of prompts, typically driven by an agent loop rather than filled by hand. Read [operations.md](operations.md) before reaching for it.
- **Plain `npm run apply`** — generate *every* pending period up to today at once. On a fresh four-quarter world that's dozens of periods and hundreds of artifacts; don't run it casually.

Tip: if you want less history, lower `window.history_quarters` in `world.yaml` *before* running `npm run init`.

Advance the world one week:

```bash
npm run pipeline
```

This is shorthand for `npm run apply -- --weeks=1`. The engine opens a couple of new deals, advances open ones, closes any whose sales cycle is up — and emits **generation requests** for the touch points those events earned. Nothing external is contacted.

Look at what it produced:

```
state/requests/<periodIndex>/
  manifest.json              # index of every request this period
  <artifactId>.prompt.md     # one fully-grounded prompt per artifact
  results/                   # ← results go here
```

Open one of the `.prompt.md` files. It contains everything the prose needs: the exact account, buying group, rep, competitors, deal stage, use case, a per-deal variety block, and strict grounding rules. No fact is left for the writer to invent.

## Fill two or three requests

You can do this by hand first, to feel the protocol — or hand the whole batch to your agent.

**By hand.** Pick a request from `manifest.json`, read its prompt, and write the result:

- `output: markdown` (transcripts, AE notes, surveys, interviews) → write `results/<artifactId>.md`
- `output: slack_messages` → write `results/<artifactId>.json`:

  ```json
  { "messages": [{ "personaHandle": "jordan.reyes", "text": "Heads up — Northwind Robotics demo went long, they kept digging into reporting." }] }
  ```

- `output: email_thread` → write `results/<artifactId>.json`:

  ```json
  { "emails": [{ "from": "Jordan Reyes <jordan@aurora-analytics.example>", "to": ["mia.chen@northwind.example"], "subject": "Following up from today", "body": "Mia — great talking today. ...", "date": "2026-03-04", "contactRef": "mia.chen@northwind.example" }] }
  ```

  The emitted prompts require `contactRef` on every message: it's the **buyer's** email — even when the rep is the sender — and it's what links the thread to the right CRM contact.

**Via your agent.** Point it at the manifest and let it fill everything; the repo ships agent guidance (`AGENTS.md`, `CLAUDE.md`) and a `/pipeline-update` command that runs the entire weekly loop end to end. The full spec of prompts, result formats, and validation lives in [request-protocol.md](request-protocol.md).

## Ingest and lint

```bash
npm run apply -- --ingest --reconcile
npm run lint
```

`--ingest` validates every result (schema-checked; markdown must be a real body, not a stub), files prose into `state/content/`, and marks each artifact `generated`. Anything invalid or missing simply stays `planned` and reappears next time — the engine never files bad data.

`--reconcile` pushes eligible records to external systems. Right now that's a no-op — every connector ships disabled, so each destination reports a clean `[skipped]` note — but it's the same command you'll run once systems are connected, so make it the habit.

The run also writes a report to `runs/<date>-report.md` — gitignored, named by the real date, overwritten if you run again the same day. Note the report's **Simulation now** date is the sim clock, not the file's real date, so on a fresh world the two will disagree — by design.

`lint` runs structural and cross-system coherence checks: does the transcript name the deal's actual competitors? Does the win-loss artifact cite the recorded loss reason? Errors exit non-zero; fix the offending result and re-ingest. The cross-system prose checks run over **closed** deals, so on a brand-new world `lint` reports "0 closed deals checked" — that's expected; the checks get teeth as deals start to close.

Commit the increment:

```bash
git add -A && git commit -m "first increment"
```

That's the whole loop. Run `npm run pipeline` again next week and the world keeps living — deals accumulate their history across runs, exactly as real ones do. The weekly routine, steering knobs, and maintenance commands are in [operations.md](operations.md).

## Connect systems later

Everything above ran credential-free, and it stays fully useful that way — the ledger, prose, and lint are the product; external systems are projections of it. When you want the world to exist somewhere people can click around:

- [Salesforce](connectors/salesforce.md) — free Developer Edition org, CRM structure + activity timeline
- [Google Drive](connectors/google-drive.md) — transcripts, notes, win-loss documents
- [Slack](connectors/slack.md) — internal chatter from a persona roster
- [HubSpot](connectors/hubspot.md) — structure-only CRM alternative
- [Build your own](connectors/build-your-own.md) — the connector contract

Connect them one at a time. Each connector runs only when it's enabled in `config/connectors.yaml` **and** its credentials are present in `.env`; reconcile is idempotent, so re-running simply picks up whatever became reachable. Note that only deals in the curated cohort (`state/cohort.json`) ever leave the repo — see [operations.md](operations.md#the-cohort) for why.

For the bigger picture — the ledger model, determinism, and the two-phase generation loop — read [architecture.md](architecture.md). Questions and troubleshooting: [faq.md](faq.md).
