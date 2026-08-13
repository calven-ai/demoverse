/**
 * `npm run drive:audit` — reconcile the Drive folder against the ledger.
 *
 * Drive is the one destination the downstream product ingests blind: its watched-folder
 * connector reads whatever is in there, with no CRM join to check it against.
 * So a file left behind by a previous world generation does not sit harmlessly —
 * the product ingests it and derives accounts, deals and quotes for a company that
 * exists nowhere in Salesforce.
 *
 * That is exactly what a `init --force` regeneration produces: the new ledger
 * carries no driveFileId for anything, so the engine re-uploads, and the old
 * files stay. This audit finds them by walking the folder tree and matching
 * every file id against `artifact.external.driveFileId`.
 *
 *   npm run drive:audit                             # report
 *   npm run drive:audit -- --purge --confirm        # trash the orphans
 *   npm run drive:audit -- --prune-empty --confirm  # trash empty account folders
 *
 * Purge moves files to the Drive trash (recoverable for 30 days), never a
 * permanent delete, and only ever touches files the LEDGER does not claim.
 * --prune-empty is cosmetic: an empty folder is invisible to the watched-folder connector,
 * which reads files, but it clutters the view for anyone browsing the org.
 */

import { google, type drive_v3 } from "googleapis";
import { env } from "../src/util/env.js";
import { loadWorld } from "../src/ledger/ledger.js";

const purge = process.argv.includes("--purge");
const pruneEmpty = process.argv.includes("--prune-empty");
const confirm = process.argv.includes("--confirm");
const FOLDER_MIME = "application/vnd.google-apps.folder";

const auth = new google.auth.GoogleAuth({
  keyFile: env("GOOGLE_APPLICATION_CREDENTIALS", true)!,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });
// The demo root is a Shared Drive, so every call must opt into shared-drive items.
const shared = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

async function children(parentId: string): Promise<drive_v3.Schema$File[]> {
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,createdTime)",
      pageSize: 1000,
      pageToken,
      ...shared,
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

interface Orphan {
  id: string;
  name: string;
  account: string;
  kind: string;
  createdTime: string;
}

async function main(): Promise<void> {
  const world = loadWorld();
  const claimed = new Set(
    world.artifacts.map((a) => a.external.driveFileId).filter((id): id is string => Boolean(id)),
  );
  const ledgerAccounts = new Set(world.accounts.map((a) => a.name));

  const root = env("DRIVE_ROOT_FOLDER_ID", true)!;
  let total = 0;
  const orphans: Orphan[] = [];
  const emptyFolders: { id: string; name: string; kind: string }[] = [];

  // Layout is root / <kind folder> / <account> / <file>, but tolerate files
  // sitting directly under a kind folder too.
  for (const kindFolder of await children(root)) {
    if (kindFolder.mimeType !== FOLDER_MIME) {
      total++;
      if (!claimed.has(kindFolder.id!)) {
        orphans.push({
          id: kindFolder.id!,
          name: kindFolder.name!,
          account: "(root)",
          kind: "(root)",
          createdTime: kindFolder.createdTime ?? "",
        });
      }
      continue;
    }
    for (const acctFolder of await children(kindFolder.id!)) {
      const bucket = acctFolder.mimeType === FOLDER_MIME ? await children(acctFolder.id!) : [acctFolder];
      const account = acctFolder.mimeType === FOLDER_MIME ? acctFolder.name! : "(loose)";
      if (acctFolder.mimeType === FOLDER_MIME && bucket.length === 0) {
        emptyFolders.push({ id: acctFolder.id!, name: acctFolder.name!, kind: kindFolder.name! });
      }
      for (const file of bucket) {
        if (file.mimeType === FOLDER_MIME) continue;
        total++;
        if (!claimed.has(file.id!)) {
          orphans.push({
            id: file.id!,
            name: file.name!,
            account,
            kind: kindFolder.name!,
            createdTime: file.createdTime ?? "",
          });
        }
      }
    }
  }

  console.log(`Drive root ${root}\n`);
  console.log(`  files present      ${total}`);
  console.log(`  claimed by ledger  ${total - orphans.length}`);
  console.log(`  ORPHANED           ${orphans.length}`);
  if (emptyFolders.length > 0) console.log(`  empty folders      ${emptyFolders.length}`);
  console.log();

  // Cosmetic pass — safe to run whether or not orphans remain.
  if (pruneEmpty && emptyFolders.length > 0) {
    if (!confirm) {
      console.log(`--prune-empty requires --confirm. Nothing changed.`);
    } else {
      let gone = 0;
      for (const f of emptyFolders) {
        try {
          await drive.files.update({ fileId: f.id, requestBody: { trashed: true }, ...shared });
          gone++;
        } catch {
          /* a folder that refuses to trash is not worth failing the audit over */
        }
      }
      console.log(`✓ trashed ${gone} empty account folder(s).\n`);
    }
  }

  if (orphans.length === 0) {
    console.log("✓ Drive matches the ledger exactly.");
    if (emptyFolders.length > 0 && !pruneEmpty) {
      console.log(
        `  (${emptyFolders.length} empty account folder(s) remain — clear with --prune-empty --confirm)`,
      );
    }
    return;
  }

  // Group orphans by account, and flag whether that account still exists at all.
  const byAccount = new Map<string, Orphan[]>();
  for (const o of orphans) {
    const list = byAccount.get(o.account) ?? [];
    list.push(o);
    byAccount.set(o.account, list);
  }
  const stale = [...byAccount].filter(([n]) => !ledgerAccounts.has(n));
  const live = [...byAccount].filter(([n]) => ledgerAccounts.has(n));

  console.log(
    `Orphans under accounts NO LONGER IN THE LEDGER — ${stale.reduce((s, [, v]) => s + v.length, 0)} file(s), ${stale.length} account(s):`,
  );
  for (const [name, files] of stale.slice(0, 15)) console.log(`   ${name.padEnd(26)} ${files.length}`);
  if (stale.length > 15) console.log(`   … +${stale.length - 15} more account(s)`);

  if (live.length > 0) {
    console.log(
      `\n⚠ Orphans under accounts that DO exist — ${live.reduce((s, [, v]) => s + v.length, 0)} file(s), ${live.length} account(s).`,
    );
    console.log(`  These are likely duplicates from a re-upload; review before purging.`);
    for (const [name, files] of live.slice(0, 10)) console.log(`   ${name.padEnd(26)} ${files.length}`);
  }

  if (!purge) {
    console.log(
      `\nRe-run with --purge --confirm to move all ${orphans.length} orphan(s) to the Drive trash.`,
    );
    return;
  }
  if (!confirm) {
    console.log(`\n--purge requires --confirm. Nothing changed.`);
    return;
  }

  let trashed = 0;
  const failures: string[] = [];
  for (const o of orphans) {
    try {
      await drive.files.update({ fileId: o.id, requestBody: { trashed: true }, ...shared });
      trashed++;
    } catch (e) {
      if (failures.length < 5) failures.push(`${o.name}: ${(e as Error).message}`);
    }
  }
  console.log(
    `\n✓ trashed ${trashed} orphan file(s)${failures.length ? `, ${failures.length} failed` : ""}.`,
  );
  for (const f of failures) console.log(`   ✗ ${f}`);
  console.log(`  Recoverable from the Drive trash for 30 days.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
