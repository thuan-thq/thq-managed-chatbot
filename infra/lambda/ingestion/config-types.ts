/**
 * Configuration types for the multi-client Strapi ingestion Lambda.
 *
 * These types describe the shape of `deployment.json` and are used by
 * ConfigLoader, ConfigurableStrapiAdapter, and CollectionMarkdownConverter.
 *
 * Requirements: 1.1, 1.6, 1.7, 2.1, 2.2, 3.1–3.8, 4.1
 */

// ─── Markdown strategy ────────────────────────────────────────────────────────

/**
 * Selects the rendering strategy used by CollectionMarkdownConverter
 * to produce a markdown document from a raw Strapi entry.
 *
 * - `content-blocks` — render via the dynamic zone converter (Strapi dynamic zones)
 * - `rich-text`      — render a single rich text / HTML field as-is
 * - `flat-fields`    — concatenate configured plain-text string fields
 */
export type MarkdownStrategy = "content-blocks" | "rich-text" | "flat-fields";

// ─── Populate config ──────────────────────────────────────────────────────────

/**
 * A single Strapi populate query parameter expressed as a key/value pair.
 *
 * Example: `{ key: "populate[content_blocks][on][dynamic.text-block][populate]", value: "*" }`
 */
export interface PopulateField {
  key: string;
  value: string;
}

/**
 * Declares the Strapi `populate` query parameters for a collection.
 *
 * When `wildcard` is `true`, only `populate=*` is appended and `fields` is
 * ignored (Requirements 2.1, 2.3).
 * When `wildcard` is absent/false and `fields` is non-empty, each entry is
 * appended as a separate query parameter (Requirement 2.2).
 * When both are absent/empty, no populate params are added (Requirement 2.4).
 */
export interface PopulateConfig {
  /** When true, append `populate=*` and ignore `fields`. */
  wildcard?: boolean;
  /** Per-component populate key/value pairs for dynamic zones. */
  fields?: PopulateField[];
}

// ─── Content field mapping ────────────────────────────────────────────────────

/**
 * Maps logical roles to the actual Strapi field names used in a collection.
 *
 * All fields are optional; the adapter applies documented defaults when a
 * field is absent.
 *
 * Requirements: 3.1–3.8
 */
export interface ContentFieldMapping {
  /**
   * Ordered list of field names to try for the document title.
   * The first field that resolves to a non-blank string wins (Req 3.1).
   */
  titleFields?: string[];

  /**
   * Field name to use as the document slug for S3 key derivation and
   * `sourceUrl` construction. Falls back to entry `id` when absent or
   * blank (Req 3.2).
   */
  slugField?: string;

  /**
   * Field name for a short summary. When present and non-empty, a
   * `## Summary` section is rendered after the title (Req 3.3).
   */
  summaryField?: string;

  /**
   * Field name for the dynamic zone array used by the `content-blocks`
   * strategy. Defaults to `"content_blocks"` (Req 3.4).
   */
  contentBlocksField?: string;

  /**
   * Field name for the rich text / HTML body used by the `rich-text`
   * strategy (Req 3.5).
   */
  richTextField?: string;

  /**
   * Ordered list of plain-text fields concatenated by the `flat-fields`
   * strategy (Req 3.6).
   */
  flatFields?: string[];

  /**
   * Field name for the last-modified timestamp. Defaults to `"updatedAt"`.
   * Falls back to `attrs.createdAt`; logs WARN and omits when both absent
   * (Req 3.7, 3.8).
   */
  lastModifiedField?: string;
}

// ─── Collection config ────────────────────────────────────────────────────────

/**
 * Per-collection configuration block.
 *
 * Each entry in `StrapiConfig.collections` describes one Strapi REST API
 * collection and controls how its entries are fetched and converted to
 * markdown documents.
 *
 * Requirements: 1.1, 1.6, 1.7
 */
export interface StrapiCollectionConfig {
  /**
   * Strapi REST API collection path (e.g. `"intranet-pages"`).
   * Used to build `/api/{name}` request URLs and as the S3 key prefix.
   * Must be a non-empty string (Req 1.5, 1.6).
   */
  name: string;

  /**
   * Full Strapi content-type UID (e.g. `"api::intranet-page.intranet-page"`).
   * Used to build the UidCollectionMap for webhook routing (Req 5.1).
   * Must be a non-empty string (Req 1.6).
   */
  strapiUid: string;

  /**
   * Content rendering strategy applied by CollectionMarkdownConverter
   * (Req 1.6).
   */
  markdownStrategy: MarkdownStrategy;

