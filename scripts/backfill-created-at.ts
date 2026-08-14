/**
 * One-off, idempotent backfill: stamp `createdAt` (a business-hours datetime)
 * on every opportunity that predates the field.
 *
 * New deals get `createdAt` at generation time (src/generation/advance.ts). This
 * script brings the existing pipeline up to parity so the Salesforce push has a
 * realistic per-deal creation instant for records already in the ledger.
 *
 * The time is derived deterministically from each opp's own `createdDate`, seeded
 * per opp id (independent of period/generation order), so re-running is a no-op
 * and the value is stable across replays.
 *
 *   npx tsx scripts/backfill-created-at.ts            # stamp + save
 *   npx tsx scripts/backfill-created-at.ts --dry-run  # report only
 */

import { loadWorld, saveWorld } from "../src/ledger/ledger.js";
import { Rng } from "../src/util/rng.js";
import { createdAtFor } from "../src/generation/created-at.js";

const dryRun = process.argv.includes("--dry-run");

function main(): void {
  const world = loadWorld();
  let stamped = 0;
  for (const opp of world.opportunities) {
    if (opp.createdAt) continue; // already has one, leave it untouched
    const rng = new Rng(`${world.seed}|createdAt|${opp.id}`);
    const createdAt = createdAtFor(opp.createdDate, rng);
    if (dryRun) {
      console.log(`  + ${opp.id}  ${opp.createdDate} → ${createdAt}`);
    } else {
      opp.createdAt = createdAt;
    }
    stamped++;
  }
  if (!dryRun && stamped) saveWorld(world);
  console.log(
    `\n${dryRun ? "would stamp" : "stamped"} ${stamped} opp(s); ${world.opportunities.length - stamped} already had createdAt`,
  );
}

main();
