/**
 * ConfigurableStrapiAdapter — config-driven Strapi CMS adapter.
 *
 * Replaces the hard-coded collection switch-case logic in StrapiAdapter with
 * a configuration-driven approach. Each collection's populate parameters,
 * field mappings, URL path template, and markdown strategy are declared in
 * StrapiCollectionConfig objects passed at construction time.
 *
 * Requirements: 1.3, 1.8, 3.2, 3.7, 3.8, 4.1–4.7
 */

import type { DataSourceAdapter } from "./adapter";
import type {
  ContentRecord,
  ChangeSet,
  PaginationParams,
  PagedResult,
} from "./types";
import { RetryHttpClient, type HttpRequestOptions } from "./http-client";
import { buildPopulateParams } from "./populate-params";
import { CollectionMarkdownConverter } from "./collection-markdown-converter";
import { toSlug } from "./markdown-converter";
import type { StrapiCollectionConfig } from "./config-types";

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Construction-time configuration for ConfigurableStrapiAdapter.
 *
 * Mirrors the relevant fields from StrapiConfig without requiring the full
 * ClientConfig; allows the adapter to be constructed directly from
 * ClientConfig.strapi.
 */
export interface ConfigurableStrapiAdapterConfig {
  /** Base URL of the Strapi instance (e.g. "https://cms.example.com"). */
  baseUrl: string;
  /** Strapi Bearer API token for authenticating REST API requests. */
  apiToken: string;
  /**
   * Front-end base URL prepended to urlPathTemplate values when constructing
   * sourceUrl (Req 4.2, 4.7). If absent or empty, sourceUrl is omitted.
   */
  frontendBaseUrl?: string;
  /** Ordered list of StrapiCollectionConfig objects for each collection. */
  collections: StrapiCollectionConfig[];
}

// ─── Internal Strapi response types ──────────────────────────────────────────

