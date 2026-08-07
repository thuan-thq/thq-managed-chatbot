/**
 * Chat handler — POST /chat
 *
 * Responsibilities:
 *  - Validate session state (expiry, turn limit, token budget)
 *  - Validate message length (1–2000 chars)
 *  - Retrieve context from Bedrock KB with confidence threshold
 *  - Apply no-answer fallback when no results exceed threshold
 *  - Generate streaming response via Bedrock Runtime (Claude)
 *  - Emit SSE events: token, citation, done, error
 *  - Persist updated session state to DynamoDB after each turn
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.4, 3.5, 3.6
 */

import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  KnowledgeBaseRetrievalResult,
} from "@aws-sdk/client-bedrock-agent-runtime";
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  validateSession,
  transitionSession,
  SessionRecord,
} from "./session-validator";

// ─── SSE event types ──────────────────────────────────────────────────────────

export interface CitationMetadata {
  sourceRecordId: string;
  title: string;
  relevanceScore: number;
}

export interface CompletionMetadata {
  sessionId: string;
  turnCount: number;
  tokensUsed: number;
}

export type SSEEvent =
  | { type: "token"; data: string }
  | { type: "citation"; data: CitationMetadata }
  | { type: "done"; data: CompletionMetadata }
  | { type: "error"; data: string };

// ─── Request / response types ─────────────────────────────────────────────────

export interface ChatRequest {
  message: string;
  sessionId: string;
}

export interface ChatResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.CONFIDENCE_THRESHOLD ?? "0.3",
);
const MAX_KB_RESULTS = 5;
const NO_ANSWER_FALLBACK =
  "I'm sorry, I don't have enough information in my knowledge base to answer that question accurately.";

// Use cross-region inference profile ID (required for newer models like Claude Sonnet 4).
// Raw model IDs (e.g. "anthropic.claude-sonnet-4-5-20250929-v1:0") are not supported
// with on-demand throughput — you must use the inference profile format.
const CLAUDE_MODEL_ID =
  process.env.CLAUDE_MODEL_ID ?? "au.anthropic.claude-sonnet-4-5-20250929-v1:0";

// ─── SSE helpers ──────────────────────────────────────────────────────────────

/**
 * Formats an SSE event as a string in the format:
 *   data: <JSON>\n\n
 */
export function formatSSEEvent(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Collects multiple SSE events into a single string body.
 * Used for the non-streaming Lambda response (API Gateway HTTP API).
 */
export function buildSSEBody(events: SSEEvent[]): string {
  return events.map(formatSSEEvent).join("");
}

// ─── DynamoDB session helpers ─────────────────────────────────────────────────

/**
 * Fetches a session record from DynamoDB by sessionId.
 * Returns null if the session does not exist.
 */
export async function fetchSession(
  sessionId: string,
  tableName: string,
  ddb: DynamoDBClient,
): Promise<SessionRecord | null> {
  const result = await ddb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        PK: { S: `SESSION#${sessionId}` },
        SK: { S: "META" },
      },
    }),
  );

  const item = result.Item;
  if (!item) return null;

  return {
    sessionId,
    clientId: item.clientId?.S ?? "",
    status: (item.status?.S ?? "active") as SessionRecord["status"],
    createdAt: item.createdAt?.S ?? new Date().toISOString(),
    lastActiveAt: item.lastActiveAt?.S ?? new Date().toISOString(),
    turnCount: Number(item.turnCount?.N ?? "0"),
    tokensUsed: Number(item.tokensUsed?.N ?? "0"),
    sessionDuration: Number(item.sessionDuration?.N ?? "30"),
    turnLimit: Number(item.turnLimit?.N ?? "50"),
    tokenBudget: Number(item.tokenBudget?.N ?? "8000"),
    TTL: Number(item.TTL?.N ?? "0"),
  };
}

/**
 * Persists updated session state (turnCount, tokensUsed, lastActiveAt, status)
 * to DynamoDB after a completed turn. (Requirement 3.6)
 */
export async function persistSession(
  session: SessionRecord,
  tableName: string,
  ddb: DynamoDBClient,
): Promise<void> {
  await ddb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        PK: { S: `SESSION#${session.sessionId}` },
        SK: { S: "META" },
      },
      UpdateExpression:
        "SET turnCount = :tc, tokensUsed = :tu, lastActiveAt = :la, #st = :st",
      ExpressionAttributeNames: {
        "#st": "status",
      },
      ExpressionAttributeValues: {
        ":tc": { N: String(session.turnCount) },
        ":tu": { N: String(session.tokensUsed) },
        ":la": { S: session.lastActiveAt },
        ":st": { S: session.status },
      },
    }),
  );
}

