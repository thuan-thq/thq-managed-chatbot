/**
 * Full Sync Pipeline.
 *
 * Orchestrates a full content ingestion from a data source adapter,
 * persisting records to S3 and tracking progress in DynamoDB for
 * resume capability. Triggers a Bedrock KB ingestion job on completion.
 *
 * Features:
 * - Configurable page size (default 100)
 * - Progress persistence every 100 records for resume
 * - Resume from last checkpoint on interruption
 * - Structured logging of progress
 * - Bedrock KB sync trigger on completion
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { DataSourceAdapter } from "./adapter";
import { ContentRecord, S3ContentDocument } from "./types";
import { S3ContentClient } from "./s3-client";
import { SyncStateClient } from "./dynamo-client";
import { BedrockSyncClient } from "./bedrock-client";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Configuration for the full sync pipeline. */
export interface FullSyncPipelineConfig {
  /** The data source type identifier (e.g. "strapi"). */
  sourceType: string;
  /** The collection name to sync (used when the adapter is multi-collection). */
  collectionName: string;
  /** The client ID for this deployment. */
  clientId: string;
  /** Number of records per page (default 100). */
  pageSize?: number;
  /** Interval for progress logging and checkpointing (default 100). */
  progressInterval?: number;
}

/** Result of a full sync operation. */
export interface FullSyncResult {
  /** Total records processed. */
  recordsProcessed: number;
  /** Records that failed to persist. */
  errors: string[];
  /** Whether the sync completed successfully. */
  success: boolean;
  /** The Bedrock ingestion job ID (if triggered). */
  ingestionJobId?: string;
  /** Whether this was a resumed sync. */
  resumed: boolean;
}

// ─── Full Sync Pipeline ──────────────────────────────────────────────────────

