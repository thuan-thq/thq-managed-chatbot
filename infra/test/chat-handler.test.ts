/**
 * Tests for the Chat Lambda handler (task 3.1).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.4, 3.5, 3.6
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  handleChat,
  fetchSession,
  persistSession,
  retrieveContext,
  formatSSEEvent,
  buildSSEBody,
  ChatHandlerDeps,
  SSEEvent,
} from "../lambda/chat/chat-handler";
import { SessionRecord } from "../lambda/chat/session-validator";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDdb(
  getResponse: unknown = null,
  updateResponse: unknown = {},
): DynamoDBClient {
  const client = Object.create(DynamoDBClient.prototype) as DynamoDBClient;
  let callCount = 0;
  (client as unknown as { send: (cmd: unknown) => Promise<unknown> }).send =
    jest.fn(async (cmd: unknown) => {
      const cmdName = (cmd as { constructor: { name: string } }).constructor
        .name;
      if (cmdName === "GetItemCommand") {
        return getResponse;
      }
      if (cmdName === "UpdateItemCommand") {
        callCount++;
        return updateResponse;
      }
      return {};
    });
  return client;
}

function makeActiveSession(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId: "sess-test-123",
    clientId: "test-client",
    status: "active",
    createdAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    lastActiveAt: new Date().toISOString(),
    turnCount: 0,
    tokensUsed: 0,
    sessionDuration: 30,
    turnLimit: 50,
    tokenBudget: 8000,
    TTL: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    ...overrides,
  };
}

function makeDdbItemResponse(session: SessionRecord): {
  Item: Record<string, { S?: string; N?: string }>;
} {
  return {
    Item: {
      PK: { S: `SESSION#${session.sessionId}` },
      SK: { S: "META" },
      clientId: { S: session.clientId },
      status: { S: session.status },
      createdAt: { S: session.createdAt },
      lastActiveAt: { S: session.lastActiveAt },
      turnCount: { N: String(session.turnCount) },
      tokensUsed: { N: String(session.tokensUsed) },
      sessionDuration: { N: String(session.sessionDuration) },
      turnLimit: { N: String(session.turnLimit) },
      tokenBudget: { N: String(session.tokenBudget) },
      TTL: { N: String(session.TTL) },
    },
  };
}

function makeMockBedrockAgent(
  results: {
    score: number;
    text: string;
    sourceUri?: string;
    title?: string;
  }[] = [],
): BedrockAgentRuntimeClient {
  const client = Object.create(
    BedrockAgentRuntimeClient.prototype,
  ) as BedrockAgentRuntimeClient;
  (client as unknown as { send: (cmd: unknown) => Promise<unknown> }).send =
    jest.fn(async (_cmd: unknown) => ({
      retrievalResults: results.map((r) => ({
        score: r.score,
        content: { text: r.text },
        metadata: {
          "x-amz-bedrock-kb-source-uri": r.sourceUri ?? "s3://bucket/doc.json",
          title: r.title ?? "Test Document",
        },
      })),
    }));
  return client;
}

/**
 * Creates a mock Bedrock Runtime client that streams the given tokens.
 * Also emits a message_start (input tokens) and message_delta (output tokens).
 */
function makeMockBedrockRuntime(
  tokens: string[] = ["Hello", " world"],
): BedrockRuntimeClient {
  const client = Object.create(
    BedrockRuntimeClient.prototype,
  ) as BedrockRuntimeClient;

  (client as unknown as { send: (cmd: unknown) => Promise<unknown> }).send =
    jest.fn(async (_cmd: unknown) => {
      async function* generateChunks() {
        // message_start with input tokens
        const startChunk = JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 10 } },
        });
        yield { chunk: { bytes: new TextEncoder().encode(startChunk) } };

        // token events
        for (const token of tokens) {
          const tokenChunk = JSON.stringify({
            type: "content_block_delta",
            delta: { type: "text_delta", text: token },
          });
          yield { chunk: { bytes: new TextEncoder().encode(tokenChunk) } };
        }

        // message_delta with output tokens
        const deltaChunk = JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: tokens.length * 2 },
        });
        yield { chunk: { bytes: new TextEncoder().encode(deltaChunk) } };
      }

      return { body: generateChunks() };
    });
  return client;
}

