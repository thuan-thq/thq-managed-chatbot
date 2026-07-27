/**
 * Monday.com Data Source Adapter.
 *
 * Implements the DataSourceAdapter interface for Monday.com GraphQL API.
 * Handles authentication, pagination, content transformation, and
 * change detection via Monday.com's updated_at field.
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

/** Configuration for the Monday.com adapter. */
export interface MondayAdapterConfig {
  /** Base URL of the Monday.com API (default: "https://api.monday.com/v2"). */
  baseUrl: string;
  /** Monday.com API token for authentication. */
  apiToken: string;
  /** The Monday.com board ID to sync. */
  boardId: string;
  /** Content type for transformed records (default: "text/plain"). */
  contentType?: string;
}

/** Monday.com column value shape from GraphQL response. */
interface MondayColumnValue {
  id: string;
  text: string;
  value: string | null;
}

/** Monday.com item shape from GraphQL response. */
interface MondayItem {
  id: string;
  name: string;
  updated_at: string;
  column_values: MondayColumnValue[];
}

/** Monday.com items_page response shape. */
interface MondayItemsPage {
  cursor: string | null;
  items: MondayItem[];
}

/** Monday.com boards query response shape. */
interface MondayBoardsResponse {
  data: {
    boards: Array<{
      items_page: MondayItemsPage;
    }>;
  };
  errors?: Array<{ message: string }>;
}

/** Monday.com items query response shape. */
interface MondayItemsResponse {
  data: {
    items: MondayItem[];
  };
  errors?: Array<{ message: string }>;
}

