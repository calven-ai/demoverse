/**
 * Tiny argv helpers shared by the script entrypoints.
 *
 * Demoverse's whole interface is npm scripts, so `--help` is the only
 * discovery surface a user has. Every entrypoint that takes flags should
 * describe them here rather than in a header comment nobody runs.
 */

/** Value of `--name=value`, or undefined. Values may contain `=`. */
export function arg(name: string, argv: string[] = process.argv): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

/** Whether the bare `--name` flag is present. */
export function flag(name: string, argv: string[] = process.argv): boolean {
  return argv.includes(`--${name}`);
}

/** One documented flag: its spelling and what it does. */
export interface FlagDoc {
  /** As typed, e.g. `--weeks=N`. */
  name: string;
  /** One or more lines of description. */
  desc: string | string[];
}

export interface Usage {
  /** How the command is invoked, e.g. `npm run apply -- [flags]`. */
  usage: string;
  /** One-line summary printed above the flag list. */
  summary: string;
  flags?: FlagDoc[];
  /** Worked invocations, printed last. */
  examples?: { cmd: string; desc: string }[];
  /** Free-form trailing paragraphs (docs pointers, caveats). */
  notes?: string[];
}

const GUTTER = 26;

function renderFlag(f: FlagDoc): string {
  const lines = Array.isArray(f.desc) ? f.desc : [f.desc];
  const indent = " ".repeat(GUTTER);
  // Short names sit on one line; a name too long for the gutter wraps its
  // description to the next line rather than pushing the column out.
  const pad = f.name.length <= GUTTER - 3 ? " ".repeat(GUTTER - 2 - f.name.length) : "\n" + indent;
  const head = `  ${f.name}${pad}${lines[0] ?? ""}`;
  const rest = lines.slice(1).map((l) => `${indent}${l}`);
  return [head, ...rest].join("\n");
}

export function formatUsage(u: Usage): string {
  const out: string[] = ["", u.summary, "", `Usage: ${u.usage}`];
  if (u.flags?.length) {
    out.push("", "Flags:", ...u.flags.map(renderFlag));
  }
  if (u.examples?.length) {
    out.push("", "Examples:");
    for (const e of u.examples) out.push(`  ${e.cmd}`, `      ${e.desc}`);
  }
  if (u.notes?.length) out.push("", ...u.notes);
  out.push("");
  return out.join("\n");
}

/**
 * Print usage and exit 0 when `--help` / `-h` is present. Call it as the first
 * statement of `main()`, before any config or ledger load, so `--help` works on
 * a clone that has neither.
 */
export function helpIfRequested(u: Usage, argv: string[] = process.argv): void {
  if (!argv.includes("--help") && !argv.includes("-h")) return;
  console.log(formatUsage(u));
  process.exit(0);
}
