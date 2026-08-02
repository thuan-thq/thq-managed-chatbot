/**
 * Webhook Event Router.
 *
 * Routes validated webhook events to the appropriate handler based on
 * the event type (create, update, delete). Orchestrates adapter calls,
 * S3 persistence, and Bedrock KB sync triggers.
 *
 * Requirements: 6.4, 6.5
 */

import { DataSourceAdapter } from "./adapter";
import { S3ContentClient } from "./s3-client";
import { BedrockSyncClient, buildS3Uri } from "./bedrock-client";
import { S3ContentDocument } from "./types";
import { toSlug } from "./markdown-converter";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The webhook payload structure received from data sources. */
export interface WebhookPayload {
  event: "create" | "update" | "delete";
  recordId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  /** Collection name, used to route fetchById to the correct Strapi endpoint. */
  collection?: string;
}

/** Configuration for the event router. */
export interface EventRouterConfig {
  clientId: string;
  sourceType: string;
  bucketName: string;
}

// ─── Webhook Event Router ────────────────────────────────────────────────────

/**
 * Routes webhook events to the appropriate processing pipeline.
 *
 * - create/update: fetch content via adapter, persist to S3, trigger KB sync
 * - delete: remove from S3, trigger KB sync
 *
 * Validates: Requirements 6.4, 6.5
 */
export class WebhookEventRouter {
  private readonly adapter: DataSourceAdapter;
  private readonly s3Client: S3ContentClient;
  private readonly bedrockClient: BedrockSyncClient;
  private readonly config: EventRouterConfig;

  constructor(
    adapter: DataSourceAdapter,
    s3Client: S3ContentClient,
    bedrockClient: BedrockSyncClient,
    config: EventRouterConfig,
  ) {
    this.adapter = adapter;
    this.s3Client = s3Client;
    this.bedrockClient = bedrockClient;
    this.config = config;
  }

  /**
   * Routes a webhook payload to the appropriate handler.
   *
   * @param payload - The validated webhook event payload
   * @throws Error if any processing step fails
   */
  async route(payload: WebhookPayload): Promise<void> {
    switch (payload.event) {
      case "create":
      case "update":
        await this.handleUpsert(payload);
        break;
      case "delete":
        await this.handleDelete(payload);
        break;
      default:
        console.log(
          JSON.stringify({
            level: "WARN",
            message: "Unknown webhook event type",
            event: payload.event,
            recordId: payload.recordId,
          }),
        );
    }
  }

