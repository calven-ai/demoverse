/**
 * Generation-request protocol (the key agent<->engine handoff). See DESIGN.md §12.
 *
 * Each `apply` run computes the next desired world state and emits grounded
 * generation requests, one per prose artifact, carrying the exact ledger facts
 * + the prompt. The driving agent fills them in-session (Claude Max tokens); the
 * deterministic package then validates + files + reconciles each result,
 * re-requesting on validation failure.
 *
 * Layout (state/requests/ is gitignored scratch):
 *   state/requests/<periodIndex>/manifest.json:      index of all requests
 *   state/requests/<periodIndex>/<id>.prompt.md:     the grounded prompt (agent reads)
 *   state/requests/<periodIndex>/results/<id>.md:    agent writes markdown here
 *   state/requests/<periodIndex>/results/<id>.json:  or structured slack messages here
 */

import { createHash } from "node:crypto";
import { repoPath, writeJson, writeText, readText, readJson, fileExists, ensureDir } from "../util/fs.js";
import type { ArtifactKind, SlackMessage, EmailMessage } from "../ledger/schema.js";

export type OutputFormat = "markdown" | "slack_messages" | "email_thread";

/** A raw email as the agent returns it (contactRef resolved to a contactId at ingest). */
export interface EmailDraft {
  from: string;
  to: string[];
  subject: string;
  body: string;
  date: string;
  contactRef?: string;
}

export interface GenerationRequest {
  /** Matches the artifact id it fills. */
  artifactId: string;
  kind: ArtifactKind;
  detailLevel: "low" | "medium" | "high";
  title: string;
  date: string;
  output: OutputFormat;
  /** Exact ledger facts the prose must honor (checked by the linter). */
  grounding: Record<string, unknown>;
  /** The full grounded prompt for the agent. */
  prompt: string;
}

export interface GenerationResult {
  artifactId: string;
  markdown?: string;
  messages?: { personaHandle: string; text: string }[];
  emails?: EmailDraft[];
}

function periodDir(periodIndex: number): string {
  return repoPath("state", "requests", String(periodIndex));
}

function resultsDir(periodIndex: number): string {
  return repoPath("state", "requests", String(periodIndex), "results");
}

/** Write the request bundle for a period (manifest + per-request prompt files). */
export function emitRequests(periodIndex: number, requests: GenerationRequest[]): string {
  const dir = periodDir(periodIndex);
  ensureDir(dir);
  ensureDir(resultsDir(periodIndex));
  writeJson(repoPath(dir, "manifest.json"), {
    periodIndex,
    count: requests.length,
    requests: requests.map((r) => ({
      artifactId: r.artifactId,
      kind: r.kind,
      output: r.output,
      title: r.title,
      promptFile: `${r.artifactId}.prompt.md`,
      resultFile: r.output === "markdown" ? `results/${r.artifactId}.md` : `results/${r.artifactId}.json`,
      // markdown → .md ; slack_messages & email_thread → .json
    })),
  });
  for (const r of requests) {
    writeText(repoPath(dir, `${r.artifactId}.prompt.md`), r.prompt);
  }
  return dir;
}

/** Read a filled result for an artifact, if the agent has produced one. */
export function readResult(periodIndex: number, req: GenerationRequest): GenerationResult | null {
  if (req.output === "markdown") {
    const path = repoPath(resultsDir(periodIndex), `${req.artifactId}.md`);
    if (!fileExists(path)) return null;
    return { artifactId: req.artifactId, markdown: readText(path) };
  }
  const path = repoPath(resultsDir(periodIndex), `${req.artifactId}.json`);
  if (!fileExists(path)) return null;
  if (req.output === "email_thread") {
    const parsed = readJson<{ emails?: EmailDraft[] }>(path);
    return { artifactId: req.artifactId, emails: parsed.emails ?? [] };
  }
  const parsed = readJson<{ messages?: { personaHandle: string; text: string }[] }>(path);
  return { artifactId: req.artifactId, messages: parsed.messages ?? [] };
}

export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function messagesHash(messages: SlackMessage[]): string {
  return contentHash(messages.map((m) => `${m.personaHandle}:${m.text}`).join("\n"));
}

export function emailsHash(emails: EmailMessage[]): string {
  return contentHash(emails.map((e) => `${e.from}|${e.subject}|${e.body}`).join("\n"));
}
