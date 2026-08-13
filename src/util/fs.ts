/** Small filesystem helpers: JSON / YAML read-write with stable formatting. */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/** Repo root, resolved relative to this file (src/util/fs.ts -> ../../). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolve a path relative to the repo root. */
export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readYaml<T = unknown>(path: string): T {
  return parseYaml(readText(path)) as T;
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

/** Write JSON with a trailing newline and 2-space indent (git-friendly diffs). */
export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(path: string, value: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, value, "utf8");
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
