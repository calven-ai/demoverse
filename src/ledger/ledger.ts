/** Ledger I/O + id helpers + typed queries over state/world.json. */

import { z } from "zod";
import { repoPath, readJson, writeJson, fileExists } from "../util/fs.js";
import { World, type Account, type Contact, type Opportunity, type Artifact, type Rep } from "./schema.js";

const WORLD_PATH = repoPath("state", "world.json");

export function worldPath(): string {
  return WORLD_PATH;
}

/** An empty world with a fixed seed (used by `init`). */
export function emptyWorld(seed = "demoverse-v1"): World {
  return World.parse({
    seed,
    version: 1,
    reps: [],
    accounts: [],
    contacts: [],
    opportunities: [],
    artifacts: [],
  });
}

export function loadWorld(): World {
  if (!fileExists(WORLD_PATH)) {
    throw new Error("state/world.json not found. Run `npm run init` first.");
  }
  const raw = readJson(WORLD_PATH);
  const result = World.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid ledger (state/world.json):\n${lines.join("\n")}`);
  }
  return result.data;
}

export function saveWorld(world: World): void {
  // Validate before persisting — never write a malformed ledger.
  writeJson(WORLD_PATH, World.parse(world));
}

/** Stable, human-readable id: `<prefix>-<n>` (e.g. acc-001). */
export function makeId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

/** Next sequential id for a collection, given the prefix. */
export function nextId(existing: { id: string }[], prefix: string): string {
  let max = 0;
  for (const item of existing) {
    const m = item.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return makeId(prefix, max + 1);
}

// --- typed lookups -----------------------------------------------------------

export class Ledger {
  constructor(public world: World) {}

  rep(id: string): Rep {
    return req(
      this.world.reps.find((r) => r.id === id),
      `rep ${id}`,
    );
  }
  account(id: string): Account {
    return req(
      this.world.accounts.find((a) => a.id === id),
      `account ${id}`,
    );
  }
  contact(id: string): Contact {
    return req(
      this.world.contacts.find((c) => c.id === id),
      `contact ${id}`,
    );
  }
  opportunity(id: string): Opportunity {
    return req(
      this.world.opportunities.find((o) => o.id === id),
      `opportunity ${id}`,
    );
  }
  contactsForAccount(accountId: string): Contact[] {
    return this.world.contacts.filter((c) => c.accountId === accountId);
  }
  artifactsForDeal(dealId: string): Artifact[] {
    return this.world.artifacts.filter((a) => a.dealId === dealId);
  }
  closedDeals(): Opportunity[] {
    return this.world.opportunities.filter((o) => o.status !== "open");
  }
}

function req<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Ledger: ${what} not found`);
  return value;
}

export { World };
export type { z };
