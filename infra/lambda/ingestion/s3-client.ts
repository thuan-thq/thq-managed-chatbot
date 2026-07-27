/**
 * S3 client wrapper for content document operations.
 *
 * Provides typed PutObject and DeleteObject operations for persisting
 * and removing S3ContentDocument objects in the knowledge base bucket.
 *
 * Requirements: 4.1, 4.3, 6.4, 6.5
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { S3ContentDocument } from "./types";

// ─── S3 Content Client ───────────────────────────────────────────────────────

export interface S3ContentClientConfig {
  /** The S3 bucket name for content documents. */
  bucketName: string;
  /** Optional S3 client instance (for testing). */
  client?: S3Client;
}

/**
 * Wrapper around S3 for content document persistence.
 *
 * Documents are stored at: documents/{recordId}.json
 */
export class S3ContentClient {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(config: S3ContentClientConfig) {
    this.client = config.client ?? new S3Client({});
    this.bucketName = config.bucketName;
  }

  /**
   * Persists a content document to S3.
   *
   * Uses document.documentPath if provided, otherwise falls back to
   * documents/{recordId}.json for backwards compatibility.
   *
   * @param document - The S3ContentDocument to store
   */
  async putDocument(document: S3ContentDocument): Promise<void> {
    const key = document.documentPath ?? `documents/${document.recordId}.json`;

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "S3 PutObject",
        bucket: this.bucketName,
        key,
        recordId: document.recordId,
      }),
    );

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: JSON.stringify(document),
        ContentType: "application/json",
      }),
    );

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "S3 PutObject succeeded",
        bucket: this.bucketName,
        key,
        recordId: document.recordId,
      }),
    );
  }

  /**
   * Deletes a content document from S3.
   *
   * Uses documentPath if provided, otherwise falls back to
   * documents/{recordId}.json.
   *
   * @param recordId - The record ID whose document should be removed
   * @param documentPath - Optional S3 key path override
   */
  async deleteDocument(recordId: string, documentPath?: string): Promise<void> {
    const key = documentPath ?? `documents/${recordId}.json`;

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "S3 DeleteObject",
        bucket: this.bucketName,
        key,
        recordId,
      }),
    );

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "S3 DeleteObject succeeded",
        bucket: this.bucketName,
        key,
        recordId,
      }),
    );
  }

  /**
   * Lists all S3 object keys under a given prefix.
   *
   * Paginates automatically — returns every key regardless of how many
   * objects exist under the prefix.
   *
   * @param prefix - S3 key prefix to list (e.g. "documents/intranet-pages/")
   * @returns Array of fully-qualified S3 keys
   */
  async listDocumentKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      });

      const response = await this.client.send(command);

      for (const obj of response.Contents ?? []) {
        if (obj.Key) {
          keys.push(obj.Key);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }
}
