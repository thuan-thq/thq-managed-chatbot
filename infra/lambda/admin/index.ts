/**
 * Admin Lambda handler.
 *
 * Routes:
 *   GET  /admin/config       - Get current configuration
 *   PUT  /admin/config       - Update configuration (with validation)
 *   GET  /admin/sync-status  - Get sync status
 *   POST /admin/sync/trigger - Trigger a sync
 *   GET  /admin/analytics    - Get analytics data
 *
 * Requirements: 10.4, 10.5
 */

import { handleGetConfig, handleUpdateConfig } from "./config-handler";
import { handleTriggerSync, handleGetSyncStatus } from "./sync-handler";
import { handleGetAnalytics } from "./analytics-handler";

// ─── API Gateway v2 event type (HTTP API payload format 2.0) ─────────────────

interface APIGatewayV2Event {
  routeKey?: string;
  rawPath?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
  pathParameters?: Record<string, string>;
  body?: string | null;
  headers?: Record<string, string>;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ─── Environment ─────────────────────────────────────────────────────────────

const CLIENT_ID = process.env.CLIENT_ID ?? "";
const SESSIONS_TABLE_NAME = process.env.SESSIONS_TABLE_NAME ?? "";

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayV2Event,
): Promise<LambdaResponse> => {
  const method = event.requestContext?.http?.method ?? "";
  const path = event.requestContext?.http?.path ?? "";

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Admin Lambda invoked",
      routeKey: event.routeKey,
      method,
      path,
      clientId: CLIENT_ID,
    }),
  );

  if (!CLIENT_ID) {
    return jsonResponse(500, {
      message: "CLIENT_ID environment variable not configured",
    });
  }

  if (!SESSIONS_TABLE_NAME) {
    return jsonResponse(500, {
      message: "SESSIONS_TABLE_NAME environment variable not configured",
    });
  }

  // GET /admin/config
  if (method === "GET" && path === "/admin/config") {
    return handleGetConfig(CLIENT_ID);
  }

  // PUT /admin/config
  if (method === "PUT" && path === "/admin/config") {
    return handleUpdateConfig(CLIENT_ID, event.body);
  }

  // POST /admin/sync/trigger
  if (method === "POST" && path === "/admin/sync/trigger") {
    return handleTriggerSync(CLIENT_ID, SESSIONS_TABLE_NAME, event.body);
  }

  // GET /admin/sync-status
  if (method === "GET" && path === "/admin/sync-status") {
    return handleGetSyncStatus(
      CLIENT_ID,
      SESSIONS_TABLE_NAME,
      event.queryStringParameters,
    );
  }

  // GET /admin/analytics
  if (method === "GET" && path === "/admin/analytics") {
    return handleGetAnalytics(
      CLIENT_ID,
      SESSIONS_TABLE_NAME,
      event.queryStringParameters,
    );
  }

  return jsonResponse(404, { message: "Not found" });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