function makeDeps(
  session: SessionRecord | null,
  retrievalResults: {
    score: number;
    text: string;
    sourceUri?: string;
    title?: string;
  }[] = [],
  tokens: string[] = ["Hello", " world"],
  overrides: Partial<ChatHandlerDeps> = {},
): ChatHandlerDeps {
  const ddbResponse = session
    ? makeDdbItemResponse(session)
    : { Item: undefined };
  return {
    ddb: makeMockDdb(ddbResponse),
    bedrockAgent: makeMockBedrockAgent(retrievalResults),
    bedrockRuntime: makeMockBedrockRuntime(tokens),
    tableName: "SessionsTable",
    knowledgeBaseId: "kb-123",
    confidenceThreshold: 0.5,
    ...overrides,
  };
}

function parseSSEEvents(body: string): SSEEvent[] {
  return body
    .split("\n\n")
    .filter((s) => s.startsWith("data: "))
    .map((s) => JSON.parse(s.slice("data: ".length)) as SSEEvent);
}

// ─── formatSSEEvent / buildSSEBody ────────────────────────────────────────────

describe("formatSSEEvent()", () => {
  it("formats a token event correctly", () => {
    const evt: SSEEvent = { type: "token", data: "Hello" };
    expect(formatSSEEvent(evt)).toBe(
      'data: {"type":"token","data":"Hello"}\n\n',
    );
  });

  it("formats a done event correctly", () => {
    const evt: SSEEvent = {
      type: "done",
      data: { sessionId: "s1", turnCount: 1, tokensUsed: 50 },
    };
    const result = formatSSEEvent(evt);
    expect(result).toContain('"type":"done"');
    expect(result).toContain('"sessionId":"s1"');
    expect(result.endsWith("\n\n")).toBe(true);
  });

  it("formats an error event correctly", () => {
    const evt: SSEEvent = { type: "error", data: "something went wrong" };
    expect(formatSSEEvent(evt)).toContain('"type":"error"');
  });
});

