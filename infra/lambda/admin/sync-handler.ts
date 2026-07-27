/**
 * Sync trigger and status handler for the Admin Lambda.
 *
 * POST /admin/sync/trigger  - Triggers an async sync operation
 * GET  /admin/sync-status   - Returns sync state report
 */

import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AsyncOperationStatus {
  operationId: string;
  status: "pending" | "running" | "complete" | "failed";
  statusUrl: string;
  startedAt: string;
  completedAt?: string;
}

interface SyncStatusReport {
  sourceType: string;
  status: string;
  lastFullSync: string | null;
  lastIncrementalSync: string | null;
  checkpoint: string | null;
  recordsIngested: number;
  lastError: string | null;
  progressRecords: number;
  totalRecords: number;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ─── DynamoDB Client (reused across invocations) ─────────────────────────────

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): LambdaResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * POST /admin/sync/trigger
 * Creates a sync operation record in DynamoDB with status "pending".
 * Returns the operation ID and a status polling URL.
 */
export async function handleTriggerSync(
  clientId: string,
  tableName: string,
  body: string | null | undefined,
): Promise<LambdaResponse> {
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Triggering sync operation",
      clientId,
    }),
  );

  let sourceType = "strapi"; // default
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.sourceType && typeof parsed.sourceType === "string") {
        sourceType = parsed.sourceType;
      }
    } catch {
      return jsonResponse(400, { message: "Invalid JSON in request body" });
    }
  }

  const operationId = randomUUID();
  const startedAt = new Date().toISOString();

  try {
    // Write sync operation record to DynamoDB
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `SYNC#${sourceType}`,
          SK: `STATE`,
          clientId,
          status: "pending",
          operationId,
          startedAt,
          lastError: null,
          progressRecords: 0,
          totalRecords: 0,
        },
      }),
    );

    const result: AsyncOperationStatus = {
      operationId,
      status: "pending",
      statusUrl: "/admin/sync-status",
      startedAt,
    };

    return jsonResponse(202, result as unknown as Record<string, unknown>);
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Failed to trigger sync",
        clientId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonResponse(500, { message: "Failed to trigger sync operation" });
  }
}

/**
 * GET /admin/sync-status
 * Queries DynamoDB for sync state (PK=SYNC#{sourceType}, SK=STATE)
 * and returns a sync status report.
 */
export async function handleGetSyncStatus(
  clientId: string,
  tableName: string,
  queryParams?: Record<string, string | undefined>,
): Promise<LambdaResponse> {
  const sourceType = queryParams?.sourceType ?? "strapi";

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Fetching sync status",
      clientId,
      sourceType,
    }),
  );

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: {
          ":pk": `SYNC#${sourceType}`,
          ":sk": "STATE",
        },
      }),
    );

    if (!result.Items || result.Items.length === 0) {
      const emptyReport: SyncStatusReport = {
        sourceType,
        status: "idle",
        lastFullSync: null,
        lastIncrementalSync: null,
        checkpoint: null,
        recordsIngested: 0,
        lastError: null,
        progressRecords: 0,
        totalRecords: 0,
      };
      return jsonResponse(
        200,
        emptyReport as unknown as Record<string, unknown>,
      );
    }

    const item = result.Items[0];
    const report: SyncStatusReport = {
      sourceType,
      status: (item.status as string) ?? "idle",
      lastFullSync: (item.lastFullSync as string) ?? null,
      lastIncrementalSync: (item.lastIncrementalSync as string) ?? null,
      checkpoint: (item.checkpoint as string) ?? null,
      recordsIngested: (item.recordsIngested as number) ?? 0,
      lastError: (item.lastError as string) ?? null,
      progressRecords: (item.progressRecords as number) ?? 0,
      totalRecords: (item.totalRecords as number) ?? 0,
    };

    return jsonResponse(200, report as unknown as Record<string, unknown>);
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Failed to fetch sync status",
        clientId,
        sourceType,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonResponse(500, { message: "Failed to fetch sync status" });
  }
}