/**
 * Orchestrates full content ingestion with pagination and progress tracking.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
export class FullSyncPipeline {
  private readonly adapter: DataSourceAdapter;
  private readonly s3Client: S3ContentClient;
  private readonly syncStateClient: SyncStateClient;
  private readonly bedrockClient: BedrockSyncClient;
  private readonly config: Required<FullSyncPipelineConfig>;

  constructor(
    adapter: DataSourceAdapter,
    s3Client: S3ContentClient,
    syncStateClient: SyncStateClient,
    bedrockClient: BedrockSyncClient,
    config: FullSyncPipelineConfig,
  ) {
    this.adapter = adapter;
    this.s3Client = s3Client;
    this.syncStateClient = syncStateClient;
    this.bedrockClient = bedrockClient;
    this.config = {
      sourceType: config.sourceType,
      collectionName: config.collectionName,
      clientId: config.clientId,
      pageSize: config.pageSize ?? 100,
      progressInterval: config.progressInterval ?? 100,
    };
  }

  /**
   * Executes the full sync pipeline.
   *
   * 1. Checks for existing resume token
   * 2. Marks sync state as running
   * 3. Paginates through all records
   * 4. Persists each record to S3
   * 5. Checkpoints progress every progressInterval records
   * 6. On completion: triggers Bedrock KB sync, marks idle
   * 7. On failure: marks failed, retains resume token
   */
  async execute(): Promise<FullSyncResult> {
    const errors: string[] = [];
    let recordsProcessed = 0;
    let cursor: string | undefined;
    let resumed = false;
    // Tracks every S3 key written during this sync — used for orphan pruning at the end.
    const writtenDocumentPaths = new Set<string>();

    try {
      // Check for existing sync state with resume token
      const existingState = await this.syncStateClient.getSyncState(
        this.config.sourceType,
      );

      if (existingState?.resumeToken && existingState.status === "failed") {
        // Resume from last checkpoint
        cursor = existingState.resumeToken;
        recordsProcessed = existingState.progressRecords ?? 0;
        resumed = true;

        console.log(
          JSON.stringify({
            level: "INFO",
            message: "Resuming full sync from checkpoint",
            sourceType: this.config.sourceType,
            resumeToken: cursor,
            progressRecords: recordsProcessed,
          }),
        );
      }

      // Mark sync as running
      await this.syncStateClient.updateSyncState(this.config.sourceType, {
        status: "running",
        progressRecords: recordsProcessed,
        totalRecords: existingState?.totalRecords ?? 0,
        resumeToken: cursor,
      });

      // Paginate through all records
      let hasMore = true;

      while (hasMore) {
        const page = await this.adapter.listContent(
          {
            pageSize: this.config.pageSize,
            cursor,
          },
          this.config.collectionName,
        );

        // Update total on first page if available
        if (
          page.totalCount !== undefined &&
          recordsProcessed === 0 &&
          !resumed
        ) {
          await this.syncStateClient.updateSyncState(this.config.sourceType, {
            totalRecords: page.totalCount,
          });
        }

        // Process each record in the page
        for (const record of page.items) {
          try {
            const key = await this.persistRecord(record);
            writtenDocumentPaths.add(key);
            recordsProcessed++;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${record.recordId}: ${message}`);
            console.log(
              JSON.stringify({
                level: "ERROR",
                message: "Failed to persist record",
                recordId: record.recordId,
                error: message,
              }),
            );
          }

          // Progress logging and checkpointing every progressInterval records
          if (recordsProcessed % this.config.progressInterval === 0) {
            await this.checkpoint(recordsProcessed, page.nextCursor);
          }
        }

        // Move to next page
        cursor = page.nextCursor;
        hasMore = cursor !== undefined;
      }

      // Prune S3 objects and KB entries that no longer exist in the source.
      // Build the set of keys that were just written, then delete anything
      // in S3 under this collection's prefix that isn't in that set.
      const writtenKeys = new Set(Array.from(writtenDocumentPaths));
      const prefix = `documents/${this.config.sourceType}/`;
      const existingKeys = await this.s3Client.listDocumentKeys(prefix);
      const orphanKeys = existingKeys.filter((k) => !writtenKeys.has(k));

      if (orphanKeys.length > 0) {
        console.log(
          JSON.stringify({
            level: "INFO",
            message: "Pruning orphaned documents from S3 and KB",
            sourceType: this.config.sourceType,
            orphanCount: orphanKeys.length,
            orphanKeys,
          }),
        );

        // Delete from S3
        for (const key of orphanKeys) {
          try {
            await this.s3Client.deleteDocument("prune", key);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(
              JSON.stringify({
                level: "ERROR",
                message: "Failed to prune orphaned S3 object",
                key,
                error: message,
              }),
            );
            errors.push(`prune-s3:${key}: ${message}`);
          }
        }

        // Delete from Bedrock KB in batches of 10 (API limit)
        const bucketName = process.env.DATA_BUCKET_NAME ?? "";
        for (let i = 0; i < orphanKeys.length; i += 10) {
          const batch = orphanKeys.slice(i, i + 10);
          const s3Uris = batch.map((k) => `s3://${bucketName}/${k}`);
          try {
            const results = await this.bedrockClient.deleteDocuments(s3Uris);
            console.log(
              JSON.stringify({
                level: "INFO",
                message: "Pruned orphaned KB documents",
                sourceType: this.config.sourceType,
                uris: s3Uris,
                statuses: results.map((r) => r.status),
              }),
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(
              JSON.stringify({
                level: "ERROR",
                message: "Failed to prune orphaned KB documents",
                uris: s3Uris,
                error: message,
              }),
            );
            errors.push(`prune-kb:${s3Uris.join(",")}: ${message}`);
          }
        }
      } else {
        console.log(
          JSON.stringify({
            level: "INFO",
            message: "No orphaned documents to prune",
            sourceType: this.config.sourceType,
          }),
        );
      }

      // Trigger Bedrock KB sync
      const ingestionJobId = await this.bedrockClient.startIngestionJob();

      console.log(
        JSON.stringify({
          level: "INFO",
          message: "Full sync completed, Bedrock KB ingestion triggered",
          sourceType: this.config.sourceType,
          recordsProcessed,
          errors: errors.length,
          ingestionJobId,
        }),
      );

      // Mark sync as idle and clear resume token
      await this.syncStateClient.updateSyncState(this.config.sourceType, {
        status: "idle",
        lastFullSync: new Date().toISOString(),
        recordsIngested: recordsProcessed,
        progressRecords: recordsProcessed,
      });
      await this.syncStateClient.clearResumeToken(this.config.sourceType);

      return {
        recordsProcessed,
        errors,
        success: true,
        ingestionJobId,
        resumed,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      console.log(
        JSON.stringify({
          level: "ERROR",
          message: "Full sync failed",
          sourceType: this.config.sourceType,
          recordsProcessed,
          error: message,
        }),
      );

      // Mark sync as failed, retain resume token for recovery
      await this.syncStateClient.updateSyncState(this.config.sourceType, {
        status: "failed",
        lastError: message,
        progressRecords: recordsProcessed,
        resumeToken: cursor,
      });

      return {
        recordsProcessed,
        errors,
        success: false,
        resumed,
      };
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Persists a content record to S3 in S3ContentDocument format.
   * Returns the S3 key that was written.
   */
  private async persistRecord(record: ContentRecord): Promise<string> {
    // Extract documentPath from adapter metadata for consistent S3 key
    const documentPath = record.metadata["documentPath"];
    const key = documentPath ?? `documents/${record.recordId}.json`;

    const document: S3ContentDocument = {
      recordId: record.recordId,
      contentBody: record.contentBody,
      contentType: record.contentType,
      sourceType: this.config.sourceType,
      metadata: {
        clientId: this.config.clientId,
        title:
          record.metadata["title"] ??
          record.metadata["name"] ??
          record.recordId,
        lastModified: record.lastModified,
        sourceUrl: record.metadata["sourceUrl"],
        ...record.metadata,
      },
      ...(documentPath ? { documentPath } : {}),
    };

    await this.s3Client.putDocument(document);
    return key;
  }

  /**
   * Persists sync progress to DynamoDB and logs progress.
   *
   * Validates: Requirements 4.4, 4.6
   */
  private async checkpoint(
    recordsProcessed: number,
    nextCursor: string | undefined,
  ): Promise<void> {
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Sync progress checkpoint",
        sourceType: this.config.sourceType,
        recordsProcessed,
        resumeToken: nextCursor,
      }),
    );

    await this.syncStateClient.updateSyncState(this.config.sourceType, {
      progressRecords: recordsProcessed,
      resumeToken: nextCursor,
    });
  }
}
