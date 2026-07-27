/**
 * Data Source Adapter interface.
 *
 * Abstracts external data source interactions behind a common interface,
 * enabling runtime selection and future extensibility. All adapters
 * (Strapi, Monday.com, Employment Hero) implement this contract.
 *
 * Requirements: 5.1, 5.2, 5.4
 */

import {
  ContentRecord,
  ChangeSet,
  PaginationParams,
  PagedResult,
} from "./types";

// ─── Data Source Adapter ─────────────────────────────────────────────────────

/**
 * Common interface for all data source adapters.
 *
 * Each adapter transforms source-specific records into the normalised
 * ContentRecord format and supports pagination and change detection.
 */
export interface DataSourceAdapter {
  /**
   * Lists content records from the data source with cursor-based pagination.
   *
   * @param pagination - Page size and optional cursor for the next page
   * @returns A paged result containing ContentRecord items
   *
   * Validates: Requirements 5.1, 5.4
   */
  listContent(
    pagination: PaginationParams,
  ): Promise<PagedResult<ContentRecord>>;

  /**
   * Fetches a single content record by its unique identifier.
   *
   * @param recordId - The unique identifier of the record to fetch
   * @returns The ContentRecord if found, or null if not found
   *
   * Validates: Requirement 5.1
   */
  fetchById(recordId: string): Promise<ContentRecord | null>;

  /**
   * Detects changes in the data source since the given checkpoint.
   *
   * @param since - An opaque checkpoint cursor from a previous detectChanges call.
   *               Pass an empty string for the initial call.
   * @returns A ChangeSet containing created, updated, and deleted records
   *
   * Validates: Requirement 5.2
   */
  detectChanges(since: string): Promise<ChangeSet>;
}
