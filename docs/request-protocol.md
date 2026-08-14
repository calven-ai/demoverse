# The request protocol

Demoverse never calls an LLM. Every `apply` run emits **generation requests** instead, one per prose artifact. Each one is a self-contained prompt file grounded in the exact ledger facts, and *anything* that can read and write files can fill it: Claude Code, Codex, Cursor, a different agent, or a human with an editor. This document is the precise spec of that handoff: the manifest, the prompt anatomy, the three result formats, validation, statuses, and refills.

## Layout

```
state/requests/<periodIndex>/
  manifest.json               # index of all requests this period
  <artifactId>.prompt.md      # one grounded prompt per artifact
  results/                    # ← the filler writes here
    <artifactId>.md           # markdown artifacts
    <artifactId>.json         # slack + email artifacts
```

`state/requests/` is gitignored scratch. The durable record is the ledger and `state/content/`, written at ingest.

## The manifest

```json
{
  "periodIndex": 12,
  "count": 3,
  "requests": [
    {
      "artifactId": "art-0412",
      "kind": "call_transcript",
      "output": "markdown",
      "title": "Discovery call — Northwind Robotics",
      "promptFile": "art-0412.prompt.md",
      "resultFile": "results/art-0412.md"
    },
    {
      "artifactId": "art-0413",
      "kind": "slack_deal_thread",
      "output": "slack_messages",
      "title": "#deals thread — Northwind Robotics",
      "promptFile": "art-0413.prompt.md",
      "resultFile": "results/art-0413.json"
    },
    {
      "artifactId": "art-0414",
      "kind": "email_exchange",
      "output": "email_thread",
      "title": "Intro thread — Northwind Robotics",
      "promptFile": "art-0414.prompt.md",
      "resultFile": "results/art-0414.json"
    }
  ]
}
```

`output` is one of `markdown`, `slack_messages`, `email_thread`, and it determines the result format exactly: `markdown` → `.md`, the other two → `.json`. The nine artifact kinds map as: `call_transcript`, `survey`, `interview`, `ae_note`, `internal_collateral` → markdown; `slack_deal_thread`, `winloss_post`, `competitive_q` → slack_messages; `email_exchange` → email_thread.

## Anatomy of a prompt

Every `.prompt.md` is fully self-contained. The filler needs no other context and must consult none. The blocks, in rough order:

**Task line + detail level.** What to write, dated when, and how long: `low` (terse, no filler), `medium` (a few focused paragraphs), `high` (long-form, conversational, with tangents).

**The fact block.** The deal in full: name, stage, status, amount; the account with firmographics; the owning rep; the buying group with titles and roles; the competitors on the deal with their positioning; and the primary use case. Close artifacts carry one more field, the recorded win/loss reason. Volatile fields (stage, outcome, reason) come from a snapshot taken at planning time, so an early-stage artifact reflects the world as of its date and cannot leak the eventual outcome. Call prompts additionally carry the **attendee subset** for that stage (a first discovery call is one or two people, never the whole buying group) and a product block for the rep to position from.

**The VARIETY block.** This deal's seeded texture: narrative angle (why this buyer is looking), buyer tone, objection themes, timeline pressure. Then this artifact's structural shape. It is part of the grounding contract, not a suggestion. It's what keeps hundreds of deals from telling one story.

**GROUNDING RULES.** The strict contract, verbatim in every prompt:

- Use **only** the given names, companies, competitors, and win/loss reason. Never invent a fact.
- Stay consistent across the deal: the same competitors and the same reason must appear in this deal's transcript, win-loss artifact, and Slack thread.
- The deal's **primary use case is the dominant theme**. It's what the buyer came for, what discovery digs into, what gets demoed, what the objections are about. Other capabilities stay secondary. Never open on one the buyer didn't ask about.
- The banned-phrase list (from `config/prose.yaml`), covering phrases that have worn out across the corpus.
- All output is clearly-fabricated demo data; never reference real people.

Kind-specific rules ride along where they matter. A `winloss_post` for a "none"-mode deal is told it is the *sole* win-loss signal and must carry the whole story. A `competitive_q` is told to write the question only, never an answer.

