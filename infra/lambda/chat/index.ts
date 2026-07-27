/**
 * Chat Lambda entry point.
 *
 * Routes:
 *   POST /chat               → handleChat  (task 3.1)
 *   POST /session            → session-handler.handler
 *   GET  /session/{sessionId}→ getSession  (returns current session status)
 */

import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { handleChat, ChatRequest } from "./chat-handler";
import { handler as sessionCreateHandler } from "./session-handler";
import { fetchSession } from "./chat-handler";

// ─── Singleton AWS clients (reused across warm invocations) ──────────────────

let _ddb: DynamoDBClient | null = null;
let _bedrockAgent: BedrockAgentRuntimeClient | null = null;
let _bedrockRuntime: BedrockRuntimeClient | null = null;

function getDdb(): DynamoDBClient {
  if (!_ddb) _ddb = new DynamoDBClient({});
  return _ddb;
}

function getBedrockAgent(): BedrockAgentRuntimeClient {
  if (!_bedrockAgent) _bedrockAgent = new BedrockAgentRuntimeClient({});
  return _bedrockAgent;
}

function getBedrockRuntime(): BedrockRuntimeClient {
  if (!_bedrockRuntime) _bedrockRuntime = new BedrockRuntimeClient({});
  return _bedrockRuntime;
}

// ─── API Gateway v2 event type (HTTP API payload format 2.0) ─────────────────

interface APIGatewayV2Event {
  routeKey?: string;
  rawPath?: string;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
    authorizer?: {
      lambda?: {
        clientId?: string;
      };
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

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayV2Event,
): Promise<LambdaResponse> => {
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Chat Lambda invoked",
      routeKey: event.routeKey,
      path: event.requestContext?.http?.path,
    }),
  );

  const routeKey = event.routeKey ?? "";
  const method = event.requestContext?.http?.method ?? "";
  const path = event.requestContext?.http?.path ?? "";

  // ── POST /session ─────────────────────────────────────────────────────────
  if (
    routeKey === "POST /session" ||
    (method === "POST" && path === "/session")
  ) {
    return sessionCreateHandler(event);
  }

  // ── GET /session/{sessionId} ──────────────────────────────────────────────
  if (
    routeKey.startsWith("GET /session/") ||
    (method === "GET" && path.startsWith("/session/"))
  ) {
    return handleGetSession(event);
  }

  // ── POST /chat ────────────────────────────────────────────────────────────
  if (routeKey === "POST /chat" || (method === "POST" && path === "/chat")) {
    return handleChatRequest(event);
  }

  // Unknown route
  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Not found" }),
  };
};

// ─── Chat handler ─────────────────────────────────────────────────────────────

async function handleChatRequest(
  event: APIGatewayV2Event,
): Promise<LambdaResponse> {
  const tableName = process.env.SESSIONS_TABLE_NAME;
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;

  if (!tableName) {
    return jsonError(
      500,
      "SESSIONS_TABLE_NAME environment variable is not set",
    );
  }
  if (!knowledgeBaseId) {
    return jsonError(500, "KNOWLEDGE_BASE_ID environment variable is not set");
  }

  // Parse body
  let parsed: Partial<ChatRequest> = {};
  if (event.body) {
    try {
      parsed = JSON.parse(event.body) as Partial<ChatRequest>;
    } catch {
      return jsonError(400, "Invalid request body — expected JSON");
    }
  }

  if (!parsed.sessionId) {
    return jsonError(400, "sessionId is required");
  }
  if (parsed.message === undefined || parsed.message === null) {
    return jsonError(400, "message is required");
  }

  return handleChat(
    { message: parsed.message, sessionId: parsed.sessionId },
    {
      ddb: getDdb(),
      bedrockAgent: getBedrockAgent(),
      bedrockRuntime: getBedrockRuntime(),
      tableName,
      knowledgeBaseId,
    },
  );
}

// ─── GET /session/{sessionId} handler ────────────────────────────────────────

async function handleGetSession(
  event: APIGatewayV2Event,
): Promise<LambdaResponse> {
  const tableName = process.env.SESSIONS_TABLE_NAME;
  if (!tableName) {
    return jsonError(
      500,
      "SESSIONS_TABLE_NAME environment variable is not set",
    );
  }

  // Extract sessionId from path parameters or parse from path
  const sessionId =
    event.pathParameters?.sessionId ??
    (event.requestContext?.http?.path ?? "").split("/session/")[1];

  if (!sessionId) {
    return jsonError(400, "sessionId path parameter is required");
  }

  try {
    const session = await fetchSession(sessionId, tableName, getDdb());
    if (!session) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          errorCode: "session_expired",
          message: "Session not found",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        status: session.status,
        turnCount: session.turnCount,
        tokensUsed: session.tokensUsed,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, `Failed to retrieve session: ${msg}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonError(statusCode: number, message: string): LambdaResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  };
}
