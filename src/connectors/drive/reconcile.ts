/**
 * Reconcile file-based artifacts (transcripts, surveys, interviews, collateral)
 * into Google Drive. Idempotent: re-runs update existing files by driveFileId.
 */

import { readText, repoPath, fileExists } from "../../util/fs.js";
import { hasEnv } from "../../util/env.js";
import type { World } from "../../ledger/schema.js";
import { Ledger } from "../../ledger/ledger.js";
import {
  type Connector,
  type ReconcileOptions,
  type ReconcileStats,
  emptyStats,
  disabledStats,
} from "../types.js";
import type { Config } from "../../config/schema.js";
import { CohortIndex } from "../../cohort.js";
import { DriveClient } from "./client.js";
import { DRIVE_FILE_KINDS as FILE_KINDS } from "../kinds.js";

export async function reconcileDrive(
  world: World,
  cfg: Config,
  opts: ReconcileOptions,
): Promise<ReconcileStats> {
  if (!cfg.connectors.drive.enabled) return disabledStats("drive");
  // Artifact kind → top folder, from config/connectors.yaml.
  const folderByKind = cfg.connectors.drive.folders;
  const stats = emptyStats("drive");
  const ledger = new Ledger(world);

  // Cohort gate: only deals that are meant to exist in the demo org get their
  // prose published. Non-members keep their artifacts in the repo and nowhere else.
  const cohort = opts.cohort ?? new CohortIndex();

  const pending = world.artifacts.filter(
    (a) =>
      FILE_KINDS.includes(a.kind) &&
      a.status === "generated" &&
      a.contentPath &&
      cohort.has(a.dealId) &&
      (!opts.oppId || a.dealId === opts.oppId),
  );
  if (pending.length === 0) {
    stats.note = "no generated file artifacts to reconcile";
    return stats;
  }

  if (!hasEnv("GOOGLE_APPLICATION_CREDENTIALS", "DRIVE_ROOT_FOLDER_ID")) {
    stats.disabled = true;
    stats.note = "Drive credentials absent (.env), skipped";
    stats.skipped = pending.length;
    return stats;
  }

  if (opts.dryRun) {
    stats.note = "dry-run";
    stats.skipped = pending.length;
    return stats;
  }

  const client = DriveClient.fromEnv();

  for (const artifact of pending) {
    try {
      const path = repoPath(artifact.contentPath!);
      if (!fileExists(path)) {
        stats.errors.push({ entity: artifact.id, message: `content file missing: ${artifact.contentPath}` });
        continue;
      }
      const content = readText(path);
      const topFolder = folderByKind[artifact.kind] ?? "Misc";
      // Group deal artifacts under their account for a believable tree.
      let folderId: string;
      if (artifact.dealId) {
        const acct = ledger.account(ledger.opportunity(artifact.dealId).accountId);
        const top = await client.ensureFolder(topFolder);
        folderId = await client.ensureFolder(acct.name, top);
      } else {
        folderId = await client.ensureFolder(topFolder);
      }
      const name = `${artifact.date} — ${artifact.title}.md`; // prose-lint: allow-emdash (external record name)
      const existing = artifact.external.driveFileId;
      const fileId = await client.upsertMarkdown(folderId, name, content, existing);
      artifact.external.driveFileId = fileId;
      artifact.status = "reconciled";
      if (existing) stats.updated++;
      else stats.created++;
    } catch (e) {
      stats.errors.push({ entity: artifact.id, message: (e as Error).message });
    }
  }
  return stats;
}

export const driveConnector: Connector = { name: "drive", reconcile: reconcileDrive };
