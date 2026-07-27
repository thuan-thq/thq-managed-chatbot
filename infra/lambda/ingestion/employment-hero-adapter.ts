/**
 * Employment Hero Data Source Adapter.
 *
 * Implements the DataSourceAdapter interface for Employment Hero REST API.
 * Handles authentication, pagination, content transformation, and
 * change detection via the updated_since filter.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { DataSourceAdapter } from "./adapter";
import {
  ContentRecord,
  ChangeSet,
  PaginationParams,
  PagedResult,
} from "./types";
import { RetryHttpClient, HttpRequestOptions } from "./http-client";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Configuration for the Employment Hero adapter. */
export interface EmploymentHeroAdapterConfig {
  /** Base URL of the Employment Hero API (e.g. "https://api.employmenthero.com/api/v1"). */
  baseUrl: string;
  /** API token for Bearer authentication. */
  apiToken: string;
  /** The organisation ID used in API path. */
  organisationId: string;
  /** Resource type to query: "policies" or "knowledge_articles" (default: "policies"). */
  resourceType?: string;
  /** Content type for transformed records (default: "text/html"). */
  contentType?: string;
}

/** Employment Hero list API response shape. */
interface EmploymentHeroListResponse {
  data: EmploymentHeroEntry[];
  meta: {
    current_page: number;
    total_pages: number;
    total_count: number;
    per_page: number;
  };
}

/** Employment Hero single entry API response shape. */
interface EmploymentHeroSingleResponse {
  data: EmploymentHeroEntry | null;
}

/** A single Employment Hero entry (policy or knowledge article). */
interface EmploymentHeroEntry {
  id?: string | number;
  name?: string;
  body?: string;
  updated_at?: string;
  created_at?: string;
  status?: string;
  category?: string;
  [key: string]: unknown;
}

