/**
 * Strapi CMS Data Source Adapter.
 *
 * Implements the DataSourceAdapter interface for Strapi v4 REST API.
 * Handles authentication, pagination, content transformation, and
 * change detection via Strapi's updatedAt field.
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
import { MarkdownConverter, toSlug } from "./markdown-converter";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Configuration for the Strapi adapter. */
export interface StrapiAdapterConfig {
  /** Base URL of the Strapi instance (e.g. "https://cms.example.com"). */
  baseUrl: string;
  /** Strapi API token for authentication. */
  apiToken: string;
  /** The content type collection to query (e.g. "articles"). */
  collection: string;
  /** Content type for transformed records (default: "text/html"). */
  contentType?: string;
  /** Front-end base URL for constructing source links in markdown (e.g. "https://staging.intranet.think-hq.com.au"). */
  frontendBaseUrl?: string;
}

/** Strapi v4 REST API response shape for list endpoints. */
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

/** Strapi v4 REST API response shape for single entry endpoints. */
interface StrapiSingleResponse {
  data: StrapiEntry | null;
}

/** A single Strapi content entry. */
interface StrapiEntry {
  id: number | string;
  attributes?: Record<string, unknown>;
  // Strapi v4.14+ flat response format (no attributes wrapper)
  [key: string]: unknown;
}

/** Result from list operations including errors for skipped records. */
export interface StrapiListResult {
  items: ContentRecord[];
  errors: string[];
}

/**
 * Strapi dynamic zone component with an optional __component discriminator
 * and arbitrary content fields.
 */
