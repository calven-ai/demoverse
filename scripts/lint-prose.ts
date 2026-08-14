/**
 * `npm run lint:prose` - house style check for the repository's own text.
 *
 * One rule, mechanically enforced: no em dashes in tracked text files. They are
 * the loudest tell that a doc was written by a language model, and they creep
 * back in every time someone pastes generated prose into a README.
 *
 * Rewrite the sentence instead. A period usually does the job; sometimes the
 * aside deserves its own sentence, and sometimes it deserves deleting.
 *
 * A line that genuinely needs an em dash (an external record name, say) can opt
 * out with a `prose-lint: allow-emdash` comment on the same line.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EM_DASH = "—"; // prose-lint: allow-emdash (the needle itself)
const ALLOW = "prose-lint: allow-emdash";

const EXTENSIONS = [".md", ".ts", ".js", ".mjs", ".yaml", ".yml", ".json"];

/** Generated content, vendored text and rendered assets are not ours to style. */
const SKIP = [
  "package-lock.json",
  "tests/golden.snapshot.json",
  "CODE_OF_CONDUCT.md", // verbatim Contributor Covenant
  "state/content/",
  "state/requests/",
  "docs/assets/",
];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))
    .filter((f) => !SKIP.some((skip) => f.startsWith(skip) || f === skip));
}

function main(): void {
  const findings: string[] = [];

  for (const file of trackedFiles()) {
    const markdown = file.endsWith(".md");
    let fenced = false;

    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // Fenced blocks in docs hold commands and sample payloads, including
        // artifact titles the engine really does build with an em dash. Quoting
        // them accurately beats house style.
        if (markdown && line.trimStart().startsWith("```")) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        if (line.includes(ALLOW)) return;
        // Inline code spans quote real output too, so only the prose around
        // them is ours to style.
        const prose = markdown ? line.replace(/`[^`]*`/g, "") : line;
        if (!prose.includes(EM_DASH)) return;
        findings.push(`${file}:${i + 1}  ${line.trim()}`);
      });
  }

  if (findings.length === 0) {
    console.log("prose lint: clean, no em dashes");
    return;
  }

  console.log(findings.join("\n"));
  console.log(`\nprose lint: ${findings.length} em dash(es). Rewrite the sentence.`);
  console.log(`Genuinely needed? Add a \`${ALLOW}\` comment on the line.`);
  process.exit(1);
}

main();