/** Result from list operations including errors for skipped records. */
export interface EmploymentHeroListResult {
  items: ContentRecord[];
  errors: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RECORD_ID_LENGTH = 256;
const MAX_CONTENT_BODY_SIZE = 1_048_576; // 1MB
const DEFAULT_CONTENT_TYPE = "text/html";
const DEFAULT_RESOURCE_TYPE = "policies";

// ─── Employment Hero Adapter ─────────────────────────────────────────────────

/**
 * Data source adapter for Employment Hero REST API.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class EmploymentHeroAdapter implements DataSourceAdapter {
  private readonly config: Required<EmploymentHeroAdapterConfig>;
  private readonly httpClient: RetryHttpClient;

  constructor(
    config: EmploymentHeroAdapterConfig,
    httpClient?: RetryHttpClient,
  ) {
    this.config = {
      ...config,
      resourceType: config.resourceType ?? DEFAULT_RESOURCE_TYPE,
      contentType: config.contentType ?? DEFAULT_CONTENT_TYPE,
    };
    this.httpClient = httpClient ?? new RetryHttpClient();
  }

  /**
   * Lists content records from Employment Hero with cursor-based pagination.
   *
   * The cursor encodes a base64-encoded page number. Undefined cursor
   * starts from page 1.
   *
   * Validates: Requirements 5.1, 5.4, 5.5
   */
  async listContent(
    pagination: PaginationParams,
  ): Promise<PagedResult<ContentRecord>> {
    const pageSize = this.clampPageSize(pagination.pageSize);
    const page = pagination.cursor ? this.decodeCursor(pagination.cursor) : 1;

    const url = this.buildListUrl(page, pageSize);
    const response = await this.httpClient.request(url, this.authHeaders());

    if (response.status !== 200) {
      throw new Error(
        `Employment Hero API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as EmploymentHeroListResponse;
    const { items, errors } = this.transformEntries(body.data);

    const hasNextPage = body.meta.current_page < body.meta.total_pages;
    const nextCursor = hasNextPage
      ? this.encodeCursor(body.meta.current_page + 1)
      : undefined;

    return {
      items,
      nextCursor,
      totalCount: body.meta.total_count,
      errors,
    } as PagedResult<ContentRecord> & { errors: string[] };
  }

  /**
   * Fetches a single content record by its Employment Hero ID.
   *
   * Validates: Requirement 5.1
   */
  async fetchById(recordId: string): Promise<ContentRecord | null> {
    const url = `${this.config.baseUrl}/organisations/${this.config.organisationId}/${this.config.resourceType}/${recordId}`;
    const response = await this.httpClient.request(url, this.authHeaders());

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new Error(
        `Employment Hero API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as EmploymentHeroSingleResponse;
    if (!body.data) {
      return null;
    }

    const record = this.transformEntry(body.data);
    return record;
  }

  /**
   * Detects changes since a given checkpoint (ISO 8601 timestamp).
   *
   * Uses the updated_since query parameter to filter records modified
   * after the checkpoint. An empty string checkpoint fetches all records
   * as "created".
   *
   * Validates: Requirements 5.2, 5.5
   */
  async detectChanges(since: string): Promise<ChangeSet> {
    const created: ContentRecord[] = [];
    const updated: ContentRecord[] = [];
    const errors: string[] = [];

    // If no checkpoint, treat all records as created
    const isInitial = !since;
    let page = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const url = isInitial
        ? this.buildListUrl(page, pageSize)
        : this.buildChangesUrl(since, page, pageSize);

      const response = await this.httpClient.request(url, this.authHeaders());

      if (response.status !== 200) {
        throw new Error(
          `Employment Hero API returned status ${response.status}: ${response.body.substring(0, 200)}`,
        );
      }

      const body = JSON.parse(response.body) as EmploymentHeroListResponse;
      const result = this.transformEntries(body.data);
      errors.push(...result.errors);

      for (const record of result.items) {
        if (isInitial) {
          created.push(record);
        } else {
          updated.push(record);
        }
      }

      hasMore = body.meta.current_page < body.meta.total_pages;
      page++;
    }

    // Generate checkpoint as the current ISO timestamp
    const checkpoint = new Date().toISOString();

    return {
      created,
      updated,
      deleted: [], // Employment Hero API does not expose deleted records
      checkpoint,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /** Builds the URL for listing entries with pagination. */
  private buildListUrl(page: number, pageSize: number): string {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(pageSize),
    });
    return `${this.config.baseUrl}/organisations/${this.config.organisationId}/${this.config.resourceType}?${params.toString()}`;
  }

  /** Builds the URL for detecting changes since a timestamp. */
  private buildChangesUrl(
    since: string,
    page: number,
    pageSize: number,
  ): string {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(pageSize),
      updated_since: since,
    });
    return `${this.config.baseUrl}/organisations/${this.config.organisationId}/${this.config.resourceType}?${params.toString()}`;
  }

  /** Returns request options with Bearer token authentication. */
  private authHeaders(): HttpRequestOptions {
    return {
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
    };
  }

  /** Transforms an array of Employment Hero entries, skipping invalid ones. */
  private transformEntries(
    entries: EmploymentHeroEntry[],
  ): EmploymentHeroListResult {
    const items: ContentRecord[] = [];
    const errors: string[] = [];

    for (const entry of entries) {
      const record = this.transformEntry(entry);
      if (record) {
        items.push(record);
      } else {
        const id =
          entry.id !== undefined && entry.id !== null
            ? String(entry.id)
            : "unknown";
        errors.push(id);
      }
    }

    return { items, errors };
  }

  /**
   * Transforms a single Employment Hero entry to a ContentRecord.
   * Returns null if the entry cannot produce a valid ContentRecord.
   *
   * Validates: Requirement 5.5
   */
  private transformEntry(entry: EmploymentHeroEntry): ContentRecord | null {
    // Validate ID
    if (entry.id === undefined || entry.id === null) {
      return null;
    }
    const recordId = String(entry.id);
    if (recordId.length === 0 || recordId.length > MAX_RECORD_ID_LENGTH) {
      return null;
    }

    // Validate body content
    const contentBody = entry.body;
    if (
      !contentBody ||
      typeof contentBody !== "string" ||
      contentBody.length === 0
    ) {
      return null;
    }
    if (contentBody.length > MAX_CONTENT_BODY_SIZE) {
      return null;
    }

    // Validate lastModified
    const lastModified = entry.updated_at ?? entry.created_at;
    if (!lastModified || !this.isValidISO8601(lastModified)) {
      return null;
    }

    // Build metadata
    const metadata: Record<string, string> = {
      source: "employment-hero",
      organisationId: this.config.organisationId,
      recordId,
    };

    if (typeof entry.name === "string" && entry.name.length > 0) {
      metadata["name"] = entry.name;
    }
    if (typeof entry.category === "string" && entry.category.length > 0) {
      metadata["category"] = entry.category;
    }

    return {
      recordId,
      contentBody,
      contentType: this.config.contentType,
      metadata,
      lastModified,
    };
  }

  /** Validates an ISO 8601 timestamp string. */
  private isValidISO8601(value: string): boolean {
    const date = new Date(value);
    return !isNaN(date.getTime());
  }

  /** Clamps page size to valid range [1, 500]. */
  private clampPageSize(pageSize: number): number {
    return Math.max(1, Math.min(500, pageSize));
  }

  /** Encodes a page number as a base64 cursor. */
  private encodeCursor(page: number): string {
    return Buffer.from(String(page)).toString("base64");
  }

  /** Decodes a base64 cursor to a page number. Falls back to 1 on invalid input. */
  private decodeCursor(cursor: string): number {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf-8");
      const page = parseInt(decoded, 10);
      return isNaN(page) || page < 1 ? 1 : page;
    } catch {
      return 1;
    }
  }
}