interface DynamicComponent {
  __component?: string;
  text?: string;
  title?: string;
  summary?: string;
  subTitle?: string;
  leftColumnTitle?: string;
  leftColumnBody?: string;
  rightColumnTitle?: string;
  rightColumnBody?: string;
  items?: DynamicComponent[];
  textBlock?: DynamicComponent[];
  left?: DynamicComponent;
  right?: DynamicComponent;
  [key: string]: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_RECORD_ID_LENGTH = 256;
const MAX_CONTENT_BODY_SIZE = 1_048_576; // 1MB
const DEFAULT_CONTENT_TYPE = "text/html";

// ─── Strapi Adapter ──────────────────────────────────────────────────────────

/**
 * Data source adapter for Strapi CMS v4 REST API.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class StrapiAdapter implements DataSourceAdapter {
  private readonly config: Required<
    Omit<StrapiAdapterConfig, "frontendBaseUrl">
  > &
    Pick<StrapiAdapterConfig, "frontendBaseUrl">;
  private readonly httpClient: RetryHttpClient;

  constructor(config: StrapiAdapterConfig, httpClient?: RetryHttpClient) {
    this.config = {
      ...config,
      contentType: config.contentType ?? DEFAULT_CONTENT_TYPE,
      frontendBaseUrl: config.frontendBaseUrl,
    };
    this.httpClient = httpClient ?? new RetryHttpClient();
  }

  /**
   * Lists content records from Strapi with cursor-based pagination.
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
        `Strapi API returned status ${response.status}: ${response.body.substring(0, 200)}`,
      );
    }

    const body = JSON.parse(response.body) as StrapiListResponse;
    const { items, errors } = this.transformEntries(body.data);

    const { pagination: meta } = body.meta;
    const hasNextPage = meta.page < meta.pageCount;
    const nextCursor = hasNextPage
      ? this.encodeCursor(meta.page + 1)
      : undefined;

    return {
      items,
      nextCursor,
      totalCount: meta.total,
      errors,
    } as PagedResult<ContentRecord> & { errors: string[] };
  }

  /**
   * Fetches a single content record by its Strapi ID.
   * Includes full populate params to ensure dynamic zones (content_blocks)
   * are returned with their content.
   *
   * Validates: Requirement 5.1
   */
  async fetchById(recordId: string): Promise<ContentRecord | null> {
    const params = new URLSearchParams();
    this.addPopulateParams(params);
    const queryString = params.toString();
    const url = queryString
      ? `${this.config.baseUrl}/api/${this.config.collection}/${recordId}?${queryString}`
      : `${this.config.baseUrl}/api/${this.config.collection}/${recordId}`;

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Fetching single entry from Strapi",
        collection: this.config.collection,
        recordId,
        url,
      }),
    );

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

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Strapi fetchById raw response",
        collection: this.config.collection,
        recordId,
        hasData: !!body.data,
        dataKeys: body.data ? Object.keys(body.data) : [],
        hasAttributes: !!(body.data as StrapiEntry)?.attributes,
        attributeKeys: (body.data as StrapiEntry)?.attributes
          ? Object.keys((body.data as StrapiEntry).attributes!)
          : [],
        contentBlocksPresent: body.data
          ? !!(
              (body.data as StrapiEntry).attributes?.["content_blocks"] ??
              (body.data as Record<string, unknown>)["content_blocks"]
            )
          : false,
        contentBlocksLength: body.data
          ? Array.isArray(
              (body.data as StrapiEntry).attributes?.["content_blocks"] ??
                (body.data as Record<string, unknown>)["content_blocks"],
            )
            ? (
                ((body.data as StrapiEntry).attributes?.["content_blocks"] ??
                  (body.data as Record<string, unknown>)[
                    "content_blocks"
                  ]) as unknown[]
              ).length
            : 0
          : 0,
      }),
    );

    if (!body.data) {
      return null;
    }

    const record = this.transformEntry(body.data);
    return record;
  }

  /**
   * Detects changes since a given checkpoint (ISO 8601 timestamp).
   *
   * Uses Strapi's updatedAt field with $gt filter to find records
   * modified after the checkpoint. An empty string checkpoint fetches
   * all records as "created".
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
          `Strapi API returned status ${response.status}: ${response.body.substring(0, 200)}`,
        );
      }

      const body = JSON.parse(response.body) as StrapiListResponse;
      const result = this.transformEntries(body.data);
      errors.push(...result.errors);

      for (const record of result.items) {
        if (isInitial || this.isCreatedAfter(record, since)) {
          created.push(record);
        } else {
          updated.push(record);
        }
      }

      const { pagination: meta } = body.meta;
      hasMore = meta.page < meta.pageCount;
      page++;
    }

    // Generate checkpoint as the current ISO timestamp
    const checkpoint = new Date().toISOString();

    return {
      created,
      updated,
      deleted: [], // Strapi REST API does not expose deleted records
      checkpoint,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /** Builds the URL for listing entries with pagination. */
  private buildListUrl(page: number, pageSize: number): string {
    const params = new URLSearchParams({
      "pagination[page]": String(page),
      "pagination[pageSize]": String(pageSize),
      sort: "updatedAt:asc",
    });
    // Add collection-specific populate params
    this.addPopulateParams(params);
    return `${this.config.baseUrl}/api/${this.config.collection}?${params.toString()}`;
  }

  /** Builds the URL for detecting changes since a timestamp. */
  private buildChangesUrl(
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
    // Add collection-specific populate params
    this.addPopulateParams(params);
    return `${this.config.baseUrl}/api/${this.config.collection}?${params.toString()}`;
  }

  /**
   * Adds collection-specific populate parameters to URL search params.
   *
   * Uses Strapi REST API's `populate[field][on][component]` syntax for
   * dynamic zones, matching the populate configs from lib/strapi/helpers/populate.ts.
   *
   * For intranet-pages the full populate includes:
   * - head_title, seo, sidebar_blocks, heading (populate: *)
   * - content_blocks with per-component populate using `on` syntax
   */
  private addPopulateParams(params: URLSearchParams): void {
    switch (this.config.collection) {
      case "intranet-pages":
        this.addPagePopulateParams(params);
        break;

      case "intranet-teams":
        this.addTeamPopulateParams(params);
        break;

      case "intranet-people":
        this.addPersonPopulateParams(params);
        break;

      default:
        break;
    }
  }

  /** Populate params for intranet-pages. */
  private addPagePopulateParams(params: URLSearchParams): void {
    params.set("populate[head_title][populate]", "*");
    params.set("populate[seo][populate]", "*");
    params.set("populate[heading][populate]", "*");
    this.addSidebarBlocksPopulateParams(params);
    this.addContentBlocksPopulateParams(params);
  }

  /** Populate params for intranet-teams. */
  private addTeamPopulateParams(params: URLSearchParams): void {
    params.set("populate[head_title][populate]", "*");
    params.set("populate[team_picture][populate]", "*");
    params.set("populate[banner_graphic][populate]", "*");
    params.set("populate[intranet_people][populate]", "*");
    params.set("populate[icon][populate]", "*");
    this.addContentBlocksPopulateParams(params);
  }

  /** Populate params for intranet-people. */
  private addPersonPopulateParams(params: URLSearchParams): void {
    params.set("populate[headshot][populate]", "*");
    params.set("populate[pronunciation_voice_clip][populate]", "*");
    params.set("populate[intranet_team][populate]", "*");
    this.addContentBlocksPopulateParams(params);
  }

  /**
   * Adds sidebar_blocks dynamic zone populate params.
   *
   * sidebar_blocks is a dynamic zone with components like:
   * - sidebar.link-block (has links array)
   * - sidebar.document-block (has files relation)
   *
   * Using `[on]` syntax ensures each component's nested fields are populated.
   */
  private addSidebarBlocksPopulateParams(params: URLSearchParams): void {
    const prefix = "populate[sidebar_blocks][on]";

    params.set(`${prefix}[sidebar.link-block][populate]`, "*");
    params.set(`${prefix}[sidebar.document-block][populate]`, "files");
  }

  /**
   * Adds content_blocks dynamic zone populate params using Strapi's
   * `on` syntax for per-component population.
   *
   * This matches the populate config from lib/strapi/helpers/populate.ts:
   * - Special blocks get specific nested populate paths
   * - Standard blocks get populate: *
   */
  private addContentBlocksPopulateParams(params: URLSearchParams): void {
    const prefix = "populate[content_blocks][on]";

    // Special blocks with specific nested populate
    params.set(`${prefix}[dynamic.text-and-image][populate]`, "image");
    params.set(`${prefix}[dynamic.gallery][populate]`, "items.media");
    params.set(
      `${prefix}[dynamic.image-and-cta-block][populate]`,
      "hero_image",
    );
    params.set(`${prefix}[dynamic.accordion][populate][items][populate]`, "*");
    params.set(
      `${prefix}[dynamic.testimonial][populate][title][populate]`,
      "*",
    );
    params.set(
      `${prefix}[dynamic.testimonial][populate][quotes][populate]`,
      "*",
    );
    params.set(
      `${prefix}[dynamic.values-block][populate][title][populate]`,
      "*",
    );
    params.set(
      `${prefix}[dynamic.values-block][populate][values][populate]`,
      "*",
    );
    params.set(
      `${prefix}[dynamic.advisors-listing][populate]`,
      "advisors.photo",
    );
    params.set(`${prefix}[intranet-blocks.link-cards][populate]`, "cards.icon");
    params.set(`${prefix}[intranet-blocks.events-carousel][populate]`, "link");
    params.set(`${prefix}[intranet-blocks.video-block][populate]`, "video");
    params.set(
      `${prefix}[dynamic.about-me][populate][aboutMe][populate][image]`,
      "*",
    );
    params.set(
      `${prefix}[dynamic.50-50-text-n-image][populate][left][populate][image]`,
      "*",
    );
    params.set(
      `${prefix}[dynamic.50-50-text-n-image][populate][right][populate][image]`,
      "*",
    );

    // Standard blocks - all with populate: *
    const standardBlocks = [
      "dynamic.text-quote-block",
      "dynamic.case-study-listing",
      "dynamic.people-listing",
      "dynamic.text-and-cta-block",
      "dynamic.news-listing",
      "dynamic.clients-logo",
      "dynamic.shuffled-photo",
      "dynamic.text-block",
      "dynamic.double-text-block",
      "dynamic.job-listing",
      "dynamic.text-and-video",
      "dynamic.internship-listing",
      "dynamic.photos-block",
      "intranet-blocks.quote-of-the-week",
      "intranet-blocks.my-story-map",
      "intranet-blocks.team-cards",
      "intranet-blocks.voting-block",
      "intranet-blocks.system-repository",
      "intranet-blocks.thq-systems-repository",
      "intranet-blocks.social-header",
      "dynamic.table",
      "intranet-blocks.weekly-events",
      "intranet-blocks.weekly-challenge",
      "dynamic.columns-link-block",
      "dynamic.floor-plan",
      "dynamic.changeling-text-block",
      "dynamic.wins-and-shoutouts",
    ];

    for (const block of standardBlocks) {
      params.set(`${prefix}[${block}][populate]`, "*");
    }
  }

  /** Returns request options with Strapi Bearer token authentication. */
  private authHeaders(): HttpRequestOptions {
    return {
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
    };
  }

  /** Transforms an array of Strapi entries, skipping invalid ones. */
  private transformEntries(entries: StrapiEntry[]): StrapiListResult {
    const items: ContentRecord[] = [];
    const errors: string[] = [];

    for (const entry of entries) {
      const record = this.transformEntry(entry);
      if (record) {
        items.push(record);
      } else {
        const id = this.extractId(entry);
        errors.push(id ?? "unknown");
      }
    }

    return { items, errors };
  }

  /**
   * Transforms a single Strapi entry to a ContentRecord.
   * Returns null if the entry cannot produce a valid ContentRecord.
   *
   * Uses MarkdownConverter for content body when possible, falling back
   * to plain text extraction when the converter returns empty.
   *
   * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
   */
  private transformEntry(entry: StrapiEntry): ContentRecord | null {
    const id = this.extractId(entry);
    if (!id) return null;

    const recordId = String(id);
    if (recordId.length === 0 || recordId.length > MAX_RECORD_ID_LENGTH) {
      return null;
    }

    const attrs = this.extractAttributes(entry);

    // Log the attributes keys and content_blocks presence for debugging
    const contentBlocks = attrs["content_blocks"];
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "transformEntry - extracted attributes",
        recordId,
        collection: this.config.collection,
        attrKeys: Object.keys(attrs),
        hasContentBlocks: !!contentBlocks,
        contentBlocksIsArray: Array.isArray(contentBlocks),
        contentBlocksLength: Array.isArray(contentBlocks)
          ? contentBlocks.length
          : 0,
        contentBlocksSample: Array.isArray(contentBlocks)
          ? contentBlocks.slice(0, 2).map((b: Record<string, unknown>) => ({
              __component: b.__component,
              keys: Object.keys(b),
            }))
          : null,
      }),
    );

    // Use MarkdownConverter for content body
    const markdownBody = MarkdownConverter.toMarkdown(
      attrs,
      this.config.collection,
      { baseUrl: this.config.frontendBaseUrl },
    );

    let contentBody: string;
    let contentType: string;

    if (markdownBody.length > 0) {
      contentBody = markdownBody;
      contentType = "text/markdown";
    } else {
      // Fallback to existing plain text extraction
      const plainText = this.extractContentBody(attrs);
      if (!plainText) {
        return null;
      }
      contentBody = plainText;
      contentType = "text/plain";
    }

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "transformEntry - content body generated",
        recordId,
        collection: this.config.collection,
        contentType,
        contentBodyLength: contentBody.length,
        contentBodyPreview: contentBody.substring(0, 500),
      }),
    );

    if (contentBody.length > MAX_CONTENT_BODY_SIZE) {
      return null;
    }

    const lastModified = this.extractLastModified(attrs);
    if (!lastModified || !this.isValidISO8601(lastModified)) {
      return null;
    }

    const metadata = this.extractMetadata(attrs, recordId);

    // Compute documentPath for S3
    const documentPath = this.deriveDocumentPath(attrs, recordId);
    metadata["documentPath"] = documentPath;

    return {
      recordId,
      contentBody,
      contentType,
      metadata,
      lastModified,
    };
  }

  /** Extracts the entry ID from either format. */
  private extractId(entry: StrapiEntry): string | null {
    if (entry.id !== undefined && entry.id !== null) {
      const id = String(entry.id);
      return id.length > 0 ? id : null;
    }
    return null;
  }

  /** Extracts attributes from Strapi's response format. */
  private extractAttributes(entry: StrapiEntry): Record<string, unknown> {
    // Strapi v4 wraps fields in an "attributes" object
    if (entry.attributes && typeof entry.attributes === "object") {
      return entry.attributes as Record<string, unknown>;
    }
    // Strapi v4.14+ flat response format
    return entry as Record<string, unknown>;
  }

  /** Extracts and composes the content body from entry attributes. */
  private extractContentBody(attrs: Record<string, unknown>): string | null {
    // Try common Strapi content fields in priority order
    const contentFields = [
      "content",
      "body",
      "description",
      "text",
      "richText",
    ];

    for (const field of contentFields) {
      const value = attrs[field];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }

    // Handle dynamic zone content_blocks (e.g. intranet-pages)
    const contentBlocks = attrs["content_blocks"];
    if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
      const extracted = this.extractTextFromBlocks(
        contentBlocks as DynamicComponent[],
      );
      if (extracted.length > 0) {
        // Prepend page title/name and summary for context
        const parts: string[] = [];
        const name = attrs["name"] ?? attrs["title"];
        if (typeof name === "string" && name.length > 0) {
          parts.push(name);
        }
        const summary = attrs["summary"];
        if (typeof summary === "string" && summary.length > 0) {
          parts.push(summary);
        }
        parts.push(extracted);
        return parts.join("\n\n");
      }
    }

    // Fallback: use summary if available (common in intranet-pages)
    const summary = attrs["summary"];
    if (typeof summary === "string" && summary.length > 0) {
      const name = attrs["name"] ?? attrs["title"];
      if (typeof name === "string" && name.length > 0) {
        return `${name}\n\n${summary}`;
      }
      return summary;
    }

    // Fallback: concatenate title + any string fields
    const title = attrs["title"] ?? attrs["name"];
    if (typeof title === "string" && title.length > 0) {
      return title;
    }

    return null;
  }

  /** Extracts the lastModified timestamp from entry attributes. */
  private extractLastModified(attrs: Record<string, unknown>): string | null {
    const updatedAt = attrs["updatedAt"] ?? attrs["updated_at"];
    if (typeof updatedAt === "string") {
      return updatedAt;
    }

    const createdAt = attrs["createdAt"] ?? attrs["created_at"];
    if (typeof createdAt === "string") {
      return createdAt;
    }

    return null;
  }

  /** Builds metadata from entry attributes. */
  private extractMetadata(
    attrs: Record<string, unknown>,
    recordId: string,
  ): Record<string, string> {
    const metadata: Record<string, string> = {
      source: "strapi",
      collection: this.config.collection,
      recordId,
    };

    if (typeof attrs["title"] === "string") {
      metadata["title"] = attrs["title"];
    }
    if (typeof attrs["name"] === "string") {
      metadata["name"] = attrs["name"];
    }
    if (typeof attrs["slug"] === "string") {
      metadata["slug"] = attrs["slug"];
      // Construct a source URL from slug for intranet pages
      if (this.config.collection === "intranet-pages") {
        metadata["sourceUrl"] =
          `${this.config.baseUrl}/${this.config.collection}/${attrs["slug"]}`;
      }
    }
    if (typeof attrs["locale"] === "string") {
      metadata["locale"] = attrs["locale"];
    }
    if (typeof attrs["createdAt"] === "string") {
      metadata["createdAt"] = attrs["createdAt"];
    }

    return metadata;
  }

  /**
   * Derives the S3 document path for a content record.
   * Format: documents/{collection}/{slug-or-name}.json
   *
   * Priority: slug > title (slugified) > name (slugified) > recordId
   */
  private deriveDocumentPath(
    attrs: Record<string, unknown>,
    recordId: string,
  ): string {
    const collection = this.config.collection;
    let filename: string;

    if (typeof attrs["slug"] === "string" && attrs["slug"].length > 0) {
      filename = attrs["slug"];
    } else if (
      typeof attrs["title"] === "string" &&
      attrs["title"].length > 0
    ) {
      filename = toSlug(attrs["title"]);
    } else if (typeof attrs["name"] === "string" && attrs["name"].length > 0) {
      filename = toSlug(attrs["name"]);
    } else {
      filename = recordId;
    }

    return `documents/${collection}/${filename}.json`;
  }

  /** Validates an ISO 8601 timestamp string. */
  private isValidISO8601(value: string): boolean {
    const date = new Date(value);
    return !isNaN(date.getTime());
  }

  /** Determines if a record was created after the checkpoint. */
  private isCreatedAfter(record: ContentRecord, since: string): boolean {
    const createdAt = record.metadata["createdAt"];
    if (!createdAt) return true; // If no createdAt, assume it's new
    return new Date(createdAt).getTime() > new Date(since).getTime();
  }

  /**
   * Recursively extracts text content from Strapi dynamic zone blocks.
   *
   * Handles the following component types:
   * - DynamicTextBlockComponent (text field)
   * - DynamicAccordionComponent (title + items with title/summary)
   * - DynamicChangelingTextBlockComponent (textBlock array with text)
   * - Dynamic5050TextNImageComponent (left/right with text)
   * - DynamicDoubleTextBlockComponent (leftColumnTitle/Body, rightColumnTitle/Body)
   * - DynamicWinsAndShoutoutsComponent (title, subTitle)
   * - Any component with a text, title, or summary field
   */
  private extractTextFromBlocks(blocks: DynamicComponent[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
      const extracted = this.extractTextFromBlock(block);
      if (extracted) {
        parts.push(extracted);
      }
    }

    return parts.join("\n\n");
  }

  /** Extracts text content from a single dynamic component. */
  private extractTextFromBlock(block: DynamicComponent): string | null {
    const segments: string[] = [];

    // Direct text field (DynamicTextBlockComponent, etc.)
    if (typeof block.text === "string" && block.text.length > 0) {
      segments.push(block.text);
    }

    // Title field (DynamicAccordionComponent, DynamicWinsAndShoutoutsComponent)
    if (typeof block.title === "string" && block.title.length > 0) {
      segments.push(block.title);
    }

    // Subtitle field (DynamicWinsAndShoutoutsComponent)
    if (typeof block.subTitle === "string" && block.subTitle.length > 0) {
      segments.push(block.subTitle);
    }

    // Summary field (accordion items)
    if (typeof block.summary === "string" && block.summary.length > 0) {
      segments.push(block.summary);
    }

    // Double text block columns (DynamicDoubleTextBlockComponent)
    if (
      typeof block.leftColumnTitle === "string" &&
      block.leftColumnTitle.length > 0
    ) {
      segments.push(block.leftColumnTitle);
    }
    if (
      typeof block.leftColumnBody === "string" &&
      block.leftColumnBody.length > 0
    ) {
      segments.push(block.leftColumnBody);
    }
    if (
      typeof block.rightColumnTitle === "string" &&
      block.rightColumnTitle.length > 0
    ) {
      segments.push(block.rightColumnTitle);
    }
    if (
      typeof block.rightColumnBody === "string" &&
      block.rightColumnBody.length > 0
    ) {
      segments.push(block.rightColumnBody);
    }

    // Nested items array (DynamicAccordionComponent items)
    if (Array.isArray(block.items) && block.items.length > 0) {
      const nested = this.extractTextFromBlocks(block.items);
      if (nested.length > 0) {
        segments.push(nested);
      }
    }

    // textBlock array (DynamicChangelingTextBlockComponent)
    if (Array.isArray(block.textBlock) && block.textBlock.length > 0) {
      const nested = this.extractTextFromBlocks(block.textBlock);
      if (nested.length > 0) {
        segments.push(nested);
      }
    }

    // left/right sub-components (Dynamic5050TextNImageComponent)
    if (block.left && typeof block.left === "object") {
      const leftText = this.extractTextFromBlock(block.left);
      if (leftText) {
        segments.push(leftText);
      }
    }
    if (block.right && typeof block.right === "object") {
      const rightText = this.extractTextFromBlock(block.right);
      if (rightText) {
        segments.push(rightText);
      }
    }

    return segments.length > 0 ? segments.join("\n") : null;
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
