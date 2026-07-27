/**
 * Ingestion Lambda - public API exports.
 *
 * Re-exports all types and interfaces used by the content ingestion pipeline
 * and data source adapters.
 */

export type {
  ContentRecord,
  ChangeSet,
  PaginationParams,
  PagedResult,
  S3ContentDocument,
  S3ContentMetadata,
} from "./types";

export type { DataSourceAdapter } from "./adapter";

export { RetryHttpClient, HttpRetryError } from "./http-client";

export type {
  RetryHttpClientConfig,
  HttpRequestOptions,
  HttpResponse,
} from "./http-client";

export { StrapiAdapter } from "./strapi-adapter";

export type { StrapiAdapterConfig, StrapiListResult } from "./strapi-adapter";