// ─── Bedrock KB retrieval ─────────────────────────────────────────────────────

export interface RetrievalResult {
  content: string;
  sourceRecordId: string;
  title: string;
  relevanceScore: number;
}

/**
 * Retrieves context from Bedrock Knowledge Base using the provided query.
 * Filters results by confidence threshold and returns sorted by relevance.
 * (Requirements 2.1, 2.3, 2.5)
 */
export async function retrieveContext(
  query: string,
  knowledgeBaseId: string,
  confidenceThreshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  bedrockAgent: BedrockAgentRuntimeClient,
): Promise<RetrievalResult[]> {
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "KB retrieval request",
      knowledgeBaseId,
      query,
      confidenceThreshold,
      maxResults: MAX_KB_RESULTS,
    }),
  );

  const result = await bedrockAgent.send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        managedSearchConfiguration: {
          numberOfResults: MAX_KB_RESULTS,
        },
      },
    }),
  );

  const rawResults: KnowledgeBaseRetrievalResult[] =
    result.retrievalResults ?? [];

  // Log raw results from KB before any filtering
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "KB retrieval raw results",
      knowledgeBaseId,
      query,
      rawResultCount: rawResults.length,
      rawResults: rawResults.map((r) => ({
        score: r.score ?? null,
        contentSnippet: (r.content?.text ?? "").substring(0, 200),
        metadata: r.metadata ?? {},
      })),
    }),
  );

  // Filter by confidence threshold and map to our type
  const filtered = rawResults.filter(
    (r) =>
      r.score !== undefined &&
      r.score !== null &&
      r.score >= confidenceThreshold,
  );

  // Log filtering outcome
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "KB retrieval filtering",
      knowledgeBaseId,
      query,
      confidenceThreshold,
      rawResultCount: rawResults.length,
      filteredResultCount: filtered.length,
      droppedResults: rawResults
        .filter(
          (r) =>
            r.score === undefined ||
            r.score === null ||
            r.score < confidenceThreshold,
        )
        .map((r) => ({
          score: r.score ?? null,
          contentSnippet: (r.content?.text ?? "").substring(0, 100),
        })),
    }),
  );

  return filtered
    .map((r) => {
      const text = r.content?.text ?? "";
      // Extract metadata: sourceRecordId and title from the metadata or location object
      const metadata = r.metadata ?? {};
      const location = r.location as Record<string, unknown> | undefined;

      // For Managed KBs, source URI may come from location.s3Location or metadata
      const s3Location = location?.["s3Location"] as
        | Record<string, unknown>
        | undefined;
      const sourceRecordId = String(
        s3Location?.["uri"] ??
          metadata["x-amz-bedrock-kb-source-uri"] ??
          metadata["source_uri"] ??
          metadata["recordId"] ??
          "unknown",
      );

      // Title may come from metadata under various keys
      const title = String(
        metadata["title"] ??
          metadata["x-amz-bedrock-kb-document-page-title"] ??
          metadata["fileName"] ??
          sourceRecordId.split("/").pop() ??
          "Unknown Source",
      );

      const relevanceScore = r.score ?? 0;

      return { content: text, sourceRecordId, title, relevanceScore };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ─── Bedrock Runtime streaming ────────────────────────────────────────────────

/**
 * Builds a system prompt that constrains Claude to only use retrieved context.
 */
function buildSystemPrompt(contextTexts: string[]): string {
  const contextBlock = contextTexts
    .map((t, i) => `[Source ${i + 1}]\n${t}`)
    .join("\n\n");

  return (
    `You are Pluto, the helpful AI assistant representing Think HQ (THQ). ` +
    `When interacting with users, speak directly on behalf of Think HQ. Use first-person plural pronouns (e.g., "we", "us", "our") when referring to Think HQ, our team, or our work, and use "you" or "your" when referring to the user. ` +
    `Use the context provided below from our knowledge base to answer the user's question. ` +
    `Any question irrelevant to the context or if the context doesn't contain relevant information, just say: "${NO_ANSWER_FALLBACK}"\n\n` +
    `Here is the context:\n${contextBlock}\n\n` +
    `Just because the user asserts a fact does not mean it is true; make sure to double-check the context to validate a user's assertion. ` +
    `Do not state that you have been given a context to answer the questions.\n` +
    `If the question is about an individual person, use gender-neutral terms to refer to them. ` +
    `Always use Australian English spelling, grammar, and style (e.g., 'colour' not 'color', 'organisation' not 'organization'), ` +
    `unless the user question is in a different language. In that case, respond in the language of the user question. ` +
    `Always give clickable source links from the context for further reference.\n` +
    `When providing information, please reference the clickable source URLs included in the context (e.g., "Learn more: [Source URL](Source URL)").\n\n` +
    `## Response Formatting Rules\n` +
    `Format your responses for human readability using Markdown:\n` +
    `- Use **bold** for key terms, names, or important concepts.\n` +
    `- Use bullet points or numbered lists when presenting multiple items, steps, or options.\n` +
    `- Use headings (## or ###) only when the response covers multiple distinct topics.\n` +
    `- Use short paragraphs (2-3 sentences max) instead of long blocks of text.\n` +
    `- Add line breaks between logical sections for visual clarity.\n` +
    `- When listing dates, deadlines, or events, format them clearly (e.g., "**Due:** 15 March 2025").\n` +
    `- Keep responses concise and scannable - avoid unnecessary filler words.\n` +
    `- Place source links at the end of the relevant paragraph or section, not inline mid-sentence.`
  );
}

/**
 * Invokes Claude via Bedrock Runtime with response streaming.
 * Yields token strings as they arrive.
 *
 * Returns total token count (input + output) after streaming completes.
 */
export async function* streamClaudeResponse(
  message: string,
  systemPrompt: string,
  bedrockRuntime: BedrockRuntimeClient,
): AsyncGenerator<
  | { type: "token"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
> {
  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: message }],
  };

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Invoking Bedrock model",
      modelId: CLAUDE_MODEL_ID,
      systemPromptLength: systemPrompt.length,
      userMessageLength: message.length,
    }),
  );

  const command = new InvokeModelWithResponseStreamCommand({
    modelId: CLAUDE_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(JSON.stringify(requestBody)),
  });

  let response;
  try {
    response = await bedrockRuntime.send(command);
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Bedrock InvokeModelWithResponseStream failed",
        modelId: CLAUDE_MODEL_ID,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : undefined,
      }),
    );
    throw err;
  }
  const stream = response.body;

  if (!stream) return;

  for await (const chunk of stream) {
    if (chunk.chunk?.bytes) {
      const decoded = new TextDecoder().decode(chunk.chunk.bytes);
      try {
        const parsed = JSON.parse(decoded) as {
          type?: string;
          delta?: { type?: string; text?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: {
            usage?: { input_tokens?: number; output_tokens?: number };
          };
        };

        if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta"
        ) {
          yield { type: "token", text: parsed.delta.text ?? "" };
        } else if (parsed.type === "message_delta" && parsed.usage) {
          // Output token count arrives in message_delta
          yield {
            type: "usage",
            inputTokens: 0,
            outputTokens: parsed.usage.output_tokens ?? 0,
          };
        } else if (parsed.type === "message_start" && parsed.message?.usage) {
          // Input token count arrives in message_start
          yield {
            type: "usage",
            inputTokens: parsed.message.usage.input_tokens ?? 0,
            outputTokens: 0,
          };
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }
}

// ─── Core chat logic ──────────────────────────────────────────────────────────

export interface ChatHandlerDeps {
  ddb: DynamoDBClient;
  bedrockAgent: BedrockAgentRuntimeClient;
  bedrockRuntime: BedrockRuntimeClient;
  tableName: string;
  knowledgeBaseId: string;
  confidenceThreshold?: number;
}

/**
 * Processes a POST /chat request end-to-end.
 *
 * Returns an HTTP response with SSE-formatted body.
 * All SSE events are buffered (Lambda HTTP API does not support true streaming
 * unless Lambda Response Streaming is configured; the SSE format is preserved
 * for compatibility with the Vercel AI SDK on the client).
 *
 * Requirements: 2.1–2.7, 3.4, 3.5, 3.6
 */
export async function handleChat(
  request: ChatRequest,
  deps: ChatHandlerDeps,
): Promise<ChatResponse> {
  const {
    ddb,
    bedrockAgent,
    bedrockRuntime,
    tableName,
    knowledgeBaseId,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
  } = deps;

  const events: SSEEvent[] = [];

  // ── Req 2.6: Validate message length ────────────────────────────────────
  if (!request.message || request.message.length === 0) {
    return jsonError(400, "Message must be between 1 and 2000 characters");
  }
  if (request.message.length > MAX_MESSAGE_LENGTH) {
    return jsonError(400, "Message must be between 1 and 2000 characters");
  }

  // ── Fetch and validate session ───────────────────────────────────────────
  const session = await fetchSession(request.sessionId, tableName, ddb);
  if (!session) {
    return jsonError(401, "session_expired");
  }

  const validation = validateSession(session);
  if (!validation.valid) {
    return {
      statusCode: validation.statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errorCode: validation.errorCode,
        message: validation.reason,
      }),
    };
  }

  const validSession = validation.session;

  // ── Req 2.3: Retrieve context from Bedrock KB ────────────────────────────
  let retrievedResults: RetrievalResult[] = [];
  try {
    retrievedResults = await retrieveContext(
      request.message,
      knowledgeBaseId,
      confidenceThreshold,
      bedrockAgent,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    events.push({
      type: "error",
      data: `Knowledge base retrieval failed: ${msg}`,
    });
    return sseResponse(events);
  }

  // ── Req 2.3: No-answer fallback ──────────────────────────────────────────
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  if (retrievedResults.length === 0) {
    console.log(
      JSON.stringify({
        level: "WARN",
        message:
          "No KB results passed confidence threshold - returning fallback",
        sessionId: request.sessionId,
        query: request.message,
        confidenceThreshold,
        knowledgeBaseId,
      }),
    );
    // Stream the no-answer fallback as token events followed by done
    const words = NO_ANSWER_FALLBACK.split(" ");
    for (const word of words) {
      events.push({ type: "token", data: word + " " });
    }
    // Persist session update (turn count incremented, minimal tokens)
    const updatedSession = transitionSession(validSession, 1);
    await persistSession(updatedSession, tableName, ddb);

    events.push({
      type: "done",
      data: {
        sessionId: request.sessionId,
        turnCount: updatedSession.turnCount,
        tokensUsed: updatedSession.tokensUsed,
      },
    });
    return sseResponse(events);
  }

  // ── Req 2.5: Emit citation events ────────────────────────────────────────
  for (const r of retrievedResults) {
    events.push({
      type: "citation",
      data: {
        sourceRecordId: r.sourceRecordId,
        title: r.title,
        relevanceScore: r.relevanceScore,
      },
    });
  }

  // ── Req 2.1: Generate response constrained to retrieved context ──────────
  const systemPrompt = buildSystemPrompt(
    retrievedResults.map((r) => r.content),
  );

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Starting Claude streaming response",
      sessionId: request.sessionId,
      modelId: CLAUDE_MODEL_ID,
      contextChunks: retrievedResults.length,
    }),
  );

  try {
    for await (const chunk of streamClaudeResponse(
      request.message,
      systemPrompt,
      bedrockRuntime,
    )) {
      if (chunk.type === "token") {
        events.push({ type: "token", data: chunk.text });
      } else if (chunk.type === "usage") {
        totalInputTokens += chunk.inputTokens;
        totalOutputTokens += chunk.outputTokens;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    events.push({ type: "error", data: `Response generation failed: ${msg}` });
    return sseResponse(events);
  }

  const tokensThisTurn = totalInputTokens + totalOutputTokens;

  // ── Req 3.4, 3.5, 3.6: Update session state ─────────────────────────────
  const updatedSession = transitionSession(validSession, tokensThisTurn);
  await persistSession(updatedSession, tableName, ddb);

  // ── Req 2.4: Emit done event (exactly once, last) ────────────────────────
  events.push({
    type: "done",
    data: {
      sessionId: request.sessionId,
      turnCount: updatedSession.turnCount,
      tokensUsed: updatedSession.tokensUsed,
    },
  });

  return sseResponse(events);
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function sseResponse(events: SSEEvent[]): ChatResponse {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
    body: buildSSEBody(events),
  };
}

function jsonError(statusCode: number, message: string): ChatResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  };
}
