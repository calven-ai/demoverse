# Google Drive connector

Drive holds the world's documents: call transcripts, AE notes, win-loss surveys and interviews, and internal collateral, filed as markdown in a tidy per-account folder tree. This guide sets up a Google Cloud service account and shares a dedicated folder with it. It also covers the one hazard specific to Drive. Orphaned files after a world reset.

> **Dedicated folder only.** The engine writes into one shared folder you create for this purpose. Everything it manages lives under that root.

## 1. Create a service account

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or reuse a scratch one).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **IAM & Admin → Service Accounts** → **Create Service Account**. Name it something like `demoverse-drive`. No project roles are needed. Access comes from folder sharing, not IAM.
4. Open the new service account → **Keys** → **Add Key** → **Create new key** → **JSON**. A key file downloads.

Rename the download to `service-account.json` when placing it in the repo root. That exact name is what `.gitignore` covers; under the `<project-id>-<hex>.json` name GCP gives the download, the file is one `git add .` away from your remote, with only the secrets check's key-material scan left to catch it. Point `GOOGLE_APPLICATION_CREDENTIALS` in `.env` at it:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
```

## 2. Share a folder with the service account

1. In Google Drive, create a dedicated folder. Name it something like `Aurora Demo World`. A folder on a Shared Drive works too.
2. **Share** it with the service account's email (the `…@….iam.gserviceaccount.com` address from the key file), as **Editor**.
3. Open the folder in the browser and copy the id from the URL. It's the long string after `/folders/`:

```bash
DRIVE_ROOT_FOLDER_ID=1AbCdEfGh...
```

That's the entire credential story: a JSON key plus a shared folder id.

## 3. Enable the connector

In `config/connectors.yaml` (ships disabled):

```yaml
drive:
  enabled: true
  folders:                       # artifact kind → top-level folder under the root
    call_transcript: Call Transcripts
    survey: Win-Loss
    interview: Win-Loss
    internal_collateral: Internal Collateral
    ae_note: AE Notes
```

## The folder tree

Inside the shared root, the reconciler builds one top-level folder per artifact kind (from the map above), then one subfolder per account, and files each document as `<date> — <title>.md`:

```
Aurora Demo World/
  Call Transcripts/
    Northwind Robotics/
      2026-03-04 — Discovery call.md
  Win-Loss/
    Northwind Robotics/
      2026-04-22 — Loss interview.md
  AE Notes/
  Internal Collateral/
```

Every uploaded file's Drive id is recorded on its artifact in the ledger, so re-runs update the same file instead of uploading a duplicate. Reconcile as usual:

```bash
npm run apply -- --reconcile --dry-run
npm run apply -- --reconcile
```

As everywhere, only [cohort](../operations.md#the-cohort) deals reach Drive.

## `drive:audit` and the orphan hazard

Drive is the one destination a downstream tool typically ingests *blind*: a watched-folder connector reads whatever is in the folder, with no CRM join to cross-check against. So a stale file doesn't sit there harmlessly. It gets ingested, and the tool derives accounts and deals for a company that exists nowhere else.

That's exactly what a world reset produces. After `npm run init -- --force`, the new ledger carries no Drive file ids, so the next reconcile re-uploads everything and the *old* generation's files stay behind as orphans. The audit finds them by walking the tree and matching every file id against the ledger:

```bash
npm run drive:audit                              # report orphans
npm run drive:audit -- --purge --confirm         # trash them
npm run drive:audit -- --prune-empty --confirm   # trash empty account folders (cosmetic)
```

Purge moves files to the Drive trash (recoverable for 30 days), never a permanent delete, and only ever touches files the ledger does not claim. Run the audit after any `init --force`, and occasionally as hygiene.

Back to [getting started](../getting-started.md) · other connectors: [Salesforce](salesforce.md) · [Slack](slack.md) · [HubSpot](hubspot.md)
