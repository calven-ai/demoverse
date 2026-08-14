/** Minimal .env loader (no dependency) + typed accessors. */

import { repoPath, readText, fileExists } from "./fs.js";

let loaded = false;

/**
 * Load env files into process.env once (does not override already-set vars).
 *
 * `.env` is the documented location and the only one the docs mention.
 * `.env.local` is read first, and wins where both define a key, purely as a
 * courtesy to anyone arriving with the Next.js/Vite habit. Both are gitignored
 * (as is every other `.env*` variant) and either may be absent.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of [".env.local", ".env"]) {
    const path = repoPath(file);
    if (!fileExists(path)) continue;
    for (const rawLine of readText(path).split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

/** Read an env var; throw a clear error if missing and required. */
export function env(key: string, required = false): string | undefined {
  loadEnv();
  const v = process.env[key];
  if (required && (v === undefined || v === "")) {
    throw new Error(`Missing required env var ${key}. Copy .env.example to .env; see docs/connectors/.`);
  }
  return v || undefined;
}

/** True if all of the given vars are present and non-empty. */
export function hasEnv(...keys: string[]): boolean {
  loadEnv();
  return keys.every((k) => process.env[k] !== undefined && process.env[k] !== "");
}