describe("buildSSEBody()", () => {
  it("joins multiple events with double newlines", () => {
    const events: SSEEvent[] = [
      { type: "token", data: "Hi" },
      { type: "done", data: { sessionId: "s1", turnCount: 1, tokensUsed: 5 } },
    ];
    const body = buildSSEBody(events);
    const parsed = parseSSEEvents(body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("token");
    expect(parsed[1].type).toBe("done");
  });
});

// ─── fetchSession ─────────────────────────────────────────────────────────────

describe("fetchSession()", () => {
  it("returns null when DynamoDB returns no Item", async () => {
    const ddb = makeMockDdb({ Item: undefined });
    const result = await fetchSession("missing-id", "MyTable", ddb);
    expect(result).toBeNull();
  });

  it("maps DynamoDB Item attributes to a SessionRecord", async () => {
    const session = makeActiveSession();
    const ddb = makeMockDdb(makeDdbItemResponse(session));
    const result = await fetchSession(session.sessionId, "MyTable", ddb);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(session.sessionId);
    expect(result!.clientId).toBe(session.clientId);
    expect(result!.status).toBe("active");
    expect(result!.turnCount).toBe(0);
    expect(result!.tokensUsed).toBe(0);
  });
});

// ─── persistSession ───────────────────────────────────────────────────────────

describe("persistSession()", () => {
  it("calls DynamoDB UpdateItem with correct key and expressions", async () => {
    const updateCalls: unknown[] = [];
    const ddb = Object.create(DynamoDBClient.prototype) as DynamoDBClient;
    (ddb as unknown as { send: (cmd: unknown) => Promise<unknown> }).send =
      jest.fn(async (cmd: unknown) => {
        updateCalls.push(cmd);
        return {};
      });

    const session = makeActiveSession({ turnCount: 2, tokensUsed: 300 });
    await persistSession(session, "SessionsTable", ddb);

    expect(updateCalls).toHaveLength(1);
    const cmd = updateCalls[0] as {
      input: {
        Key: Record<string, { S?: string }>;
        ExpressionAttributeValues: Record<string, { N?: string; S?: string }>;
      };
    };
    expect(cmd.input.Key.PK.S).toBe(`SESSION#${session.sessionId}`);
    expect(cmd.input.ExpressionAttributeValues[":tc"].N).toBe("2");
    expect(cmd.input.ExpressionAttributeValues[":tu"].N).toBe("300");
  });
});

// ─── retrieveContext ──────────────────────────────────────────────────────────

describe("retrieveContext()", () => {
  it("returns results above confidence threshold", async () => {
    const agent = makeMockBedrockAgent([
      { score: 0.8, text: "Relevant content", title: "Doc A" },
      { score: 0.3, text: "Irrelevant", title: "Doc B" },
    ]);
    const results = await retrieveContext("query", "kb-123", 0.5, agent);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Relevant content");
    expect(results[0].relevanceScore).toBe(0.8);
  });

  it("returns empty array when all results are below threshold", async () => {
    const agent = makeMockBedrockAgent([{ score: 0.2, text: "Low relevance" }]);
    const results = await retrieveContext("query", "kb-123", 0.5, agent);
    expect(results).toHaveLength(0);
  });

  it("includes title and sourceRecordId in results", async () => {
    const agent = makeMockBedrockAgent([
      {
        score: 0.9,
        text: "Great answer",
        sourceUri: "s3://bucket/rec1.json",
        title: "Policy Doc",
      },
    ]);
    const results = await retrieveContext("query", "kb-123", 0.5, agent);
    expect(results[0].title).toBe("Policy Doc");
    expect(results[0].sourceRecordId).toBe("s3://bucket/rec1.json");
  });

  it("sorts results by relevance score descending", async () => {
    const agent = makeMockBedrockAgent([
      { score: 0.6, text: "Medium" },
      { score: 0.95, text: "High" },
      { score: 0.75, text: "High-medium" },
    ]);
    const results = await retrieveContext("query", "kb-123", 0.5, agent);
    expect(results[0].relevanceScore).toBe(0.95);
    expect(results[1].relevanceScore).toBe(0.75);
    expect(results[2].relevanceScore).toBe(0.6);
  });
});

// ─── handleChat — message validation (Req 2.6) ───────────────────────────────

describe("handleChat() — message validation (Req 2.6)", () => {
  it("returns 400 for empty message", async () => {
    const deps = makeDeps(makeActiveSession());
    const response = await handleChat(
      { message: "", sessionId: "sess-123" },
      deps,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("1 and 2000 characters");
  });

  it("returns 400 for message exceeding 2000 characters", async () => {
    const deps = makeDeps(makeActiveSession());
    const response = await handleChat(
      { message: "a".repeat(2001), sessionId: "sess-123" },
      deps,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("1 and 2000 characters");
  });

  it("accepts message of exactly 1 character", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, [{ score: 0.8, text: "Answer" }]);
    const response = await handleChat(
      { message: "Q", sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(200);
  });

  it("accepts message of exactly 2000 characters", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, [{ score: 0.8, text: "Answer" }]);
    const response = await handleChat(
      { message: "a".repeat(2000), sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(200);
  });
});

// ─── handleChat — session validation ─────────────────────────────────────────

describe("handleChat() — session validation", () => {
  it("returns 401 when session does not exist", async () => {
    const deps = makeDeps(null);
    const response = await handleChat(
      { message: "Hello", sessionId: "no-session" },
      deps,
    );
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 with session_expired for an expired session", async () => {
    const session = makeActiveSession({ status: "expired" });
    const deps = makeDeps(session);
    const response = await handleChat(
      { message: "Hello", sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("session_expired");
  });

  it("returns 401 with session_exhausted for an exhausted session", async () => {
    const session = makeActiveSession({ status: "exhausted" });
    const deps = makeDeps(session);
    const response = await handleChat(
      { message: "Hello", sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("session_exhausted");
  });

  it("returns 401 when duration has elapsed", async () => {
    const session = makeActiveSession({
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      sessionDuration: 30,
    });
    const deps = makeDeps(session);
    const response = await handleChat(
      { message: "Hello", sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("session_expired");
  });
});

// ─── handleChat — no-answer fallback (Req 2.3) ───────────────────────────────

describe("handleChat() — no-answer fallback (Req 2.3)", () => {
  it("streams fallback message when KB returns no results above threshold", async () => {
    const session = makeActiveSession();
    // All results below threshold
    const deps = makeDeps(session, [{ score: 0.2, text: "Irrelevant" }]);
    const response = await handleChat(
      { message: "Who are you?", sessionId: session.sessionId },
      deps,
    );

    expect(response.statusCode).toBe(200);
    const events = parseSSEEvents(response.body);

    // Should have token events and a done event
    const tokenEvents = events.filter((e) => e.type === "token");
    const doneEvents = events.filter((e) => e.type === "done");
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(doneEvents).toHaveLength(1);

    // Last event must be done
    expect(events[events.length - 1].type).toBe("done");
  });

  it("streams fallback message when KB returns empty results", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, []);
    const response = await handleChat(
      { message: "Anything?", sessionId: session.sessionId },
      deps,
    );

    expect(response.statusCode).toBe(200);
    const events = parseSSEEvents(response.body);
    expect(events[events.length - 1].type).toBe("done");
  });
});

// ─── handleChat — SSE event sequence (Req 2.4) ───────────────────────────────

describe("handleChat() — SSE event sequence (Req 2.4)", () => {
  it("terminates with exactly one done event as the last event", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, [{ score: 0.8, text: "Answer context" }]);
    const response = await handleChat(
      { message: "Tell me something", sessionId: session.sessionId },
      deps,
    );

    expect(response.statusCode).toBe(200);
    const events = parseSSEEvents(response.body);

    const terminators = events.filter(
      (e) => e.type === "done" || e.type === "error",
    );
    expect(terminators).toHaveLength(1);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("emits token events before the done event", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(
      session,
      [{ score: 0.9, text: "Context" }],
      ["Hi", " there"],
    );
    const response = await handleChat(
      { message: "Hello", sessionId: session.sessionId },
      deps,
    );

    const events = parseSSEEvents(response.body);
    const lastIdx = events.length - 1;
    const tokensBefore = events
      .slice(0, lastIdx)
      .some((e) => e.type === "token");
    expect(tokensBefore).toBe(true);
    expect(events[lastIdx].type).toBe("done");
  });

  it("emits SSE with text/event-stream content type", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, [{ score: 0.8, text: "Answer" }]);
    const response = await handleChat(
      { message: "Q", sessionId: session.sessionId },
      deps,
    );

    expect(response.headers["Content-Type"]).toBe("text/event-stream");
  });
});

// ─── handleChat — citation events (Req 2.5) ──────────────────────────────────

describe("handleChat() — citation events (Req 2.5)", () => {
  it("emits citation events with sourceRecordId, title, and relevanceScore", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, [
      {
        score: 0.9,
        text: "Great answer",
        sourceUri: "s3://bucket/doc1.json",
        title: "Policy",
      },
    ]);
    const response = await handleChat(
      { message: "Query", sessionId: session.sessionId },
      deps,
    );

    const events = parseSSEEvents(response.body);
    const citations = events.filter((e) => e.type === "citation");
    expect(citations).toHaveLength(1);

    const citation = citations[0] as {
      type: "citation";
      data: { sourceRecordId: string; title: string; relevanceScore: number };
    };
    expect(citation.data.sourceRecordId).toBe("s3://bucket/doc1.json");
    expect(citation.data.title).toBe("Policy");
    expect(citation.data.relevanceScore).toBe(0.9);
  });

  it("emits multiple citation events for multiple results", async () => {
    const session = makeActiveSession();
    const deps = makeDeps(session, [
      { score: 0.9, text: "Doc 1 answer" },
      { score: 0.75, text: "Doc 2 answer" },
    ]);
    const response = await handleChat(
      { message: "Query", sessionId: session.sessionId },
      deps,
    );

    const events = parseSSEEvents(response.body);
    const citations = events.filter((e) => e.type === "citation");
    expect(citations).toHaveLength(2);
  });
});

// ─── handleChat — session state update (Req 3.6) ─────────────────────────────

describe("handleChat() — session state persistence (Req 3.6)", () => {
  it("calls DynamoDB update after a successful turn", async () => {
    const session = makeActiveSession();
    const updateCalls: unknown[] = [];
    const ddb = Object.create(DynamoDBClient.prototype) as DynamoDBClient;
    (ddb as unknown as { send: (cmd: unknown) => Promise<unknown> }).send =
      jest.fn(async (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "GetItemCommand") return makeDdbItemResponse(session);
        if (name === "UpdateItemCommand") {
          updateCalls.push(cmd);
          return {};
        }
        return {};
      });

    const deps: ChatHandlerDeps = {
      ddb,
      bedrockAgent: makeMockBedrockAgent([{ score: 0.8, text: "Answer" }]),
      bedrockRuntime: makeMockBedrockRuntime(["Hi"]),
      tableName: "SessionsTable",
      knowledgeBaseId: "kb-123",
    };

    await handleChat({ message: "Hello", sessionId: session.sessionId }, deps);

    // At least one UpdateItem call should have been made
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("done event contains updated turnCount and tokensUsed", async () => {
    const session = makeActiveSession({ turnCount: 5, tokensUsed: 100 });
    const deps = makeDeps(
      session,
      [{ score: 0.8, text: "Context" }],
      ["Token1"],
    );
    const response = await handleChat(
      { message: "Hello", sessionId: session.sessionId },
      deps,
    );

    const events = parseSSEEvents(response.body);
    const doneEvent = events.find((e) => e.type === "done") as
      | {
          type: "done";
          data: { sessionId: string; turnCount: number; tokensUsed: number };
        }
      | undefined;
    expect(doneEvent).toBeDefined();
    // Turn count should be incremented by 1
    expect(doneEvent!.data.turnCount).toBe(6);
  });
});

// ─── handleChat — Req 3.4 token budget enforcement ────────────────────────────

describe("handleChat() — token budget enforcement (Req 3.4)", () => {
  it("session transitions to exhausted when tokens exceed budget", async () => {
    // Near-exhausted session: tokensUsed is just below tokenBudget
    const session = makeActiveSession({
      turnCount: 5,
      tokensUsed: 7999,
      tokenBudget: 8000,
    });

    const updateCalls: Array<{
      input: { ExpressionAttributeValues: Record<string, { S?: string }> };
    }> = [];
    const ddb = Object.create(DynamoDBClient.prototype) as DynamoDBClient;
    (ddb as unknown as { send: (cmd: unknown) => Promise<unknown> }).send =
      jest.fn(async (cmd: unknown) => {
        const name = (cmd as { constructor: { name: string } }).constructor
          .name;
        if (name === "GetItemCommand") return makeDdbItemResponse(session);
        if (name === "UpdateItemCommand") {
          updateCalls.push(cmd as (typeof updateCalls)[0]);
          return {};
        }
        return {};
      });

    const deps: ChatHandlerDeps = {
      ddb,
      bedrockAgent: makeMockBedrockAgent([{ score: 0.8, text: "Answer" }]),
      // 1 token output → tokensUsed becomes 8000 (at budget)
      bedrockRuntime: makeMockBedrockRuntime(["Hi"]),
      tableName: "SessionsTable",
      knowledgeBaseId: "kb-123",
    };

    const response = await handleChat(
      { message: "Last msg", sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(200);

    // The session status persisted should be exhausted
    const lastUpdate = updateCalls[updateCalls.length - 1];
    const statusValue =
      lastUpdate?.input?.ExpressionAttributeValues?.[":st"]?.S;
    expect(statusValue).toBe("exhausted");
  });
});

// ─── handleChat — Req 3.5 turn limit enforcement ─────────────────────────────

describe("handleChat() — turn limit enforcement (Req 3.5)", () => {
  it("rejects request when turn limit is already reached", async () => {
    const session = makeActiveSession({ turnCount: 50, turnLimit: 50 });
    const deps = makeDeps(session);
    const response = await handleChat(
      { message: "One more?", sessionId: session.sessionId },
      deps,
    );
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("session_exhausted");
  });
});
