---
name: import-hubspot
description: Deterministically import the demo-world CRM structure (companies, contacts, deals, associations) into a dedicated HubSpot test account, then verify it. No prose generation, no judgment calls. Every step is a single command with a machine-checkable exit code. Use when asked to seed, refresh, or verify the HubSpot connector-test account.
---

# /import-hubspot

Everything here is deterministic. **Never** hand-edit `state/world.json`,
HubSpot records, or the mapping code to "fix" a result. If a step fails, stop
and report it. This skill is designed to be run by a lightweight model: read
each command's output, act on it exactly as instructed, and don't improvise.

## Preconditions

- `HUBSPOT_ACCESS_TOKEN` must be set in `.env`. That is a HubSpot private-app
  access token. See `docs/connectors/hubspot.md` for the required scopes. If
  it's missing, every command below fails fast with a clear message. Report
  that and stop. Do not invent a token or guess scopes.
- `state/world.json` must exist (`npm run init` was already run). If not,
  stop and report. Do not create or edit the ledger yourself.

## Steps

1. **Provision the schema** (idempotent, so it is safe to always run first):

   ```bash
   npm run hubspot:setup
   ```
   Confirm it prints `Done. created=… existing=…` with no error. Any thrown
   error (e.g. "exists but is not unique") means a property was hand-created
   in HubSpot incorrectly. Report the exact message and stop.

2. **Preflight the import with `--dry-run`** for the scope you were asked to
   run (pick exactly one; never mix flags across scopes):

   | If asked to… | Scope flags |
   | --- | --- |
   | smoke-test the connector | *(no flags)*. Bounded pilot, 3 accounts × 3 deals |
   | debug one deal | `--opp=<id>` |
   | import everything | `--all` |

   ```bash
   npm run hubspot:import -- --all --dry-run
   ```

   Read the printed company/contact/deal counts. If they look wildly wrong
   (e.g. 0 accounts for `--all`), stop and report. Do not proceed to a write.

3. **Run the real import** (same scope flags, no `--dry-run`):

   ```bash
   npm run hubspot:import -- --all
   ```

   This is idempotent. Rerunning it, even after a partial failure, updates
   existing records by `demo_world_id` rather than duplicating them. Rerunning
   the same command is always safe. Read the summary block:
   - `errors=0` → proceed to step 4.
   - `errors>0` → the per-error lines below the summary are the message to
     report verbatim. Do not attempt to reinterpret or silently retry more
     than once. If a rerun doesn't reduce the error count, stop and report.
   - Note the printed run-report path (`runs/hubspot-import-*.json`) in your
     final report to the operator.

4. **Verify** the same scope:

   ```bash
   npm run hubspot:verify -- --all
   ```

   `issues=0` and the closing `All checked records and associations match the
   ledger. ✓` line mean success. Report the final counts to the operator.
   Any printed `✗ [missing|mismatch|missing-association]` line is a concrete,
   actionable failure. Report them verbatim. A `missing` company/contact/deal
   almost always means step 3's import silently dropped that record. Rerun
   step 3 once, then re-verify. Persistent `mismatch` issues mean the mapping
   code and the verifier have drifted. That is a bug to report, not to patch.

5. **Report.** Summarize for the operator: scope run, final
   created/updated/error counts (companies/contacts/deals/associations), the
   run-report path, and verification's `issues` count. Stop here. Do not run
   `hubspot:purge` unless the operator explicitly asks for it. It is
   destructive, though reversible for 90 days.

## If something looks wrong

- **Never** edit `state/world.json`, `src/connectors/hubspot/`, or `scripts/hubspot-*.ts`
  to work around a failure. Those are the deterministic package's job.
- **Never** guess at a missing credential or scope; quote the exact error and
  stop.
- **Never** run `--confirm` on `hubspot:purge` without an explicit operator
  instruction to do so, and never on anything but the dedicated test portal.