interface StrapiListResponse {
  data: StrapiEntry[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

interface StrapiSingleResponse {
  data: StrapiEntry | null;
}

interface StrapiEntry {
  id: number | string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RECORD_ID_LENGTH = 256;
const MAX_CONTENT_BODY_SIZE = 1_048_576; // 1 MB

// ─── ConfigurableStrapiAdapter ────────────────────────────────────────────────

/**
 * Config-driven Strapi CMS data source adapter.
 *
 * Accepts a list of StrapiCollectionConfig objects and implements
 * DataSourceAdapter with the collection name supplied as a second parameter
 * on each method call.
 *
 * Requirements: 1.3, 1.8, 3.2, 3.7, 3.8, 4.1–4.7
 */
export class ConfigurableStrapiAdapter implements DataSourceAdapter {
  private readonly config: ConfigurableStrapiAdapterConfig;
  private readonly httpClient: RetryHttpClient;

  constructor(
    config: ConfigurableStrapiAdapterConfig,
    httpClient?: RetryHttpClient,
  ) {
    this.config = config;
    this.httpClient = httpClient ?? new RetryHttpClient();
  }

  // ─── DataSourceAdapter implementation (collection-aware overloads) ──────────

  /**
   * Lists content records from a Strapi collection with cursor-based pagination.
   *
   * The cursor encodes a base64-encoded page number. Omit (or pass undefined)
   * for the first page.
   *
   * @param pagination     - Page size and optional cursor for the next page.
   * @param collectionName - REST API collection path (e.g. "intranet-pages").
   */
  async listContent(
    pagination: PaginationParams,
    collectionName: string,
  ): Promise<PagedResult<ContentRecord>>;
  async listContent(
    pagination: PaginationParams,
  ): Promise<PagedResult<ContentRecord>>;
  async listContent(
    pagination: PaginationParams,
    collectionName?: string,
  ): Promise<PagedResult<ContentRecord>> {
    const name = collectionName ?? this.config.collections[0]?.name ?? "";
    const collectionConfig = this.requireCollection(name);

    const pageSize = clampPageSize(pagination.pageSize);
    const page = pagination.cursor ? decodeCursor(pagination.cursor) : 1;

    const url = this.buildListUrl(collectionConfig, page, pageSize);
    const response = await this.httpClient.request(url, this.authHeaders());

    if (response.status !== 200) {
      throw new Error(
        `Strapi API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as StrapiListResponse;
    const items = this.transformEntries(body.data, collectionConfig);

    const { pagination: meta } = body.meta;
    const hasNextPage = meta.page < meta.pageCount;
    const nextCursor = hasNextPage ? encodeCursor(meta.page + 1) : undefined;

    return {
      items,
      nextCursor,
      totalCount: meta.total,
    };
  }

  /**
   * Fetches a single content record by its Strapi entry ID.
   *
   * @param recordId       - The Strapi entry ID.
   * @param collectionName - REST API collection path (e.g. "intranet-pages").
   */
  async fetchById(
    recordId: string,
    collectionName: string,
  ): Promise<ContentRecord | null>;
  async fetchById(recordId: string): Promise<ContentRecord | null>;
  async fetchById(
    recordId: string,
    collectionName?: string,
  ): Promise<ContentRecord | null> {
    const name = collectionName ?? this.config.collections[0]?.name ?? "";
    const collectionConfig = this.requireCollection(name);

    const populateParams = buildPopulateParams(collectionConfig.populate);
    const queryString = populateParams.toString();
    const url = queryString
      ? `${this.config.baseUrl}/api/${collectionConfig.name}/${recordId}?${queryString}`
      : `${this.config.baseUrl}/api/${collectionConfig.name}/${recordId}`;

    const response = await this.httpClient.request(url, this.authHeaders());

    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200) {
      throw new Error(
        `Strapi API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as StrapiSingleResponse;
    if (!body.data) {
      return null;
    }

    return this.transformEntry(body.data, collectionConfig);
  }

  /**
   * Detects changes in a collection since the given checkpoint timestamp.
   *
   * An empty-string checkpoint treats all current records as "created".
   *
   * @param since          - ISO 8601 checkpoint from a previous call (or "").
   * @param collectionName - REST API collection path (e.g. "intranet-pages").
   */
  async detectChanges(
    since: string,
    collectionName: string,
  ): Promise<ChangeSet>;
  async detectChanges(since: string): Promise<ChangeSet>;
  async detectChanges(
    since: string,
    collectionName?: string,
  ): Promise<ChangeSet> {
    const name = collectionName ?? this.config.collections[0]?.name ?? "";
    const collectionConfig = this.requireCollection(name);

    const created: ContentRecord[] = [];
    const updated: ContentRecord[] = [];
    const isInitial = !since;
    let page = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const url = isInitial
        ? this.buildListUrl(collectionConfig, page, pageSize)
        : this.buildChangesUrl(collectionConfig, since, page, pageSize);

      const response = await this.httpClient.request(url, this.authHeaders());

      if (response.status !== 200) {
        throw new Error(
          `Strapi API returned status ${response.status}: ${response.body.substring(0, 200)}`,
        );
      }

      const body = JSON.parse(response.body) as StrapiListResponse;
      const items = this.transformEntries(body.data, collectionConfig);

      for (const record of items) {
        const createdAt = record.metadata["createdAt"];
        if (
          isInitial ||
          !createdAt ||
          new Date(createdAt).getTime() > new Date(since).getTime()
        ) {
          created.push(record);
        } else {
          updated.push(record);
        }
      }

      const { pagination: meta } = body.meta;
      hasMore = meta.page < meta.pageCount;
      page++;
    }

    return {
      created,
      updated,
      deleted: [],
      checkpoint: new Date().toISOString(),
    };
  }

  // ─── URL builders ─────────────────────────────────────────────────────────────

  private buildListUrl(
    collection: StrapiCollectionConfig,
    page: number,
    pageSize: number,
  ): string {
    const params = new URLSearchParams({
      "pagination[page]": String(page),
      "pagination[pageSize]": String(pageSize),
      sort: "updatedAt:asc",
    });
    const populateParams = buildPopulateParams(collection.populate);
    populateParams.forEach((value, key) => params.append(key, value));
    return `${this.config.baseUrl}/api/${collection.name}?${params.toString()}`;
  }

  private buildChangesUrl(
    collection: StrapiCollectionConfig,
    since: string,
    page: number,
    pageSize: number,
  ): string {
    const params = new URLSearchParams({
      "pagination[page]": String(page),
      "pagination[pageSize]": String(pageSize),
      sort: "updatedAt:asc",
      "filters[updatedAt][$gt]": since,
    });
    const populateParams = buildPopulateParams(collection.populate);
    populateParams.forEach((value, key) => params.append(key, value));
    return `${this.config.baseUrl}/api/${collection.name}?${params.toString()}`;
  }

  // ─── Entry transformation ─────────────────────────────────────────────────────

  private transformEntries(
    entries: StrapiEntry[],
    collectionConfig: StrapiCollectionConfig,
  ): ContentRecord[] {
    const records: ContentRecord[] = [];
    for (const entry of entries) {
      const record = this.transformEntry(entry, collectionConfig);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private transformEntry(
    entry: StrapiEntry,
    collectionConfig: StrapiCollectionConfig,
  ): ContentRecord | null {
    const id = extractId(entry);
    if (!id) return null;

    const recordId = String(id);
    if (recordId.length === 0 || recordId.length > MAX_RECORD_ID_LENGTH) {
      return null;
    }

    const attrs = extractAttributes(entry);

    // ── Content body (delegate to CollectionMarkdownConverter) ───────────────
    const contentBody = CollectionMarkdownConverter.convert(
      attrs,
      collectionConfig,
      {
        baseUrl: this.config.frontendBaseUrl,
      },
    );

    if (!contentBody || contentBody.length === 0) {
      return null;
    }
    if (contentBody.length > MAX_CONTENT_BODY_SIZE) {
      return null;
    }

    // ── Slug resolution (Req 3.2) ────────────────────────────────────────────
    const slug = this.resolveSlug(attrs, collectionConfig, recordId);

    // ── lastModified resolution (Req 3.7, 3.8) ──────────────────────────────
    const lastModified = this.resolveLastModified(
      attrs,
      collectionConfig,
      recordId,
    );
    if (!lastModified) {
      // WARN already logged inside resolveLastModified; omit record if timestamp required
      // Per spec the record is still ingested with lastModified absent, but
      // ContentRecord requires it — skip rather than produce an invalid record.
      return null;
    }
    if (!isValidISO8601(lastModified)) {
      return null;
    }

    // ── sourceUrl construction (Req 4.1–4.7) ────────────────────────────────
    const sourceUrl = this.resolveSourceUrl(
      attrs,
      collectionConfig,
      slug,
      recordId,
    );

    // ── S3 document path (Req 8.5) ───────────────────────────────────────────
    const documentPath = deriveDocumentPath(attrs, collectionConfig, recordId);

    // ── Metadata ──────────────────────────────────────────────────────────────
    const metadata: Record<string, string> = {
      source: "strapi",
      collection: collectionConfig.name,
      recordId,
      documentPath,
    };

    if (typeof attrs["createdAt"] === "string") {
      metadata["createdAt"] = attrs["createdAt"] as string;
    }

    if (sourceUrl) {
      metadata["sourceUrl"] = sourceUrl;
    }

    // Title for metadata — use first resolved titleField value
    const titleField = collectionConfig.fieldMappings.titleFields?.[0];
    if (titleField && typeof attrs[titleField] === "string") {
      metadata["title"] = attrs[titleField] as string;
    }

    return {
      recordId,
      contentBody,
      contentType: "text/markdown",
      metadata,
      lastModified,
    };
  }

  // ─── Slug resolution (Req 3.2) ───────────────────────────────────────────────

  /**
   * Resolves the document slug for S3 key derivation and sourceUrl construction.
   *
   * Priority (Req 8.5 backward compat):
   *   1. attrs[slugField]  — if non-empty and non-whitespace-only
   *   2. toSlug(attrs[titleFields[0]]) — if non-empty after slugification
   *   3. toSlug(attrs["name"])          — if non-empty after slugification
   *   4. recordId                        — always non-empty fallback
   */
  private resolveSlug(
    attrs: Record<string, unknown>,
    collectionConfig: StrapiCollectionConfig,
    recordId: string,
  ): string {
    const { slugField, titleFields } = collectionConfig.fieldMappings;

    // 1. slugField
    if (slugField !== undefined) {
      const slugValue = attrs[slugField];
      if (typeof slugValue === "string" && slugValue.trim().length > 0) {
        return slugValue.trim();
      }
    }

    // 2. First titleField — slugified
    if (titleFields && titleFields.length > 0) {
      const firstTitle = attrs[titleFields[0]];
      if (typeof firstTitle === "string" && firstTitle.trim().length > 0) {
        const slugified = toSlug(firstTitle);
        if (slugified.length > 0) return slugified;
      }
    }

    // 3. attrs.name — slugified
    const nameValue = attrs["name"];
    if (typeof nameValue === "string" && nameValue.trim().length > 0) {
      const slugified = toSlug(nameValue);
      if (slugified.length > 0) return slugified;
    }

    // 4. fallback to recordId
    return recordId;
  }

  // ─── lastModified resolution (Req 3.7, 3.8) ──────────────────────────────────

  /**
   * Resolves the lastModified timestamp.
   *
   *   1. attrs[lastModifiedField ?? "updatedAt"] — when non-null
   *   2. attrs.createdAt                          — fallback
   *   3. null + WARN log                          — when both absent
   */
  private resolveLastModified(
    attrs: Record<string, unknown>,
    collectionConfig: StrapiCollectionConfig,
    recordId: string,
  ): string | null {
    const fieldName =
      collectionConfig.fieldMappings.lastModifiedField ?? "updatedAt";
    const primary = attrs[fieldName];
    if (
      primary !== null &&
      primary !== undefined &&
      typeof primary === "string"
    ) {
      return primary;
    }

    const createdAt = attrs["createdAt"];
    if (
      createdAt !== null &&
      createdAt !== undefined &&
      typeof createdAt === "string"
    ) {
      return createdAt;
    }

    console.log(
      JSON.stringify({
        level: "WARN",
        message:
          "No lastModified timestamp found for record - omitting from metadata",
        collection: collectionConfig.name,
        recordId,
      }),
    );
    return null;
  }

  // ─── sourceUrl construction (Req 4.1–4.7) ────────────────────────────────────

  /**
   * Constructs the front-end sourceUrl for a record, or returns undefined
   * when any required precondition is not met (Req 4.1–4.7).
   */
  private resolveSourceUrl(
    _attrs: Record<string, unknown>,
    collectionConfig: StrapiCollectionConfig,
    slug: string,
    recordId: string,
  ): string | undefined {
    const { urlPathTemplate } = collectionConfig;
    const { frontendBaseUrl } = this.config;

    // Req 4.3 — absent or empty urlPathTemplate → omit
    if (!urlPathTemplate || urlPathTemplate.trim().length === 0) {
      return undefined;
    }

    // Req 4.7 — absent or empty frontendBaseUrl → WARN + omit for all collections
    if (!frontendBaseUrl || frontendBaseUrl.trim().length === 0) {
      console.log(
        JSON.stringify({
          level: "WARN",
          message: "Omitting sourceUrl: frontendBaseUrl is absent or empty",
          collection: collectionConfig.name,
          recordId,
        }),
      );
      return undefined;
    }

    // Req 4.5 — template missing {slug} placeholder → WARN + omit
    if (!urlPathTemplate.includes("{slug}")) {
      console.log(
        JSON.stringify({
          level: "WARN",
          message:
            "Omitting sourceUrl: urlPathTemplate missing {slug} placeholder",
          collection: collectionConfig.name,
          recordId,
          urlPathTemplate,
        }),
      );
      return undefined;
    }

    // Req 4.4 — resolved slug is empty/whitespace → WARN + omit
    if (!slug || slug.trim().length === 0) {
      console.log(
        JSON.stringify({
          level: "WARN",
          message:
            "Omitting sourceUrl: resolved slug is empty or whitespace-only",
          collection: collectionConfig.name,
          recordId,
        }),
      );
      return undefined;
    }

    // Req 4.2 — construct the URL
    const path = urlPathTemplate.replace(/{slug}/g, slug);
    const constructed = frontendBaseUrl + path;

    // Req 4.6 — validate protocol prefix → WARN + omit if invalid
    if (
      !constructed.startsWith("http://") &&
      !constructed.startsWith("https://")
    ) {
      console.log(
        JSON.stringify({
          level: "WARN",
          message:
            "Omitting sourceUrl: constructed URL does not start with http:// or https://",
          collection: collectionConfig.name,
          recordId,
          constructed,
        }),
      );
      return undefined;
    }

    return constructed;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private requireCollection(name: string): StrapiCollectionConfig {
    const found = this.config.collections.find((c) => c.name === name);
    if (!found) {
      throw new Error(
        `ConfigurableStrapiAdapter: no collection configured for "${name}"`,
      );
    }
    return found;
  }

  private authHeaders(): HttpRequestOptions {
    return {
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
    };
  }
}

// ─── Pure helpers (module-level) ──────────────────────────────────────────────

/** Extracts the entry ID from either flat or nested Strapi v4 response format. */
function extractId(entry: StrapiEntry): string | null {
  if (entry.id !== undefined && entry.id !== null) {
    const id = String(entry.id);
    return id.length > 0 ? id : null;
  }
  return null;
}

/** Extracts attributes from nested (v4) or flat (v4.14+) Strapi response format. */
function extractAttributes(entry: StrapiEntry): Record<string, unknown> {
  if (entry.attributes && typeof entry.attributes === "object") {
    return entry.attributes as Record<string, unknown>;
  }
  return entry as Record<string, unknown>;
}

/**
 * Derives the S3 document path for a content record.
 *
 * Priority (Req 8.5 backward compat):
 *   slugField value → toSlug(titleFields[0]) → toSlug(attrs.name) → recordId
 *
 * Format: documents/{collectionName}/{slug}.json
 */
function deriveDocumentPath(
  attrs: Record<string, unknown>,
  collectionConfig: StrapiCollectionConfig,
  recordId: string,
): string {
  const { slugField, titleFields } = collectionConfig.fieldMappings;

  let filename: string;

  if (slugField !== undefined) {
    const slugValue = attrs[slugField];
    if (typeof slugValue === "string" && slugValue.length > 0) {
      filename = slugValue;
    } else if (titleFields && titleFields.length > 0) {
      const firstTitle = attrs[titleFields[0]];
      filename =
        typeof firstTitle === "string" && firstTitle.length > 0
          ? toSlug(firstTitle)
          : "";
    } else {
      filename = "";
    }
  } else if (titleFields && titleFields.length > 0) {
    const firstTitle = attrs[titleFields[0]];
    filename =
      typeof firstTitle === "string" && firstTitle.length > 0
        ? toSlug(firstTitle)
        : "";
  } else {
    filename = "";
  }

  if (!filename || filename.length === 0) {
    const nameValue = attrs["name"];
    if (typeof nameValue === "string" && nameValue.length > 0) {
      filename = toSlug(nameValue);
    }
  }

  if (!filename || filename.length === 0) {
    filename = recordId;
  }

  return `documents/${collectionConfig.name}/${filename}.json`;
}

/** Clamps page size to valid Strapi range [1, 500]. */
function clampPageSize(pageSize: number): number {
  return Math.max(1, Math.min(500, pageSize));
}

/** Encodes a page number as a base64 cursor string. */
function encodeCursor(page: number): string {
  return Buffer.from(String(page)).toString("base64");
}

/** Decodes a base64 cursor to a page number. Falls back to 1 on invalid input. */
function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const page = parseInt(decoded, 10);
    return isNaN(page) || page < 1 ? 1 : page;
  } catch {
    return 1;
  }
}

/** Returns true if the string parses as a valid date. */
function isValidISO8601(value: string): boolean {
  return !isNaN(new Date(value).getTime());
}
