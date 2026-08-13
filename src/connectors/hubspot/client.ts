/**
 * HubSpot CRM client for seeding a dedicated test account.
 *
 * Authentication uses a HubSpot Service Key / private-app access token. This is
 * intentionally separate from any product-side OAuth integration: the token only
 * lets this demo-world utility provision and seed one isolated HubSpot account.
 *
 * Includes both single-record operations (used for the one-opportunity pilot
 * path) and batched operations (used for the full-ledger import), with
 * automatic retry on rate-limit/server errors.
 */

import { env } from "../../util/env.js";

export const HUBSPOT_API_VERSION = "2026-03";

/** Batch endpoints cap at 100 inputs per request. */
const BATCH_CHUNK_SIZE = 100;

export type HubSpotObjectType = "companies" | "contacts" | "deals";
export type HubSpotSingularObjectType = "company" | "contact" | "deal";

interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
}

interface HubSpotObjectWithAssociations extends HubSpotObject {
  associations?: Record<string, { results: { id: string; type: string }[] }>;
}

interface HubSpotPipelineStage {
  id: string;
  label: string;
  displayOrder: number;
  archived?: boolean;
  metadata?: { probability?: string; isClosed?: string };
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  displayOrder: number;
  archived?: boolean;
  stages: HubSpotPipelineStage[];
}

export interface HubSpotPropertySpec {
  name: string;
  label: string;
  groupName: string;
  type: "string" | "datetime";
  fieldType: "text" | "date";
  description: string;
  hasUniqueValue?: boolean;
}

export interface HubSpotAccountInfo {
  portalId: number;
  uiDomain: string;
}

export interface HubSpotBatchInnerError {
  message: string;
  code?: string;
  in?: string;
  subCategory?: string;
  context?: Record<string, unknown>;
}

export interface HubSpotBatchErrorDetail {
  status?: string;
  category?: string;
  message: string;
  context?: Record<string, unknown>;
  id?: string;
  errors?: HubSpotBatchInnerError[];
}

export interface HubSpotBatchResult<T> {
  results: T[];
  errors: HubSpotBatchErrorDetail[];
  numErrors: number;
}

export interface HubSpotBatchUpsertResultItem {
  id: string;
  new?: boolean;
  properties: Record<string, string | null>;
}

export interface HubSpotBatchReadResultItem {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotSearchResultItem {
  id: string;
  properties: Record<string, string | null>;
}

export class HubSpotHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly category?: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "HubSpotHttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split an array into chunks of at most `size` items each. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class HubSpotClient {
  constructor(
    private readonly accessToken: string,
    private readonly baseUrl = "https://api.hubapi.com",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxRetries = 5,
  ) {}

  static fromEnv(): HubSpotClient {
    return new HubSpotClient(
      env("HUBSPOT_ACCESS_TOKEN", true)!,
      env("HUBSPOT_API_BASE_URL") ?? "https://api.hubapi.com",
    );
  }

