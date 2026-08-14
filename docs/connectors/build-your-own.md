# Build your own connector

A connector pushes the desired ledger state into one external system. The contract is small: one interface, one registration, one config block. The *requirements* are the strict part. Every guarantee the engine makes (idempotent re-runs, cohort gating, credential-free operation, dry-run everywhere) is only as good as its weakest connector. What follows is the contract verbatim, the rules, and the shipped HubSpot connector as a worked example.

## The contract

From `src/connectors/types.ts`:

```ts
/**
 * The connector contract. A connector pushes the desired ledger state into one
 * external system via idempotent upserts and must:
 *
 *  - no-op with `disabled: true` when it is switched off in
 *    `config/connectors.yaml` or its credentials are absent from the env;
 *  - honor `opts.dryRun` (compute + report, write nothing);
 *  - honor the cohort gate (`opts.cohort`), so only member deals reach the world;
 *  - record external ids on the ledger so re-runs update instead of duplicate.
 *
 * Registration lives in `./registry.ts`; the orchestrator (`src/reconcile.ts`)
 * runs connectors in registry order.
 */

export interface ReconcileOptions {
  /** When true, compute and log intended actions but make no external writes. */
  dryRun: boolean;
  /**
   * CRM smoke-batch cap: push only the first N accounts (and only the
   * contacts/opportunities belonging to them). Undefined = push everything.
   */
  limit?: number;
  /**
   * Scope every system to a single opportunity (its account + contacts + the deal
   * itself + that deal's touch-point artifacts). Used for the one-opportunity
   * end-to-end test before a full backfill. Takes precedence over `limit`.
   */
  oppId?: string;
  /**
   * Cohort gate. The membership list every target filters through (see
   * src/cohort.ts). Loaded from state/cohort.json when omitted; pass it
   * explicitly to share one index across all connectors, or to override it in
   * tests. An unselected cohort passes everything.
   */
  cohort?: CohortIndex;
}

export interface ReconcileStats {
  system: string;
  created: number;
  updated: number;
  skipped: number;
  errors: { entity: string; message: string }[];
  /** True if the system was skipped entirely (disabled or credentials absent). */
  disabled?: boolean;
  note?: string;
}

export interface Connector {
  /** Stable identifier; matches the connector's key in `config/connectors.yaml`. */
  name: string;
  reconcile(world: World, cfg: Config, opts: ReconcileOptions): Promise<ReconcileStats>;
}
```

Two helpers ship alongside: `emptyStats(system)` for a zeroed stats object, and `disabledStats(system)` for the uniform "switched off in config" no-op.

## Registration

`src/connectors/registry.ts` is the single list the orchestrator runs, **in order**. The CRM goes first so accounts exist before file/chat systems group content under them:

```ts
export function allConnectors(): Connector[] {
  return [salesforceConnector, hubspotConnector, driveConnector, slackConnector];
}
```

Adding a destination is three edits:

1. Implement `Connector` under `src/connectors/<name>/`.
2. Add a block to `config/connectors.yaml`, keyed by your connector's `name`, with at least `enabled: false` as the shipped default plus whatever destination-side naming you need (channel maps, folder maps, stage maps):

   ```yaml
   pipedrive:
     enabled: false
     # …destination-side naming…
   ```

3. Append it to `allConnectors()` in the registry.

Credentials never go in YAML. They live in `.env`, and their *absence* must be a supported state (see rule 4).

## The rules

**1. Idempotent upserts, external ids recorded.** Every entity you create must get its external id written back onto the ledger (`account.external.<yourSystem>Id`, `artifact.external.…`, etc.), and every subsequent run must use that id to update-in-place. The test: re-running a reconcile immediately produces zero new external records. This is also what makes a wiped destination rebuildable by replay.

**2. Cohort gating.** Filter every deal through `opts.cohort` (defaulting to a loaded `CohortIndex` when absent), and derive your account/contact scope *from the surviving deals*. Only cohort members may reach the outside world. The curated window is the product. The full ledger is its statistical backing.

**3. Dry-run support.** When `opts.dryRun` is set, compute the full plan: counts, creates vs updates. Log it. Write nothing. Dry-run output is how operators learn to trust a new connector, so make it honest.

**4. Distinct no-ops for "disabled" vs "no credentials".** Switched off in `config/connectors.yaml` → return `disabledStats(name)` (note: "disabled in config…"). Enabled but credentials absent from the env → return stats with `disabled: true` and a note like `"credentials absent (.env), skipped"`, with `skipped` set to the record count that would have gone. The two notes are deliberately different. One says "you chose this". The other says "you forgot something". Never throw on missing credentials. The credential-free path is a core feature, not an error.

**5. Respect `oppId` and `limit`.** Single-opportunity scoping is how every connector gets smoke-tested before its first bulk push.

## Worked example: the HubSpot connector

`src/connectors/hubspot/connector.ts` is a compact, real implementation of all five rules. Read it top to bottom:

- **Disabled check first:** `if (!cfg.connectors.hubspot.enabled) return disabledStats("hubspot");`
- **Cohort gate:** builds a `CohortIndex` from `opts.cohort`, filters opportunities through `cohort.has(o.id)`, then narrows accounts and contacts to those the surviving deals reference. Copy that pattern for deriving scope from deals.
- **Credential no-op:** `if (!hasEnv("HUBSPOT_ACCESS_TOKEN"))` → `disabled: true`, note `"HubSpot credentials absent (.env), skipped"`, `skipped` = the would-have-been count.
- **Delegation to a deterministic core:** the actual work lives in `src/connectors/hubspot/import.ts` (`selectHubSpotDataset` / `importHubSpotDataset`), which batches to the API's per-call limits, retries rate limits, and upserts everything by a `demo_world_id` property. That core is *also* drivable standalone via `npm run hubspot:import`. A useful shape, because it makes the connector testable without the orchestrator.
- **Client:** `src/connectors/hubspot/client.ts` wraps auth + fetch; `schema.ts` owns property provisioning; `verify.ts` re-reads and diffs.

For a document-store destination, mirror `src/connectors/drive/reconcile.ts` instead: folder trees, per-artifact file ids. For a chat destination, read `src/connectors/slack/reconcile.ts` (channel routing, per-message ids, persona rendering).

One more rule of taste: keep judgment out. A connector translates ledger facts into API calls. It never decides *what* the world contains. If you find yourself sampling, randomizing, or writing prose in a connector, that logic belongs in the engine.

Back to [getting started](../getting-started.md) · [architecture](../architecture.md) · shipped connectors: [Salesforce](salesforce.md) · [Drive](google-drive.md) · [Slack](slack.md) · [HubSpot](hubspot.md)