  /**
   * Maps logical roles to actual Strapi field names for this collection
   * (Req 1.6).
   */
  fieldMappings: ContentFieldMapping;

  /**
   * Strapi populate parameters for list and fetch-by-id requests.
   * When absent, no populate query parameters are added (Req 1.7, 1.8).
   */
  populate?: PopulateConfig;

  /**
   * URL path template used to construct the front-end `sourceUrl`.
   * Uses `{slug}` as the sole placeholder (e.g. `"/team/{slug}"`).
   * An empty string is treated as absent (Req 4.1).
   */
  urlPathTemplate?: string;

  /**
   * When `true`, this entry describes a Strapi **single type** rather than a
   * collection. Single types expose `/api/{name}` (no pagination) and return
   * `{ data: StrapiEntry }` instead of a paginated list.
   *
   * The adapter will call the single-type endpoint and treat the response as a
   * one-item result for both full-sync (`listContent`) and change-detection
   * (`detectChanges`) flows.
   */
  isSingleType?: boolean;
}

// ─── Data source config ───────────────────────────────────────────────────────

/**
 * Strapi connection details and collection declarations for one data source.
 *
 * Requirements: 1.1
 */
export interface StrapiConfig {
  /** Unique identifier for this data source (e.g. `"main-strapi"`). Used to route webhooks and secrets. */
  id: string;
  /** Discriminator — must be `"strapi"`. */
  type: "strapi";
  /** Base URL of the Strapi instance (must start with `http://` or `https://`). */
  apiEndpoint: string;
  /** Strapi Bearer API token for authenticating REST API requests. */
  apiToken: string;
  /** Shared secret used to validate incoming Strapi webhooks. */
  webhookSecret: string;
  /**
   * Front-end base URL prepended to `urlPathTemplate` values when
   * constructing `sourceUrl` (Req 4.2, 4.7).
   */
  frontendBaseUrl?: string;
  /** Default page size for list requests (default behaviour applies when absent). */
  pageSize?: number;
  /** Ordered list of Strapi collections to ingest (Req 1.1). */
  collections: StrapiCollectionConfig[];
}

/**
 * Union of all supported data source config types.
 * Extend with additional `type` variants as new sources are added.
 */
export type DataSourceConfig = StrapiConfig;

// ─── Supporting config types ──────────────────────────────────────────────────

/**
 * Session behaviour configuration.
 */
export interface SessionConfig {
  /** Session inactivity timeout in minutes. */
  duration: number;
  /** Maximum number of conversational turns per session. */
  turnLimit: number;
  /** Claude token budget per session. */
  tokenBudget: number;
  /** Number of days to retain session records in DynamoDB. */
  retentionDays: number;
}

/**
 * API rate limiting configuration.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed per minute per API key. */
  requestsPerMinute: number;
}

/**
 * API key configuration.
 */
export interface ApiKeysConfig {
  /** Widget (end-user) API key. */
  appKey: string;
  /** Admin API key. */
  adminKey: string;
}

/**
 * Operational monitoring and alerting configuration.
 */
export interface MonitoringConfig {
  /** Monthly AWS cost budget threshold in USD. */
  budgetAmount: number;
  /** Email address for budget and alarm notifications. */
  alarmEmail: string;
}

// ─── Top-level client config ──────────────────────────────────────────────────

/**
 * Top-level configuration object for a single client deployment.
 *
 * Loaded from `infra/config/deployment.json` at Lambda cold start by
 * `ConfigLoader`. All fields except optional ones are required.
 *
 * Requirements: 1.1, 1.6, 1.7
 */
export interface ClientConfig {
  /** Unique identifier for this client deployment (e.g. `"thq-managed-chatbot"`). */
  clientId: string;
  /** AWS region where the client's infrastructure is deployed (e.g. `"ap-southeast-2"`). */
  region: string;
  /** Amazon Bedrock model ID to use for chat responses. */
  modelId: string;
  /** Minimum confidence threshold for knowledge base results (0–1). */
  confidenceThreshold: number;
  /**
   * Ordered list of data source configurations. Each entry describes one
   * external system (e.g. a Strapi instance) and its collections.
   * At least one entry is required.
   */
  dataSources: DataSourceConfig[];
  /** Session behaviour settings. */
  session: SessionConfig;
  /** API rate limiting settings. */
  rateLimit: RateLimitConfig;
  /** API key values. */
  apiKeys: ApiKeysConfig;
  /** Monitoring and alerting settings. */
  monitoring: MonitoringConfig;
}
