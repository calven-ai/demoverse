# Salesforce connector

Salesforce receives the CRM half of the world: Accounts, Contacts, Opportunities, contact roles, and an activity timeline (emails and notes as Tasks). This guide takes you from nothing to a provisioned free Developer Edition org, then covers verifying the push and purging records.

> **Dedicated orgs only.** The engine writes to whatever org the credentials point at. Use a fresh Developer Edition org that exists solely for this. Never a sandbox of a real org, and never production.

## 1. Get a free Developer Edition org

1. Go to [developer.salesforce.com/signup](https://developer.salesforce.com/signup) and sign up. It's free, permanent, and needs no credit card. Use an email you control; the username must be globally unique and email-shaped but doesn't need to be a real address (e.g. `demo@aurora-analytics.demo-world`).
2. Verify via the email link and set a password. Note the username. You'll need it exactly.
3. Mind the **~5 MB data cap** on Developer Edition. A few hundred deals fit comfortably. It's one reason transcripts live in [Google Drive](google-drive.md) rather than Salesforce Files.

## 2. Get your security token

The engine authenticates with the SOAP username + password + security-token flow. No Connected App, no OAuth setup.

1. In the org: click your avatar → **Settings** → **Reset My Security Token** (search "Reset" in Quick Find if hidden).
2. Click **Reset Security Token**. It arrives by email within a minute.

> Resetting the token invalidates the old one. If you later change your password, Salesforce resets the token again. Update `.env` when that happens.

## 3. Fill in `.env`

```bash
cp .env.example .env    # if you haven't already
```

```bash
SF_LOGIN_URL=https://login.salesforce.com
SF_USERNAME=demo@aurora-analytics.demo-world
SF_PASSWORD=your-password
SF_SECURITY_TOKEN=the-token-from-the-email
```

`.env` is gitignored. With these four values absent, the connector no-ops and prints a "credentials absent (.env)" note. That's the mechanism that lets the rest of the engine run credential-free.

## 4. Provision the schema

The reconciler writes custom fields a stock org doesn't have. Two idempotent scripts create them. Both are safe to re-run (existing fields are skipped).

```bash
npm run sf:setup -- --dry-run    # report what's missing, create nothing
npm run sf:setup                 # create the fields + extend picklists
npm run sf:stage-fields          # the per-stage date fields + field-level security
```

**What `sf:setup` creates and why.** Roughly 25 custom fields across the three objects, as proper picklists where the data is categorical:

- `Demo_World_Id__c` on Account, Contact, and Opportunity carries the ledger id, verbatim. This is the upsert key (re-runs update instead of duplicate) *and* the safety rail (purge tooling only ever matches on it, never on names).
- Account firmographics: `Company_Size__c`, `Employee_Band__c`, `Revenue_Band__c`, `Funding_Stage__c`, `Region__c`, and related fields. The CRM then carries the same segmentation the ledger samples from.
- Contact `Buying_Role__c` / `Seniority__c` record the buying-group role each contact plays.
- Opportunity deal fields: owner rep, tier, billing term, competitors-on-deal, win/loss reason and mode, the original (simulated) created date, and friends.

It also extends the standard `Account.Industry` picklist with your configured ICP verticals. Without this, the reconciler's `Industry` writes are rejected.

**What `sf:stage-fields` creates and why.** One Date field per pipeline stage, named `Stage_<Stage>_At__c` and **derived directly from `config/world.yaml` `pipeline.stages`**, so the script and the reconciler can never disagree about a field's name. With the default five stages that's `Stage_Discovery_At__c` through `Stage_Closed_At__c`. They record when each deal *entered* each stage on the simulated calendar, which Salesforce's own `OpportunityHistory` cannot carry (it stamps real push time, not simulated time). The script also grants field-level security and verifies each field is writable, because a freshly created custom field is invisible even to admins until FLS is set.

The reconciler describes the Opportunity object before writing and silently omits any stage field the org doesn't define, so running reconcile before this step is safe. It starts populating the fields the moment they exist.

## 5. Enable the connector

In `config/connectors.yaml` (ships disabled):

```yaml
salesforce:
  enabled: true
  stage_map:                # engine stage → Opportunity StageName picklist value
    Discovery: Qualification
    Evaluation: Needs Analysis
    Proposal: Proposal/Price Quote
    Negotiation: Negotiation/Review
```

The `stage_map` translates your world's stage names onto whatever `StageName` picklist your org uses. Closed deals map to `Closed Won` / `Closed Lost` from the deal status automatically.

## 6. Verify with a scoped reconcile

Push one deal, look at it, then open the tap:

```bash
npm run apply -- --reconcile --opp=<oppId> --dry-run   # what WOULD be written
npm run apply -- --reconcile --opp=<oppId>             # push one deal + its account/contacts
```

Open the org and check the opportunity: the account with firmographics filled, contacts with buying roles, contact roles on the deal, stage dates, and the timeline. When it looks right:

```bash
npm run apply -- --reconcile --dry-run
npm run apply -- --reconcile
```

Reconcile records every Salesforce Id back into the ledger, so re-runs update in place. If the org is ever wiped, the world replays from the ledger.

## The cohort gate

Only deals listed in `state/cohort.json` are ever pushed: the curated ~50-deal window a visitor browses. The full ledger (typically hundreds of deals) stays local, grounding the win rates and statistics without bloating the org. This gate applies to every connector, not just Salesforce. See [operations.md](../operations.md#the-cohort) for managing membership.

## Purging: `sf:purge`

Every deletion path lives in one command, and **every mode is dry-run by default**. It prints exactly what it would delete and exits. Add `--confirm` to execute. Deleted rows land in the org's Recycle Bin (recoverable for 15 days).

```bash
npm run sf:purge -- --noncohort [--confirm]     # shrink the org to the cohort
npm run sf:purge -- --sample [--confirm]        # remove Salesforce's own seeded sample data
npm run sf:purge -- --activities [--opp=<id>] [--confirm]   # delete Tasks/Files for demo deals
npm run sf:purge -- --all [--confirm]           # delete every demo-world record
```

The safety model: `--noncohort`, `--activities`, and `--all` only touch rows where `Demo_World_Id__c` is set. `--sample` touches only the rows where it is NULL (the "Edge Communications"-style records a fresh org ships with). Nothing is ever matched by name, so hand-created records are never at risk. After `--noncohort` and `--all`, the purged records' stored Salesforce ids are cleared from the ledger so the next reconcile treats them as never-pushed.

Make dry-running a habit generally: everything that touches this org supports `--dry-run`. Reading a plan takes ten seconds. Reversing a push does not.

Back to [getting started](../getting-started.md) · other connectors: [Drive](google-drive.md) · [Slack](slack.md) · [HubSpot](hubspot.md)