## The three result formats

**Markdown** goes to `results/<artifactId>.md`. The artifact body, as the prompt's format instructions specify (e.g. speaker-labeled transcript with a header; survey groups with answers; a rep's first-person one-liner).

**Slack messages** go to `results/<artifactId>.json`:

```json
{
  "messages": [
    { "personaHandle": "jordan.reyes", "text": "Closed-lost Northwind Robotics. Came down to procurement timing, and Vantage IQ was already on their vendor list." },
    { "personaHandle": "sam.okafor", "text": "Rough one. Did pricing come up at all or was it purely timing?" }
  ]
}
```

`personaHandle` must be one of the handles offered in the prompt's persona roster. At ingest, each handle resolves to its display name and avatar from config. The filler never supplies those.

**Email thread** results also go to `results/<artifactId>.json`, one object per message in send order:

```json
{
  "emails": [
    {
      "from": "Jordan Reyes <jordan@aurora-analytics.example>",
      "to": ["mia.chen@northwind.example"],
      "subject": "Following up from today",
      "body": "Mia, great talking today. Attaching the summary we discussed...",
      "date": "2026-03-04",
      "contactRef": "mia.chen@northwind.example"
    }
  ]
}
```

`contactRef` names the buyer contact this message is with, and lets ingest link the email to the right CRM contact. The emitted prompts require it on every message, and it is always the **buyer's** address, even when the rep is the sender. It accepts `Name <email>`, a bare email, or a name. Unmatched refs are dropped: the message survives, but its CRM-contact link is lost.

## Ingest validation

`npm run apply -- --ingest` walks the manifest and, for each still-`planned` artifact with a result present:

- **markdown** results need a trimmed body of ≥ 20 characters. Anything shorter is invalid ("markdown result too short / empty"). Valid bodies are written to `state/content/<artifactId>.md` and hashed.
- **slack_messages** results are schema-validated (zod): at least one message, each with non-empty `personaHandle` and `text`. Messages are attached to the artifact in the ledger, so there is no separate content file.
- **email_thread** results are schema-validated too: at least one email, each with non-empty `from`, `subject`, `body`, `date`. `to` defaults to `[]`, and `contactRef` resolves to a contact id.

The report buckets every artifact as `filled`, `pending` (no result yet), or `invalid` (with a reason). **Invalid and pending artifacts stay `planned`** and their requests reappear. Fix the result file and re-ingest. The engine never files data that failed validation, and after every ingest the whole ledger is re-validated before being persisted. Ingest is idempotent: already-`generated` artifacts are skipped, so filling and ingesting in batches is fine.

## Statuses

```
planned  ──ingest (valid result)──►  generated  ──reconcile──►  reconciled
```

- `planned`: structure exists, prose doesn't. The artifact appears in request bundles.
- `generated`: prose validated and filed. Eligible for push.
- `reconciled`: pushed, with external ids recorded on the artifact.

## Refilling a bad result

`npm run apply -- --refill=<artifactId>` is the sanctioned do-over. It resets one `generated` artifact back to `planned` and re-emits its prompt. It **refuses once the artifact has external records**, because the file or message already exists in the outside world and regenerating would duplicate it. If you truly must, purge the external record first with the per-connector purge tooling. You never hand-edit the ledger to "fix" an artifact.

## Why the grounding rules matter

Cross-system coherence is the product. A demo reads as real because the deal's transcript, its win-loss interview, its Slack post-mortem, and its CRM record all agree: same competitors, same reason, same people. One invented competitor name in one transcript poisons whatever analytics are pointed at the corpus. So the rules are enforced twice. The prompts enforce them at generation time, and the [coherence linter](architecture.md#verification-the-coherence-linter) catches the rest afterward, cross-checking prose against the recorded facts and failing the build on finalized drift. Honor the prompt exactly and the linter stays quiet.

Next: [operations.md](operations.md) for the weekly loop this protocol lives inside · [getting-started.md](getting-started.md) to run it once by hand
