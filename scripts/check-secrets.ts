/**
 * `npm run secrets:check` - refuse to let credentials enter git history.
 *
 * Demoverse is a public repository that people clone and then point at their
 * own Salesforce org, Slack workspace, HubSpot portal and Drive folder. The
 * dangerous moment is the one right after they paste a token in. `.gitignore`
 * covers the file they were told to create (`.env`), but it cannot cover two
 * cases that show up again and again:
 *
 *   1. A credential parked under a name nobody predicted (`.env.prod`,
 *      `client_secret_1234.json` straight out of the Google console).
 *   2. `.env.example` filled in where it sits. That file has to stay tracked,
 *      so no ignore rule can ever save it.
 *
 * This script catches both. It runs in CI over tracked files, and from the
 * pre-commit hook (`npm run secrets:hook`) over staged files, which is the
 * only one of the two that runs before the secret leaves the machine.
 *
 * Exit code 1 means "do not commit this". There is no allow-list flag on
 * purpose: if a file legitimately trips the check, rename it or unstage it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** The one env file that is meant to be tracked. Everything else is suspect. */
const TEMPLATE = ".env.example";

/**
 * Filenames that carry credentials. Matched against the basename, so a key
 * tucked into `keys/` or `config/` is caught just the same.
 */
const CREDENTIAL_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /^\.env($|\.)/i, what: "an environment file" },
  { re: /^service-account.*\.json$/i, what: "a GCP service-account key" },
  { re: /^gcp-key.*\.json$/i, what: "a GCP key" },
  { re: /^client_secret.*\.json$/i, what: "a Google OAuth client secret" },
  { re: /credentials.*\.json$/i, what: "a credentials file" },
  { re: /^token\.json$/i, what: "an OAuth token cache" },
  { re: /\.(pem|p12|pfx|key)$/i, what: "a private key" },
];

/**
 * The only `KEY=value` pairs `.env.example` may ship with a value. Public
 * endpoints and a relative path, all three non-secret. Matched whole, so
 * editing a value to a real one still trips the check.
 */
const TEMPLATE_ALLOWED = new Set([
  "SF_LOGIN_URL=https://login.salesforce.com",
  "HUBSPOT_API_BASE_URL=https://api.hubapi.com",
  "GOOGLE_APPLICATION_CREDENTIALS=./service-account.json",
]);

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function gitFiles(staged: boolean): string[] {
  const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "-z"];
  const out = execFileSync("git", args, { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/** Files whose very presence in git is the problem. */
function findCredentialFiles(files: string[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file === TEMPLATE) continue;
    const name = basename(file);
    const hit = CREDENTIAL_PATTERNS.find((p) => p.re.test(name));
    if (hit) problems.push(`${file} looks like ${hit.what}`);
  }
  return problems;
}

/** The template is tracked by design, so its contents get checked instead. */
function findFilledTemplate(): string[] {
  if (!existsSync(TEMPLATE)) return [];
  const problems: string[] = [];
  const lines = readFileSync(TEMPLATE, "utf8").split("\n");
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq === -1) return;
    const value = line.slice(eq + 1).trim();
    if (!value) return;
    if (TEMPLATE_ALLOWED.has(line)) return;
    const key = line.slice(0, eq).trim();
    problems.push(`${TEMPLATE}:${i + 1} ${key} has a value. The template ships empty.`);
  });
  return problems;
}

function main(): void {
  const staged = process.argv.includes("--staged");
  const scope = staged ? "staged" : "tracked";

  const files = gitFiles(staged);
  const problems = [...findCredentialFiles(files), ...findFilledTemplate()];

  if (problems.length === 0) {
    console.log(`secrets: clean (${files.length} ${scope} files checked)`);
    return;
  }

  console.error(`\nsecrets: refusing to continue. ${problems.length} problem(s) found.\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    [
      "",
      "Credentials must never enter git history. Once pushed they are burned,",
      "and rotating them is the only real fix.",
      "",
      "  Put secrets in .env, which is gitignored:  cp .env.example .env",
      "  Leave .env.example empty. It is the tracked template, not your copy.",
      "  Already staged? Unstage it:                git restore --staged <file>",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

main();
