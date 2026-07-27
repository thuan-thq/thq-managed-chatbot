/**
 * Analytics handler for the Admin Lambda.
 *
 * GET /admin/analytics - Returns chat usage analytics for a date range.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnalyticsReport {
  clientId: string;
  dateRange: {
    startDate: string;
    endDate: string;
  };
  totalSessions: number;
  activeSessions: number;
  expiredSessions: number;
  exhaustedSessions: number;
  totalTurns: number;
  totalTokensUsed: number;
  averageTurnsPerSession: number;
  averageTokensPerSession: number;
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

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * GET /admin/analytics
 * Queries DynamoDB Sessions table for basic analytics over a date range.
 * Query params: startDate (ISO 8601), endDate (ISO 8601)
 */
export async function handleGetAnalytics(
  clientId: string,
  tableName: string,
  queryParams?: Record<string, string | undefined>,
): Promise<LambdaResponse> {
  const now = new Date();
  const startDate =
    queryParams?.startDate ??
    new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const endDate = queryParams?.endDate ?? now.toISOString();

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Fetching analytics",
      clientId,
      startDate,
      endDate,
    }),
  );

  try {
    // Scan for session metadata items within the date range
    // Filter: PK begins_with SESSION# and SK = META and createdAt within range
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          "begins_with(PK, :sessionPrefix) AND SK = :meta AND clientId = :clientId AND createdAt BETWEEN :startDate AND :endDate",
        ExpressionAttributeValues: {
          ":sessionPrefix": "SESSION#",
          ":meta": "META",
          ":clientId": clientId,
          ":startDate": startDate,
          ":endDate": endDate,
        },
      }),
    );

    const items = result.Items ?? [];

    let totalTurns = 0;
    let totalTokensUsed = 0;
    let activeSessions = 0;
    let expiredSessions = 0;
    let exhaustedSessions = 0;

    for (const item of items) {
      totalTurns += (item.turnCount as number) ?? 0;
      totalTokensUsed += (item.tokensUsed as number) ?? 0;

      const status = item.status as string;
      if (status === "active") activeSessions++;
      else if (status === "expired") expiredSessions++;
      else if (status === "exhausted") exhaustedSessions++;
    }

    const totalSessions = items.length;

    const report: AnalyticsReport = {
      clientId,
      dateRange: { startDate, endDate },
      totalSessions,
      activeSessions,
      expiredSessions,
      exhaustedSessions,
      totalTurns,
      totalTokensUsed,
      averageTurnsPerSession:
        totalSessions > 0 ? Math.round(totalTurns / totalSessions) : 0,
      averageTokensPerSession:
        totalSessions > 0 ? Math.round(totalTokensUsed / totalSessions) : 0,
    };

    return jsonResponse(200, report as unknown as Record<string, unknown>);
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Failed to fetch analytics",
        clientId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonResponse(500, { message: "Failed to fetch analytics" });
  }
}
