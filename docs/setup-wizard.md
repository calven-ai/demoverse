# The setup wizard

`/setup` is a slash command for your coding agent that turns a conversation into a complete, coherent world configuration. It interviews you about the fictional company you want to demo, drafts every `config/*.yaml` file, and shows you a summary to confirm before writing anything. It exists because a good world needs a dozen config files that all agree with each other — and an agent is much better at keeping them consistent than a human filling in templates one by one.

## Running it

Open your clone in your coding agent and type:

```
/setup
```

The wizard works in phases. You can answer in as much or as little detail as you like — anything you leave open, it proposes a sensible invented default and tells you it did.

## What it asks

**1. Company.** The fictional vendor's name, domain, one-line pitch, and rough size. Say as much or as little as you want — "a mid-market data-quality platform called Aurora Analytics" is enough to seed everything else. This becomes `world.yaml`'s `company` block and the identity every artifact writes under.

**2. Product surface.** What the product actually does, broken into domains and capabilities the reps can position and demo. This becomes `product.yaml` — and it matters more than it looks: call transcripts quote reps demoing *specific* capabilities against *specific* pains, so a thin product surface produces thin calls.

**3. Market and competitors.** Who the fictional company loses to, each competitor's category, positioning, and relative strength. Also the buyer-facing **use cases** — what a buyer walks in asking for — since every deal is named for and themed around one. Writes `competitors.yaml` and `use-cases.yaml`.

**4. Sales motion, pricing, and team.** Pipeline stages, average sales-cycle length, deal-size range, pricing tiers, win-rate baseline and trend, segment mix (industries, sizes, regions, ICP-fit tiers), and the fake rep roster with regions and quirks. Writes the pipeline/volume/winloss/segments sections of `world.yaml`, plus `sales-team.yaml` and `icp.yaml`.

**5. Buying group.** The personas on the other side of the table — economic buyer, champion, users, technical evaluators, blockers — their typical titles, and who's in the room at each stage. Writes `personas.yaml`.

**6. Prose texture.** Narrative angles (why this buyer is looking), buyer tones, objection themes, timeline pressures, Slack persona voices, win/loss questionnaires. Writes `prose.yaml`, `slack-personas.yaml`, and `surveys.yaml`. The shipped `prose.yaml` defaults are deliberately generic enough to work as-is, so this phase is quick unless you want a distinctive flavor.

`connectors.yaml` is copied through with **every destination disabled** — connecting external systems is a separate, later step ([Salesforce](connectors/salesforce.md), [Slack](connectors/slack.md), [Drive](connectors/google-drive.md), [HubSpot](connectors/hubspot.md)).

## The confirm step

Before writing a single file, the wizard echoes back a resolved summary: the company, the competitor roster, the use-case shares, the win-rate trajectory, the segment mix, the rep roster. Read it. This is the moment to catch "wait, I wanted a six-stage pipeline" — after you confirm, it writes all of `config/`, runs `npm run init` to scaffold `state/`, and tells you to commit.

## Re-running and amending

The wizard is safe to re-run, with one big caveat: config is **load-bearing history** once the world has data. Changing distributions mid-world (win rate, segment mix, volume) only affects *future* periods — that's fine and normal, and the better tool for it is a Tier-2 directive (see [operations.md](operations.md#changing-the-story)). Changing *identity* (company name, pipeline stages, competitor roster) after deals exist makes existing prose incoherent, so the wizard will warn you and suggest a fresh start (`npm run init -- --force`, which regenerates the world from scratch — see the [reset notes](operations.md#purge-and-reset) first if you've already pushed to external systems).

For small amendments you don't need the wizard at all: every config file is commented YAML, and your agent can edit any knob if you just describe the change.

## The fully-manual fallback

No agent, no problem. The wizard is convenience, not machinery — everything it does reduces to:

```bash
cp config/templates/*.yaml config/
# edit each file; the comments explain every knob
npm run init
git add -A && git commit -m "world zero"
```

The table in [getting-started.md](getting-started.md#route-b-manual) lists what each file defines. Start minimal: a real `world.yaml`, three or four competitors, one or two use cases, and the default `prose.yaml` already make a believable world; deepen the rest as the world grows.
