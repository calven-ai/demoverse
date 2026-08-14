/**
 * Ingest filled generation results back into the ledger. See docs/architecture.md#the-generation-request-protocol.
 *
 * After the agent fills the requests, this validates each result, files markdown
 * bodies into the content store (state/content/<id>.md, committed, so the world
 * is rebuildable and diffs are readable), and attaches structured Slack messages
 * to their artifacts. Schema/shape failures leave the artifact "planned" so it is
 * re-requested rather than written as bad data.
 */

import { z } from "zod";
import { repoPath, writeText } from "../util/fs.js";
import type { Config } from "../config/schema.js";
import { World, type Artifact, type SlackMessage, type EmailMessage } from "../ledger/schema.js";
import { readResult, contentHash, messagesHash, emailsHash, type GenerationRequest } from "./requests.js";

const SlackResultSchema = z.object({
  messages: z.array(z.object({ personaHandle: z.string().min(1), text: z.string().min(1) })).min(1),
});

const EmailResultSchema = z.object({
  emails: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.array(z.string()).default([]),
        subject: z.string().min(1),
        body: z.string().min(1),
        date: z.string().min(1),
        contactRef: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Resolve an email's `contactRef` ("Name <email>", a bare email, or a name) to a
 * real buying-group contact id on the deal (for the SF Task WhoId). Unmatched → undefined.
 */
function dealContactResolver(world: World, artifact: Artifact): (ref?: string) => string | undefined {
  if (!artifact.dealId) return () => undefined;
  const opp = world.opportunities.find((o) => o.id === artifact.dealId);
  if (!opp) return () => undefined;
  const contacts = world.contacts.filter((c) => opp.contactIds.includes(c.id));
  const byEmail = new Map(contacts.map((c) => [c.email.toLowerCase(), c.id]));
  const byName = new Map(contacts.map((c) => [c.name.toLowerCase(), c.id]));
  return (ref?: string) => {
    if (!ref) return undefined;
    const r = ref.trim().toLowerCase();
    const email = r.match(/<([^>]+)>/)?.[1]?.trim() ?? r;
    return byEmail.get(email) ?? byEmail.get(r) ?? byName.get(r);
  };
}

export interface IngestReport {
  filled: string[];
  pending: string[];
  invalid: { artifactId: string; reason: string }[];
}

/** Build handle -> {display, avatar} from reps + persona config. The Slack display
 * name carries the persona's role in parentheses so it's clear who's speaking, e.g.
 * "Lukas (Account Executive)" or "Alex Romano (Head of Product Marketing)". */
function personaResolver(
  world: World,
  cfg: Config,
): (handle: string) => { display: string; avatar?: string } {
  const map = new Map<string, { display: string; avatar?: string }>();
  const withRole = (name: string, role?: string): string => (role ? `${name} (${role})` : name);
  // The customer's sales org: deal-owning ICs are Account Executives; managers
  // show their management title. (Their CRM `title` may say something else, e.g.
  // "Co-founder", but in the Slack sales context they are AEs.)
  const repRole = (r: World["reps"][number]): string =>
    r.role === "manager" ? (r.title ?? "Sales Manager") : "Account Executive";
  for (const r of world.reps) {
    map.set(handleFor(r.name), { display: withRole(r.name, repRole(r)) });
  }
  // rep_personas pin the avatar; role still comes from the matching rep.
  for (const p of cfg.slackPersonas.rep_personas) {
    const rep = world.reps.find((r) => handleFor(r.name) === p.handle);
    map.set(p.handle, {
      display: withRole(p.display, rep ? repRole(rep) : "Account Executive"),
      avatar: p.avatar,
    });
  }
  // Standing internal personas carry an explicit role.
  for (const p of cfg.slackPersonas.internal_personas) {
    map.set(p.handle, { display: withRole(p.display, p.role), avatar: p.avatar });
  }
  return (handle: string) => map.get(handle) ?? { display: handle };
}

function handleFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, ".");
}

export function ingestResults(
  world: World,
  cfg: Config,
  periodIndex: number,
  requests: GenerationRequest[],
): IngestReport {
  const report: IngestReport = { filled: [], pending: [], invalid: [] };
  const resolve = personaResolver(world, cfg);
  const byId = new Map(world.artifacts.map((a) => [a.id, a]));

  for (const req of requests) {
    const artifact = byId.get(req.artifactId);
    if (!artifact) continue;
    if (artifact.status !== "planned") continue; // already generated/reconciled

    const result = readResult(periodIndex, req);
    if (!result) {
      report.pending.push(req.artifactId);
      continue;
    }

    if (req.output === "markdown") {
      const md = (result.markdown ?? "").trim();
      if (md.length < 20) {
        report.invalid.push({ artifactId: req.artifactId, reason: "markdown result too short / empty" });
        report.pending.push(req.artifactId);
        continue;
      }
      const contentPath = `state/content/${artifact.id}.md`;
      writeText(repoPath(contentPath), md + "\n");
      artifact.contentPath = contentPath;
      artifact.contentHash = contentHash(md);
      artifact.status = "generated";
      report.filled.push(req.artifactId);
    } else if (req.output === "email_thread") {
      const parsed = EmailResultSchema.safeParse({ emails: result.emails });
      if (!parsed.success) {
        report.invalid.push({ artifactId: req.artifactId, reason: "invalid email thread shape" });
        report.pending.push(req.artifactId);
        continue;
      }
      const resolve2 = dealContactResolver(world, artifact);
      const emails: EmailMessage[] = parsed.data.emails.map((e) => ({
        from: e.from,
        to: e.to,
        subject: e.subject,
        body: e.body,
        date: e.date,
        contactId: resolve2(e.contactRef),
      }));
      artifact.emails = emails;
      artifact.contentHash = emailsHash(emails);
      artifact.status = "generated";
      report.filled.push(req.artifactId);
    } else {
      const parsed = SlackResultSchema.safeParse({ messages: result.messages });
      if (!parsed.success) {
        report.invalid.push({ artifactId: req.artifactId, reason: "invalid slack messages shape" });
        report.pending.push(req.artifactId);
        continue;
      }
      const messages: SlackMessage[] = parsed.data.messages.map((m) => {
        const persona = resolve(m.personaHandle);
        return {
          personaHandle: m.personaHandle,
          personaDisplay: persona.display,
          avatar: persona.avatar,
          text: m.text,
        };
      });
      artifact.messages = messages;
      artifact.contentHash = messagesHash(messages);
      artifact.status = "generated";
      report.filled.push(req.artifactId);
    }
  }

  // Validate the whole ledger after mutation (never persist a malformed world).
  World.parse(world);
  return report;
}

export type { Artifact };
