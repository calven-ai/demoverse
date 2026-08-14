/**
 * Salesforce (Developer Edition) client over the raw REST + SOAP-login APIs via
 * `fetch`. See docs/architecture.md#connectors.
 *
 * Auth uses the SOAP partner `login` call (username + password + security token)
 * to obtain a session id + instance URL; all record I/O then goes through the
 * REST sObject API. We deliberately avoid the jsforce SDK because its HTTP transport
 * hangs under this runtime (tsx/Node) while raw fetch works reliably.
 *
 * Custom fields expected on the org are created by `scripts/sf-setup.ts`
 * (the reconciler in ./reconcile.ts is the source of truth for the full set).
 */

import { env } from "../../util/env.js";

const API_VERSION = "59.0";

/**
 * Map an engine pipeline stage to the Salesforce StageName picklist value using
 * the operator's `config/connectors.yaml` `salesforce.stage_map`. Closed deals
 * map from status, not stage.
 */
export function sfStageFor(
  stageMap: Record<string, string>,
  stage: string,
  status: "open" | "won" | "lost",
): string {
  if (status === "won") return "Closed Won";
  if (status === "lost") return "Closed Lost";
  return stageMap[stage] ?? Object.values(stageMap)[0] ?? "Qualification";
}

const xmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class SalesforceClient {
  private instanceUrl = "";
  private accessToken = "";

  constructor(private loginUrl: string) {}

  static fromEnv(): SalesforceClient {
    return new SalesforceClient(env("SF_LOGIN_URL") ?? "https://login.salesforce.com");
  }

  /** SOAP partner login → session id + instance URL (no jsforce). */
  async login(): Promise<void> {
    const username = env("SF_USERNAME", true)!;
    const password = env("SF_PASSWORD", true)!;
    const token = env("SF_SECURITY_TOKEN") ?? "";
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body><urn:login><urn:username>${xmlEsc(username)}</urn:username><urn:password>${xmlEsc(password + token)}</urn:password></urn:login></soapenv:Body>
</soapenv:Envelope>`;
    const res = await fetch(`${this.loginUrl.replace(/\/$/, "")}/services/Soap/u/${API_VERSION}`, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: "login" },
      body: envelope,
    });
    const xml = await res.text();
    const sid = xml.match(/<sessionId>([^<]*)<\/sessionId>/)?.[1];
    const serverUrl = xml.match(/<serverUrl>([^<]*)<\/serverUrl>/)?.[1];
    if (!sid || !serverUrl) {
      const fault = xml.match(/<faultstring>([^<]*)<\/faultstring>/)?.[1];
      throw new Error(`SF login failed: ${fault ?? `HTTP ${res.status}`}`);
    }
    this.accessToken = sid;
    this.instanceUrl = new URL(serverUrl).origin;
  }

  get apiVersion(): string {
    return API_VERSION;
  }

  getInstanceUrl(): string {
    return this.instanceUrl;
  }

  /** Authenticated REST/Tooling/Metadata request. Throws a readable SF error. */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T | undefined> {
    if (!this.accessToken) throw new Error("SalesforceClient.request called before login()");
    const res = await fetch(`${this.instanceUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const arr = json as { errorCode?: string; message?: string; fields?: string[] }[] | undefined;
      const msg = Array.isArray(arr)
        ? arr
            .map(
              (e) =>
                `${e.errorCode ?? "ERROR"}: ${e.message}${e.fields?.length ? ` [${e.fields.join(", ")}]` : ""}`,
            )
            .join("; ")
        : `HTTP ${res.status} ${text.slice(0, 300)}`;
      throw new Error(msg);
    }
    return json as T;
  }

  /** Run a SOQL query (REST). */
  async query<T = unknown>(soql: string): Promise<{ totalSize: number; done: boolean; records: T[] }> {
    return (await this.request(
      "GET",
      `/services/data/v${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    )) as { totalSize: number; done: boolean; records: T[] };
  }

  /** Create or update a record; returns its Salesforce Id. */
  async upsert(sobject: string, fields: Record<string, unknown>, existingId?: string): Promise<string> {
    if (existingId) {
      await this.request("PATCH", `/services/data/v${API_VERSION}/sobjects/${sobject}/${existingId}`, fields);
      return existingId;
    }
    const path = `/services/data/v${API_VERSION}/sobjects/${sobject}`;
    let res: { id?: string; success?: boolean; errors?: unknown[] } | undefined;
    try {
      res = (await this.request("POST", path, fields)) as typeof res;
    } catch (e) {
      // The ledger is the source of truth. If it holds two same-named contacts,
      // Salesforce must mirror it. Bypass the org's duplicate rule and retry once.
      if (!(e instanceof Error) || !e.message.includes("DUPLICATES_DETECTED")) throw e;
      res = (await this.request("POST", path, fields, {
        "Sforce-Duplicate-Rule-Header": "allowSave=true",
      })) as typeof res;
    }
    if (!res?.id) throw new Error(`SF create ${sobject} failed: ${JSON.stringify(res)}`);
    return res.id;
  }

  /** Smoke test: create -> retrieve -> delete an Account. */
  async smokeTest(): Promise<void> {
    const id = await this.upsert("Account", { Name: "Demo-World Smoke Test" });
    await this.request("GET", `/services/data/v${API_VERSION}/sobjects/Account/${id}`);
    await this.request("DELETE", `/services/data/v${API_VERSION}/sobjects/Account/${id}`);
  }
}