  /**
   * Handles create and update events.
   *
   * 1. Fetches latest content from the data source via adapter
   * 2. Transforms to S3ContentDocument format
   * 3. Persists to S3
   * 4. Triggers Bedrock KB re-indexing
   *
   * Retries the adapter fetch up to 3 times with exponential backoff when the
   * record is not found — Strapi fires webhooks slightly before the REST API
   * reflects the change, so a brief wait is needed.
   */
  private async handleUpsert(payload: WebhookPayload): Promise<void> {
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Handling upsert event",
        event: payload.event,
        recordId: payload.recordId,
      }),
    );

    // Step 1: Fetch latest content from the data source.
    // Retry up to 3 times — Strapi can fire the webhook before the record
    // is visible on the REST API (publish race condition).
    const MAX_FETCH_RETRIES = 3;
    const FETCH_RETRY_DELAY_MS = 2000; // 2s, 4s, 8s
    let record = null;

    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      record = await this.adapter.fetchById(
        payload.recordId,
        payload.collection ?? this.config.sourceType,
      );
      if (record) break;

      if (attempt < MAX_FETCH_RETRIES) {
        const delay = FETCH_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(
          JSON.stringify({
            level: "WARN",
            message:
              "Record not found in data source - retrying after delay (Strapi publish race)",
            recordId: payload.recordId,
            event: payload.event,
            attempt,
            nextRetryMs: delay,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!record) {
      console.log(
        JSON.stringify({
          level: "WARN",
          message:
            "Record not found in data source after retries - skipping upsert",
          recordId: payload.recordId,
          event: payload.event,
          attemptsExhausted: MAX_FETCH_RETRIES,
        }),
      );
      return;
    }

    // Step 2: Transform ContentRecord to S3ContentDocument
    // Use documentPath from adapter metadata (includes collection/slug) for
    // consistent S3 key between webhook and full-sync paths.
    const documentPath = record.metadata["documentPath"];

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
        ...record.metadata,
      },
      ...(documentPath ? { documentPath } : {}),
    };

    // Step 3: Persist to S3
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Persisting document to S3",
        recordId: record.recordId,
      }),
    );
    await this.s3Client.putDocument(document);

    // Step 4: Trigger targeted KB ingestion for this document
    const documentKey = documentPath ?? `documents/${record.recordId}.json`;
    const s3Uri = buildS3Uri(this.config.bucketName, documentKey);

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Triggering targeted KB ingestion",
        recordId: record.recordId,
        s3Uri,
      }),
    );
    const results = await this.bedrockClient.ingestDocuments([s3Uri]);

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Upsert completed successfully",
        recordId: record.recordId,
        ingestionStatus: results[0]?.status,
      }),
    );
  }

  /**
   * Handles delete events.
   *
   * Derives the document path directly from the webhook payload — no adapter
   * fetch is attempted. By the time Strapi fires the delete webhook the record
   * is already gone, so fetching it is both unreliable and unnecessary: the
   * payload always carries the entry data (slug/title/name) needed to build
   * the correct S3 key.
   *
   * Path resolution priority:
   *   1. payload.data.slug           → documents/{collection}/{slug}.json
   *   2. payload.data.title (slugified) → documents/{collection}/{slug}.json
   *   3. payload.data.name (slugified)  → documents/{collection}/{slug}.json
   *   4. payload.recordId (fallback)    → documents/{recordId}.json
   *
   * Steps:
   *   1. Derive document path from payload
   *   2. Remove from S3
   *   3. Delete from Bedrock KB
   *
   * Requirements: 2.1, 2.4, 6.4, 6.5
   */
  private async handleDelete(payload: WebhookPayload): Promise<void> {
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Handling delete event",
        recordId: payload.recordId,
        collection: this.config.sourceType,
        hasPayloadData: !!payload.data,
      }),
    );

    // Derive document path directly from webhook payload data.
    // No adapter fetch — the record is already deleted from Strapi by this point.
    let documentPath: string | undefined;

    if (payload.data) {
      const collection = this.config.sourceType;
      const slug = payload.data.slug as string | undefined;
      const title = payload.data.title as string | undefined;
      const name = payload.data.name as string | undefined;

      let filename: string | undefined;
      if (slug && slug.length > 0) {
        filename = slug;
      } else if (title && title.length > 0) {
        filename = toSlug(title);
      } else if (name && name.length > 0) {
        filename = toSlug(name);
      }

      if (filename) {
        documentPath = `documents/${collection}/${filename}.json`;
      }

      console.log(
        JSON.stringify({
          level: "INFO",
          message: "Delete path derived from webhook payload",
          recordId: payload.recordId,
          collection,
          slug,
          title,
          name,
          derivedFilename: filename,
          documentPath: documentPath ?? "(none - falling back to recordId key)",
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          level: "WARN",
          message:
            "Delete webhook has no payload data - falling back to recordId key",
          recordId: payload.recordId,
        }),
      );
    }

    // Resolve the final document key
    const documentKey = documentPath ?? `documents/${payload.recordId}.json`;

    // Step 1: Remove from S3
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Deleting document from S3",
        recordId: payload.recordId,
        documentKey,
      }),
    );
    await this.s3Client.deleteDocument(payload.recordId, documentPath);

    // Step 2: Delete from Bedrock KB
    const s3Uri = buildS3Uri(this.config.bucketName, documentKey);

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Triggering targeted KB document deletion",
        recordId: payload.recordId,
        s3Uri,
      }),
    );

    try {
      const results = await this.bedrockClient.deleteDocuments([s3Uri]);

      console.log(
        JSON.stringify({
          level: "INFO",
          message: "Delete completed successfully",
          recordId: payload.recordId,
          documentKey,
          s3Uri,
          deletionStatus: results[0]?.status,
          deletionStatusReason: results[0]?.statusReason,
        }),
      );
    } catch (error) {
      // Do NOT roll back S3 deletion - document is already removed.
      // Next full sync will reconcile the KB vector store.
      console.log(
        JSON.stringify({
          level: "ERROR",
          message:
            "KB document deletion failed - S3 deletion already committed",
          recordId: payload.recordId,
          s3Uri,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