  /**
   * Authenticated request with automatic retry on 429 (rate limit) and 5xx
   * (transient server error) responses. Honors `Retry-After` when present,
   * else backs off exponentially (500ms, 1s, 2s, 4s, 8s, capped).
   */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = response.headers.get("Retry-After");
        const delayMs = retryAfter ? Number(retryAfter) * 1000 : Math.min(2 ** attempt * 500, 8000);
        await sleep(Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 500);
        attempt++;
        continue;
      }

      if (response.status === 204) return undefined;
      const text = await response.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        payload = text;
      }
      if (!response.ok) {
        const details = payload as
          { message?: string; category?: string; correlationId?: string } | undefined;
        const message =
          details && typeof details === "object"
            ? [
                details.category,
                details.message,
                details.correlationId && `correlationId=${details.correlationId}`,
              ]
                .filter(Boolean)
                .join(": ")
            : text.slice(0, 500);
        throw new HubSpotHttpError(
          response.status,
          `HubSpot ${method} ${path} failed: ${message || response.statusText}`,
          details?.category,
          details?.correlationId,
        );
      }
      return payload as T;
    }
  }

  /** Account-level metadata (portal id + UI domain), used only to print a destination link. */
  async accountInfo(): Promise<HubSpotAccountInfo | undefined> {
    return await this.request<HubSpotAccountInfo>("GET", "/account-info/v3/details");
  }

  async ensureProperty(
    objectType: HubSpotObjectType,
    spec: HubSpotPropertySpec,
  ): Promise<"created" | "existing"> {
    const path = `/crm/properties/${HUBSPOT_API_VERSION}/${objectType}/${encodeURIComponent(spec.name)}`;
    try {
      const existing = await this.request<{ hasUniqueValue?: boolean }>("GET", path);
      if (spec.hasUniqueValue && existing?.hasUniqueValue !== true) {
        throw new Error(
          `HubSpot property ${objectType}.${spec.name} exists but is not unique; delete it and rerun hubspot:setup`,
        );
      }
      return "existing";
    } catch (error) {
      if (!(error instanceof HubSpotHttpError) || error.status !== 404) throw error;
    }
    await this.request("POST", `/crm/properties/${HUBSPOT_API_VERSION}/${objectType}`, spec);
    return "created";
  }

  /**
   * Idempotently create or update a single CRM record using a custom unique
   * property. Prefer `batchUpsert` for more than a handful of records.
   */
  async upsert(
    objectType: HubSpotObjectType,
    uniqueProperty: string,
    uniqueValue: string,
    properties: Record<string, string>,
  ): Promise<{ id: string; created: boolean }> {
    const objectPath = `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}/${encodeURIComponent(uniqueValue)}?idProperty=${encodeURIComponent(uniqueProperty)}`;
    try {
      const existing = await this.request<HubSpotObject>("GET", objectPath);
      const updated = await this.request<HubSpotObject>("PATCH", objectPath, { properties });
      return { id: updated?.id ?? existing!.id, created: false };
    } catch (error) {
      if (!(error instanceof HubSpotHttpError) || error.status !== 404) throw error;
    }

    const created = await this.request<HubSpotObject>(
      "POST",
      `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}`,
      {
        properties: { ...properties, [uniqueProperty]: uniqueValue },
      },
    );
    if (!created?.id) throw new Error(`HubSpot created ${objectType} without returning an id`);
    return { id: created.id, created: true };
  }

  async associate(
    fromType: HubSpotSingularObjectType,
    fromId: string,
    toType: HubSpotSingularObjectType,
    toId: string,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/crm/objects/${HUBSPOT_API_VERSION}/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`,
    );
  }

  async dealPipelines(): Promise<HubSpotPipeline[]> {
    const response = await this.request<{ results: HubSpotPipeline[] }>(
      "GET",
      `/crm/pipelines/${HUBSPOT_API_VERSION}/deals`,
    );
    return response?.results ?? [];
  }

  /**
   * Batch create-or-update records by a custom unique property, chunked to the
   * API's 100-input limit. The unique property's value is always mirrored into
   * `properties` too (in addition to `id`/`idProperty`) so the response can be
   * matched back to the source record reliably (batch responses do not
   * otherwise echo the identifying value).
   */
  async batchUpsert(
    objectType: HubSpotObjectType,
    uniqueProperty: string,
    records: { id: string; properties: Record<string, string> }[],
  ): Promise<HubSpotBatchResult<HubSpotBatchUpsertResultItem>> {
    const merged: HubSpotBatchResult<HubSpotBatchUpsertResultItem> = {
      results: [],
      errors: [],
      numErrors: 0,
    };
    for (const batch of chunk(records, BATCH_CHUNK_SIZE)) {
      const inputs = batch.map((record) => ({
        id: record.id,
        idProperty: uniqueProperty,
        properties: { ...record.properties, [uniqueProperty]: record.id },
      }));
      const response = await this.request<{
        results?: HubSpotBatchUpsertResultItem[];
        errors?: HubSpotBatchErrorDetail[];
        numErrors?: number;
      }>("POST", `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}/batch/upsert`, { inputs });
      merged.results.push(...(response?.results ?? []));
      merged.errors.push(...(response?.errors ?? []));
      merged.numErrors += response?.numErrors ?? 0;
    }
    return merged;
  }

  /** Batch-read records by a custom unique property (or internal id if `idProperty` is omitted). */
  async batchRead(
    objectType: HubSpotObjectType,
    ids: string[],
    properties: string[],
    idProperty?: string,
  ): Promise<HubSpotBatchResult<HubSpotBatchReadResultItem>> {
    const merged: HubSpotBatchResult<HubSpotBatchReadResultItem> = { results: [], errors: [], numErrors: 0 };
    for (const batch of chunk(ids, BATCH_CHUNK_SIZE)) {
      const body: Record<string, unknown> = { inputs: batch.map((id) => ({ id })), properties };
      if (idProperty) body.idProperty = idProperty;
      const response = await this.request<{
        results?: HubSpotBatchReadResultItem[];
        errors?: HubSpotBatchErrorDetail[];
        numErrors?: number;
      }>("POST", `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}/batch/read`, body);
      merged.results.push(...(response?.results ?? []));
      merged.errors.push(...(response?.errors ?? []));
      merged.numErrors += response?.numErrors ?? 0;
    }
    return merged;
  }

  /** Batch-create default (unlabeled) associations between two object types. */
  async batchAssociateDefault(
    fromType: HubSpotObjectType,
    toType: HubSpotObjectType,
    pairs: { fromId: string; toId: string }[],
  ): Promise<HubSpotBatchResult<{ from: { id: string }; to: { id: string } }>> {
    const merged: HubSpotBatchResult<{ from: { id: string }; to: { id: string } }> = {
      results: [],
      errors: [],
      numErrors: 0,
    };
    for (const batch of chunk(pairs, BATCH_CHUNK_SIZE)) {
      const inputs = batch.map((pair) => ({ from: { id: pair.fromId }, to: { id: pair.toId } }));
      const response = await this.request<{
        results?: { from: { id: string }; to: { id: string } }[];
        errors?: HubSpotBatchErrorDetail[];
        numErrors?: number;
      }>("POST", `/crm/associations/${HUBSPOT_API_VERSION}/${fromType}/${toType}/batch/associate/default`, {
        inputs,
      });
      merged.results.push(...(response?.results ?? []));
      merged.errors.push(...(response?.errors ?? []));
      merged.numErrors += response?.numErrors ?? 0;
    }
    return merged;
  }

  /** Read one record's properties plus its associated record ids for the given object types. */
  async getWithAssociations(
    objectType: HubSpotObjectType,
    id: string,
    toObjectTypes: HubSpotObjectType[],
  ): Promise<HubSpotObjectWithAssociations | undefined> {
    const associations = toObjectTypes.join(",");
    return await this.request<HubSpotObjectWithAssociations>(
      "GET",
      `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}/${encodeURIComponent(id)}?associations=${encodeURIComponent(associations)}`,
    );
  }

  /** Paginated search for every record that has a non-empty value for `propertyName`. */
  async searchByHasProperty(
    objectType: HubSpotObjectType,
    propertyName: string,
    properties: string[],
  ): Promise<HubSpotSearchResultItem[]> {
    const results: HubSpotSearchResultItem[] = [];
    let after: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        filterGroups: [{ filters: [{ propertyName, operator: "HAS_PROPERTY" }] }],
        properties,
        limit: 100,
      };
      if (after) body.after = after;
      const response = await this.request<{
        results: HubSpotSearchResultItem[];
        paging?: { next?: { after?: string } };
      }>("POST", `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}/search`, body);
      results.push(...(response?.results ?? []));
      after = response?.paging?.next?.after;
      if (!after) break;
    }
    return results;
  }

  /** Batch-archive (move to recycling bin) records by internal id, chunked to the API limit. */
  async batchArchive(objectType: HubSpotObjectType, ids: string[]): Promise<void> {
    for (const batch of chunk(ids, BATCH_CHUNK_SIZE)) {
      await this.request("POST", `/crm/objects/${HUBSPOT_API_VERSION}/${objectType}/batch/archive`, {
        inputs: batch.map((id) => ({ id })),
      });
    }
  }
}

/** Flatten a batch error response into readable, best-effort per-record messages. */
export function flattenBatchErrors(
  errors: HubSpotBatchErrorDetail[],
  batch: { id: string }[],
): { entity: string; message: string }[] {
  const out: { entity: string; message: string }[] = [];
  for (const error of errors) {
    const inner = error.errors;
    if (inner && inner.length > 0) {
      for (const detail of inner) {
        const match = detail.in?.match(/inputs\[(\d+)\]/);
        const index = match ? Number(match[1]) : undefined;
        const entity = index !== undefined ? (batch[index]?.id ?? "batch") : "batch";
        out.push({ entity, message: `${error.category ?? "ERROR"}: ${detail.message ?? error.message}` });
      }
    } else {
      out.push({ entity: "batch", message: `${error.category ?? "ERROR"}: ${error.message}` });
    }
  }
  return out;
}