/** Result from list operations including errors for skipped records. */
export interface MondayListResult {
  items: ContentRecord[];
  errors: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RECORD_ID_LENGTH = 256;
const MAX_CONTENT_BODY_SIZE = 1_048_576; // 1MB
const DEFAULT_CONTENT_TYPE = "text/plain";
const DEFAULT_BASE_URL = "https://api.monday.com/v2";

// ─── Monday.com Adapter ──────────────────────────────────────────────────────

/**
 * Data source adapter for Monday.com GraphQL API.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class MondayAdapter implements DataSourceAdapter {
  private readonly config: Required<MondayAdapterConfig>;
  private readonly httpClient: RetryHttpClient;

  constructor(config: MondayAdapterConfig, httpClient?: RetryHttpClient) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
      contentType: config.contentType ?? DEFAULT_CONTENT_TYPE,
    };
    this.httpClient = httpClient ?? new RetryHttpClient();
  }

  /**
   * Lists content records from Monday.com with cursor-based pagination.
   *
   * The external cursor is base64-encoded. Internally it maps to
   * Monday.com's native cursor for items_page pagination.
   *
   * Validates: Requirements 5.1, 5.4, 5.5
   */
  async listContent(
    pagination: PaginationParams,
  ): Promise<PagedResult<ContentRecord>> {
    const pageSize = this.clampPageSize(pagination.pageSize);
    const mondayCursor = pagination.cursor
      ? this.decodeCursor(pagination.cursor)
      : null;

    const query = this.buildListQuery(pageSize, mondayCursor);
    const response = await this.executeGraphQL(query);

    if (response.status !== 200) {
      throw new Error(
        `Monday.com API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as MondayBoardsResponse;

    if (body.errors && body.errors.length > 0) {
      throw new Error(`Monday.com GraphQL error: ${body.errors[0].message}`);
    }

    const board = body.data?.boards?.[0];
    if (!board) {
      return { items: [], nextCursor: undefined };
    }

    const itemsPage = board.items_page;
    const { items, errors } = this.transformItems(itemsPage.items);

    const nextCursor = itemsPage.cursor
      ? this.encodeCursor(itemsPage.cursor)
      : undefined;

    return {
      items,
      nextCursor,
      errors,
    } as PagedResult<ContentRecord> & { errors: string[] };
  }

  /**
   * Fetches a single content record by its Monday.com item ID.
   *
   * Validates: Requirement 5.1
   */
  async fetchById(recordId: string): Promise<ContentRecord | null> {
    const query = this.buildFetchByIdQuery(recordId);
    const response = await this.executeGraphQL(query);

    if (response.status !== 200) {
      throw new Error(
        `Monday.com API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as MondayItemsResponse;

    if (body.errors && body.errors.length > 0) {
      throw new Error(`Monday.com GraphQL error: ${body.errors[0].message}`);
    }

    const item = body.data?.items?.[0];
    if (!item) {
      return null;
    }

    return this.transformItem(item);
  }

  /**
   * Detects changes since a given checkpoint (ISO 8601 timestamp).
   *
   * Fetches all items from the board and compares updated_at against
   * the checkpoint. An empty string checkpoint fetches all records as "created".
   *
   * Validates: Requirements 5.2, 5.5
   */
  async detectChanges(since: string): Promise<ChangeSet> {
    const created: ContentRecord[] = [];
    const updated: ContentRecord[] = [];
    const errors: string[] = [];

    const isInitial = !since;
    const pageSize = 100;
    let mondayCursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const query = this.buildListQuery(pageSize, mondayCursor);
      const response = await this.executeGraphQL(query);

      if (response.status !== 200) {
        throw new Error(
          `Monday.com API returned status ${response.status}: ${response.body.substring(0, 200)}`,
        );
      }

      const body = JSON.parse(response.body) as MondayBoardsResponse;

      if (body.errors && body.errors.length > 0) {
        throw new Error(`Monday.com GraphQL error: ${body.errors[0].message}`);
      }

      const board = body.data?.boards?.[0];
      if (!board) {
        break;
      }

      const itemsPage = board.items_page;
      const result = this.transformItems(itemsPage.items);
      errors.push(...result.errors);

      for (const record of result.items) {
        if (isInitial) {
          created.push(record);
        } else if (this.isUpdatedAfter(record.lastModified, since)) {
          updated.push(record);
        }
      }

      mondayCursor = itemsPage.cursor;
      hasMore = mondayCursor !== null;
    }

    // Generate checkpoint as the current ISO timestamp
    const checkpoint = new Date().toISOString();

    return {
      created,
      updated,
      deleted: [], // Monday.com GraphQL API does not expose deleted items
      checkpoint,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /** Executes a GraphQL query against the Monday.com API. */
  private async executeGraphQL(query: string) {
    const options: HttpRequestOptions = {
      method: "POST",
      headers: {
        Authorization: this.config.apiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    };

    return this.httpClient.request(this.config.baseUrl, options);
  }

  /** Builds the GraphQL query for listing items with pagination. */
  private buildListQuery(pageSize: number, cursor: string | null): string {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : "";
    return `query {
  boards(ids: [${this.config.boardId}]) {
    items_page(limit: ${pageSize}${cursorArg}) {
      cursor
      items {
        id
        name
        updated_at
        column_values {
          id
          text
          value
        }
      }
    }
  }
}`;
  }

  /** Builds the GraphQL query for fetching a single item by ID. */
  private buildFetchByIdQuery(itemId: string): string {
    return `query {
  items(ids: [${itemId}]) {
    id
    name
    updated_at
    column_values {
      id
      text
      value
    }
  }
}`;
  }

  /** Transforms an array of Monday.com items, skipping invalid ones. */
  private transformItems(items: MondayItem[]): MondayListResult {
    const validItems: ContentRecord[] = [];
    const errors: string[] = [];

    for (const item of items) {
      const record = this.transformItem(item);
      if (record) {
        validItems.push(record);
      } else {
        errors.push(item.id ?? "unknown");
      }
    }

    return { items: validItems, errors };
  }

  /**
   * Transforms a single Monday.com item to a ContentRecord.
   * Returns null if the item cannot produce a valid ContentRecord.
   *
   * Validates: Requirement 5.5
   */
  private transformItem(item: MondayItem): ContentRecord | null {
    if (!item.id) return null;

    const recordId = String(item.id);
    if (recordId.length === 0 || recordId.length > MAX_RECORD_ID_LENGTH) {
      return null;
    }

    const contentBody = this.composeContentBody(item);
    if (!contentBody || contentBody.length > MAX_CONTENT_BODY_SIZE) {
      return null;
    }

    const lastModified = item.updated_at;
    if (!lastModified || !this.isValidISO8601(lastModified)) {
      return null;
    }

    const metadata: Record<string, string> = {
      source: "monday",
      boardId: this.config.boardId,
      name: item.name ?? "",
      recordId,
    };

    return {
      recordId,
      contentBody,
      contentType: this.config.contentType,
      metadata,
      lastModified,
    };
  }

  /**
   * Composes content body from item name and column values.
   * Joins item name with all non-empty column text values using newlines.
   */
  private composeContentBody(item: MondayItem): string | null {
    const parts: string[] = [];

    if (item.name && item.name.length > 0) {
      parts.push(item.name);
    }

    if (item.column_values && Array.isArray(item.column_values)) {
      for (const col of item.column_values) {
        if (col.text && col.text.length > 0) {
          parts.push(col.text);
        }
      }
    }

    if (parts.length === 0) {
      return null;
    }

    return parts.join("\n");
  }

  /** Determines if a record's lastModified is after the checkpoint. */
  private isUpdatedAfter(lastModified: string, since: string): boolean {
    return new Date(lastModified).getTime() > new Date(since).getTime();
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

  /** Encodes a Monday.com cursor as a base64 string for the external interface. */
  private encodeCursor(mondayCursor: string): string {
    return Buffer.from(mondayCursor).toString("base64");
  }

  /** Decodes a base64 external cursor back to Monday.com's native cursor. Returns null on invalid input. */
  private decodeCursor(cursor: string): string | null {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf-8");
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
}
