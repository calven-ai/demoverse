# HubSpot connector

HubSpot is the structure-only CRM destination: companies, contacts, deals, and their associations — no activity timeline, no files. It exists for teams whose demo target is HubSpot rather than Salesforce, and as a worked, deterministic importer you can verify record-by-record. This guide sets up a dedicated test portal, a private-app token, and walks the import/verify/purge cycle.

> **Dedicated test portal only.** Create a HubSpot account that exists solely for this. Never point the token at a production portal.

## 1. Create the portal and private app

1. Create a dedicated HubSpot account (a free CRM account works).
2. **Settings → Integrations → Private Apps** → create a private app.
3. Grant exactly these scopes:
   - `crm.objects.companies.read` / `crm.objects.companies.write`
   - `crm.objects.contacts.read` / `crm.objects.contacts.write`
   - `crm.objects.deals.read` / `crm.objects.deals.write`
   - `crm.schemas.companies.read` / `crm.schemas.companies.write`
   - `crm.schemas.contacts.read` / `crm.schemas.contacts.write`
   - `crm.schemas.deals.read` / `crm.schemas.deals.write`

   The `schemas` scopes exist so `hubspot:setup` can create custom properties; the `objects` scopes cover the records themselves.
4. Copy the access token into `.env`:

```bash
HUBSPOT_ACCESS_TOKEN=pat-...
```

## 2. Provision the custom properties

```bash
npm run hubspot:setup -- --dry-run
npm run hubspot:setup
```

Idempotent; safe to re-run. The key property is `demo_world_id` — the ledger id, verbatim, on every record. It's the upsert key (re-runs update, never duplicate) and the purge safety rail. Records also carry a provenance property marking them as fabricated demo data; contact emails are rewritten to non-deliverable addresses. Names — company, contact, deal — mirror the ledger exactly, so a CRM integration reads the same deal identity from HubSpot as it would from Salesforce.

## 3. Import, scoped and dry-run first

Three scopes; never mix flags across them:

| Scope | Command | Use for |
| --- | --- | --- |
| Bounded pilot (default) | `npm run hubspot:import` (optionally `-- --accounts=N --deals-per-account=N`, capped at 10×10) | First smoke test |
| One opportunity | `npm run hubspot:import -- --opp=<id>` | Debugging one deal end-to-end |
| Full ledger | `npm run hubspot:import -- --all` | The real import |

Always preflight:

```bash
npm run hubspot:import -- --all --dry-run   # counts + destination, no API calls
npm run hubspot:import -- --all
npm run hubspot:verify -- --all
```

The importer streams per-phase progress (companies → contacts → deals → associations, batched to HubSpot's 100-records-per-call limit with automatic retry on rate limits), prints the destination portal link, writes a machine-readable run report under `runs/`, and exits non-zero if any record failed.

`hubspot:verify` re-derives the same mapping, batch-reads every `demo_world_id` in scope, diffs the properties, and confirms the contact→company / deal→company / deal→contact associations exist (skip association checks with `--no-associations`). Non-zero exit on any mismatch — safe to script.

## 4. Undo: `hubspot:purge`

```bash
npm run hubspot:purge               # dry-run: list + count what would go
npm run hubspot:purge -- --confirm  # archive to HubSpot's recycling bin (restorable 90 days)
```

Only records carrying `demo_world_id` are ever touched.

## Registered connector vs standalone scripts

HubSpot is wired two ways, and the difference matters:

- **Standalone scripts** (`hubspot:setup` / `import` / `verify` / `purge`) — the primary path. They run on demand, regardless of `config/connectors.yaml`, against whatever scope you pass. Routine weekly runs never touch HubSpot this way, so nothing lands there by accident.
- **Registered connector** — set `hubspot: { enabled: true }` in `config/connectors.yaml` and HubSpot joins the normal `apply -- --reconcile` chain alongside the other destinations, with the same [cohort gate](../operations.md#the-cohort), `--dry-run`, and `--opp=` scoping. Use this when HubSpot *is* your demo CRM and you want the weekly loop to keep it current.

It ships disabled because most operators run one CRM. Either way it remains structure-only: transcripts and documents belong to [Drive](google-drive.md), chatter to [Slack](slack.md).

The connector is also the reference implementation for writing your own destination — see [build-your-own.md](build-your-own.md).

Back to [getting started](../getting-started.md) · other connectors: [Salesforce](salesforce.md) · [Drive](google-drive.md) · [Slack](slack.md)
