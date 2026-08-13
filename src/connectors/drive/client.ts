/**
 * Google Drive client (service account). See DESIGN.md §3, §14.
 *
 * Markdown artifacts live in a structured folder tree under a dedicated demo
 * folder shared with the service-account email. Upserts are idempotent: the
 * ledger records each file's driveFileId, so re-runs update rather than create.
 */

import { google, type drive_v3 } from "googleapis";
import { env } from "../../util/env.js";

export class DriveClient {
  private drive: drive_v3.Drive;
  private folderCache = new Map<string, string>();

  constructor(private rootFolderId: string) {
    const auth = new google.auth.GoogleAuth({
      keyFile: env("GOOGLE_APPLICATION_CREDENTIALS", true),
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    this.drive = google.drive({ version: "v3", auth });
  }

  static fromEnv(): DriveClient {
    return new DriveClient(env("DRIVE_ROOT_FOLDER_ID", true)!);
  }

  /** Find-or-create a subfolder by name under a parent; cached per run. */
  async ensureFolder(name: string, parentId = this.rootFolderId): Promise<string> {
    const cacheKey = `${parentId}/${name}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) return cached;

    const q = [
      `'${parentId}' in parents`,
      `name = '${name.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ].join(" and ");
    const list = await this.drive.files.list({
      q,
      fields: "files(id,name)",
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existing = list.data.files?.[0]?.id;
    if (existing) {
      this.folderCache.set(cacheKey, existing);
      return existing;
    }
    const created = await this.drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
      fields: "id",
      supportsAllDrives: true,
    });
    const id = created.data.id!;
    this.folderCache.set(cacheKey, id);
    return id;
  }

  /** Create or update a markdown file; returns its fileId. */
  async upsertMarkdown(
    folderId: string,
    name: string,
    content: string,
    existingFileId?: string,
  ): Promise<string> {
    const media = { mimeType: "text/markdown", body: content };
    if (existingFileId) {
      await this.drive.files.update({ fileId: existingFileId, media, supportsAllDrives: true });
      return existingFileId;
    }
    const created = await this.drive.files.create({
      requestBody: { name, parents: [folderId], mimeType: "text/markdown" },
      media,
      fields: "id",
      supportsAllDrives: true,
    });
    return created.data.id!;
  }

  /** Smoke test: create -> read -> delete a temp file (Phase A). */
  async smokeTest(): Promise<void> {
    const folder = await this.ensureFolder("_smoke");
    const id = await this.upsertMarkdown(folder, "smoke.md", "# smoke test\n");
    await this.drive.files.get({ fileId: id, fields: "id,name", supportsAllDrives: true });
    // Trash rather than permanently delete: on a Shared Drive, a non-Manager
    // member can move items to trash but cannot files.delete them (404).
    await this.drive.files.update({ fileId: id, requestBody: { trashed: true }, supportsAllDrives: true });
  }
}
