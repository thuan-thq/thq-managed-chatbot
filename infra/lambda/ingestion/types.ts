/**
 * Core types for the content ingestion pipeline.
 *
 * Defines the normalised data formats used across all data source adapters
 * and the ingestion Lambda. These types ensure consistent processing
 * regardless of the external source.
 *
 * Requirements: 5.1, 5.2, 5.4
 */

// ─── Content Record ──────────────────────────────────────────────────────────

/**
 * The normalised document format produced by adapters and stored in S3
 * for Bedrock KB ingestion.
 *
 * Validates: Requirement 5.1
 *  - recordId: non-empty, max 256 characters
 *  - contentBody: non-empty, max 1MB
 *  - contentType: non-empty, MIME type format
 *  - lastModified: valid ISO 8601 timestamp
 *  - metadata: non-null object
 */
export interface ContentRecord {
  /** Unique identifier for the content record (max 256 chars). */
  recordId: string;
  /** The document body content (max 1MB). */
  contentBody: string;
  /** MIME type of the content (e.g. "text/plain", "text/html"). */
  contentType: string;
  /** Arbitrary key-value metadata associated with the record. */
  metadata: Record<string, string>;
  /** ISO 8601 timestamp of last modification. */
  lastModified: string;
}

// ─── Change Set ──────────────────────────────────────────────────────────────

/**
 * Represents changes detected since a given checkpoint.
 *
 * Validates: Requirement 5.2
 *  - created: new records since checkpoint
 *  - updated: modified records since checkpoint
 *  - deleted: IDs of removed records since checkpoint
 *  - checkpoint: opaque cursor for the next detectChanges call
 *  - An empty ChangeSet has empty collections and a valid checkpoint cursor
 */
export interface ChangeSet {
  /** Records created since the last checkpoint. */
  created: ContentRecord[];
  /** Records updated since the last checkpoint. */
  updated: ContentRecord[];
  /** IDs of records deleted since the last checkpoint. */
  deleted: string[];
  /** Opaque cursor for the next detectChanges call. */
  checkpoint: string;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

/**
 * Parameters for cursor-based pagination.
 *
 * Validates: Requirement 5.4
 *  - pageSize: configurable, default 100, min 1, max 500
 *  - cursor: opaque string for fetching the next page (undefined for first page)
 */
export interface PaginationParams {
  /** Number of records per page (default 100, min 1, max 500). */
  pageSize: number;
  /** Opaque cursor for the next page. Omit or undefined for the first page. */
  cursor?: string;
}

/**
 * A paginated result set containing items and cursor metadata.
 */
export interface PagedResult<T> {
  /** The items in the current page. */
  items: T[];
  /** Cursor for fetching the next page, or undefined if no more pages. */
  nextCursor?: string;
  /** Total number of records across all pages (if known). */
  totalCount?: number;
}

// ─── S3 Content Document ─────────────────────────────────────────────────────

/**
 * The JSON document format persisted to S3 for Bedrock KB ingestion.
 *
 * Stored at: s3://{client-id}-kb-data/documents/{recordId}.json
 */
export interface S3ContentDocument {
  /** Unique identifier matching the source record. */
  recordId: string;
  /** The document body content. */
  contentBody: string;
  /** MIME type of the content (e.g. "text/markdown", "text/plain"). */
  contentType: string;
  /** Identifier for the data source type (e.g. "strapi", "monday"). */
  sourceType: string;
  /** Document metadata for Bedrock KB indexing. */
  metadata: S3ContentMetadata;
  /** Optional override for the S3 key path (e.g. "documents/{collection}/{slug}.json"). */
  documentPath?: string;
}

/**
 * Metadata block within an S3 content document.
 */
export interface S3ContentMetadata {
  /** The client this document belongs to. */
  clientId: string;
  /** Human-readable title for the document. */
  title: string;
  /** ISO 8601 timestamp of last modification. */
  lastModified: string;
  /** Optional URL pointing back to the source content. */
  sourceUrl?: string;
  /** Additional arbitrary metadata fields. */
  [key: string]: string | undefined;
}
