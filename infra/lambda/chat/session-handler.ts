import { randomBytes } from "crypto";
import {
  DynamoDBClient,
  PutItemCommand,
  PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionCreationOptions {
  /** Requested session duration in minutes (clamped to 1–120, default 30). */
  sessionDuration?: number;
  /** Max turns allowed (default 50). */
  turnLimit?: number;
  /** Max tokens allowed (default 8000). */
  tokenBudget?: number;
}

export interface CreateSessionResult {
  sessionId: string;
  token: string;
}

/** Minimal API Gateway event shape needed for POST /session */
export interface SessionCreateEvent {
  requestContext?: {
    authorizer?: {
      lambda?: {
        clientId?: string;
      };
    };
  };
  body?: string | null;
}

/** Minimal API Gateway response */
export interface SessionCreateResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSION_DURATION_MIN = 1;
const SESSION_DURATION_MAX = 120;
const DEFAULT_DURATION = 30;
const DEFAULT_TURN_LIMIT = 50;
const DEFAULT_TOKEN_BUDGET = 8000;
/** DynamoDB TTL: 7 days from now in seconds */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// ─── Token generation ─────────────────────────────────────────────────────────

/**
 * Generates a 256-bit (32-byte) cryptographically random session token
 * encoded as a 64-character hex string.  Satisfies the ≥128-bit requirement.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

// ─── Duration clamping ────────────────────────────────────────────────────────

/**
 * Clamps the requested session duration to the allowed 1–120 minute range.
 * Falls back to the default (30) if no value is supplied.
 */
export function clampSessionDuration(requested?: number): number {
  const value = requested ?? DEFAULT_DURATION;
  return Math.max(SESSION_DURATION_MIN, Math.min(SESSION_DURATION_MAX, value));
}

// ─── DynamoDB write ───────────────────────────────────────────────────────────

/**
 * Writes a new session item to DynamoDB and returns the generated
 * sessionId and token.
 */
export async function createSession(
  clientId: string,
  options: SessionCreationOptions,
  ddbClient: DynamoDBClient,
  tableName: string,
  nowDate?: Date,
): Promise<CreateSessionResult> {
  const sessionId = generateSessionToken(); // use a separate token as the ID
  const token = generateSessionToken();
  const now = nowDate ?? new Date();
  const isoNow = now.toISOString();
  const ttlEpoch = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const sessionDuration = clampSessionDuration(options.sessionDuration);
  const turnLimit = options.turnLimit ?? DEFAULT_TURN_LIMIT;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  const item: PutItemCommandInput = {
    TableName: tableName,
    Item: {
      PK: { S: `SESSION#${sessionId}` },
      SK: { S: "META" },
      clientId: { S: clientId },
      status: { S: "active" },
      turnCount: { N: "0" },
      tokensUsed: { N: "0" },
      createdAt: { S: isoNow },
      lastActiveAt: { S: isoNow },
      sessionDuration: { N: String(sessionDuration) },
      turnLimit: { N: String(turnLimit) },
      tokenBudget: { N: String(tokenBudget) },
      TTL: { N: String(ttlEpoch) },
    },
  };

  await ddbClient.send(new PutItemCommand(item));

  return { sessionId, token };
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

let _ddbClient: DynamoDBClient | null = null;
function getDdbClient(): DynamoDBClient {
  if (!_ddbClient) {
    _ddbClient = new DynamoDBClient({});
  }
  return _ddbClient;
}

/**
 * Lambda handler for POST /session.
 *
 * Creates a new chat session and returns:
 *   201 { sessionId, token }
 */
export const handler = async (
  event: SessionCreateEvent,
): Promise<SessionCreateResponse> => {
  const tableName = process.env.SESSIONS_TABLE_NAME;
  if (!tableName) {
    return errorResponse(
      500,
      "SESSIONS_TABLE_NAME environment variable is not set",
    );
  }

  // Derive clientId from authorizer context (set by the API Gateway authorizer)
  const clientId =
    event.requestContext?.authorizer?.lambda?.clientId ?? "unknown";

  // Parse optional body for session options
  let options: SessionCreationOptions = {};
  if (event.body) {
    try {
      options = JSON.parse(event.body) as SessionCreationOptions;
    } catch {
      return errorResponse(400, "Invalid request body — expected JSON");
    }
  }

  try {
    const result = await createSession(
      clientId,
      options,
      getDdbClient(),
      tableName,
    );

    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: result.sessionId,
        token: result.token,
      }),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Failed to create session: ${message}`);
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResponse(
  statusCode: number,
  message: string,
): SessionCreateResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  };
}
