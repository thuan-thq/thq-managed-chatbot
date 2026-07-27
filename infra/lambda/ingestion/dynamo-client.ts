/**
 * DynamoDB client wrapper for sync state operations.
 *
 * Provides typed get/update operations for the sync state record
 * stored in the Sessions table. Supports progress tracking and
 * resume capability for interrupted sync operations.
 *
 * Requirements: 4.2, 4.4, 4.6, 14.4
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Sync state status values. */
export type SyncStatus = "idle" | "running" | "failed";

/** The sync state record stored in DynamoDB. */
export interface SyncState {
  PK: string;
  SK: string;
  clientId: string;
  lastFullSync?: string;
  lastIncrementalSync?: string;
  checkpoint?: string;
  recordsIngested?: number;
  status: SyncStatus;
  lastError?: string;
  progressRecords?: number;
  totalRecords?: number;
  resumeToken?: string;
}

/** Fields that can be updated on the sync state record. */
export interface SyncStateUpdate {
  status?: SyncStatus;
  lastFullSync?: string;
  lastIncrementalSync?: string;
  checkpoint?: string;
  recordsIngested?: number;
  lastError?: string;
  progressRecords?: number;
  totalRecords?: number;
  resumeToken?: string;
}

// ─── DynamoDB Sync State Client ──────────────────────────────────────────────

export interface SyncStateClientConfig {
  /** The DynamoDB table name. */
  tableName: string;
  /** The client ID for this deployment. */
  clientId: string;
  /** Optional DynamoDB document client (for testing). */
  docClient?: DynamoDBDocumentClient;
}

/**
 * Wrapper for DynamoDB sync state operations.
 *
 * Sync state is stored with:
 * - PK: SYNC#{sourceType}
 * - SK: STATE
 */
export class SyncStateClient {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly clientId: string;

  constructor(config: SyncStateClientConfig) {
    this.docClient =
      config.docClient ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
    this.tableName = config.tableName;
    this.clientId = config.clientId;
  }

  /**
   * Gets the current sync state for a given source type.
   *
   * @param sourceType - The data source identifier (e.g. "strapi")
   * @returns The sync state record, or null if not found
   */
  async getSyncState(sourceType: string): Promise<SyncState | null> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `SYNC#${sourceType}`,
          SK: "STATE",
        },
      }),
    );

    return (result.Item as SyncState) ?? null;
  }

  /**
   * Updates the sync state for a given source type.
   *
   * Creates the record if it does not exist (upsert behavior).
   *
   * @param sourceType - The data source identifier (e.g. "strapi")
   * @param update - The fields to update
   */
  async updateSyncState(
    sourceType: string,
    update: SyncStateUpdate,
  ): Promise<void> {
    const expressionParts: string[] = [];
    const expressionNames: Record<string, string> = {};
    const expressionValues: Record<string, unknown> = {};

    // Always set clientId
    expressionParts.push("#clientId = :clientId");
    expressionNames["#clientId"] = "clientId";
    expressionValues[":clientId"] = this.clientId;

    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        const attrName = `#${key}`;
        const attrValue = `:${key}`;
        expressionParts.push(`${attrName} = ${attrValue}`);
        expressionNames[attrName] = key;
        expressionValues[attrValue] = value;
      }
    }

    // Handle clearing fields by removing them
    const removeFields: string[] = [];
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined && key in update) {
        // We use a special null sentinel - skip for now
      }
    }

    let updateExpression = `SET ${expressionParts.join(", ")}`;
    if (removeFields.length > 0) {
      updateExpression += ` REMOVE ${removeFields.join(", ")}`;
    }

    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: `SYNC#${sourceType}`,
          SK: "STATE",
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
      }),
    );
  }

  /**
   * Clears the resume token for a given source type.
   * Used on successful completion to indicate no resume needed.
   *
   * @param sourceType - The data source identifier
   */
  async clearResumeToken(sourceType: string): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: `SYNC#${sourceType}`,
          SK: "STATE",
        },
        UpdateExpression: "REMOVE #resumeToken",
        ExpressionAttributeNames: {
          "#resumeToken": "resumeToken",
        },
      }),
    );
  }
}
