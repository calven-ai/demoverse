/**
 * Tier-2 active-directive reader (state/directives.md). See DESIGN.md §11.
 *
 * The directives file is human-authored markdown; the engine only needs to echo
 * the active entries back each run (so the operator sees what's in force) — the
 * actual materialization lives in trends.json, which the agent edits when a
 * directive is set. This parses the bullet entries under the `## Active` heading.
 */

import { repoPath, readText, fileExists } from "./util/fs.js";

const DIRECTIVES_PATH = repoPath("state", "directives.md");

export function readActiveDirectives(): string[] {
  if (!fileExists(DIRECTIVES_PATH)) return [];
  // Strip HTML comment blocks (the seed file documents examples inside them).
  const text = readText(DIRECTIVES_PATH).replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split("\n");
  const out: string[] = [];
  let inActive = false;
  for (const line of lines) {
    if (/^##\s+Active\b/i.test(line)) {
      inActive = true;
      continue;
    }
    if (/^##\s+/.test(line)) {
      inActive = false;
      continue;
    }
    if (!inActive) continue;
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (m && !/^_None/i.test(m[1]!)) {
      // Collapse bold markers for a clean console echo.
      out.push(m[1]!.replace(/\*\*/g, "").trim());
    }
  }
  return out;
}
