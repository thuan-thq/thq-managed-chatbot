/**
 * Streaming chat handler - Lambda Response Streaming entry point.
 *
 * Uses `awslambda.streamifyResponse` to stream SSE events to the client
 * in real-time as tokens arrive from Bedrock, rather than buffering the
 * entire response.
 *
 * This handler is deployed behind a Lambda Function URL with
 * InvokeMode: RESPONSE_STREAM.
 */

import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  ChatRequest,
  SSEEvent,
  formatSSEEvent,
  fetchSession,
  persistSession,
  retrieveContext,
  streamClaudeResponse,
  RetrievalResult,
} from "./chat-handler";
import { validateSession, transitionSession } from "./session-validator";

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

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.CONFIDENCE_THRESHOLD ?? "0.3",
);
const NO_ANSWER_FALLBACK =
  "I'm sorry, I don't have enough information in my knowledge base to answer that question accurately.";

// ─── Types for Lambda Response Streaming ─────────────────────────────────────

interface FunctionURLEvent {
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface ResponseStream {
  write(chunk: string | Uint8Array): void;
  end(): void;
  destroy(error?: Error): void;
  setContentType(contentType: string): void;
}

interface HttpResponseMetadata {
  statusCode: number;
  headers: Record<string, string>;
}

// Declare the global awslambda namespace provided by the Lambda runtime
declare const awslambda: {
  streamifyResponse(
    handler: (
      event: FunctionURLEvent,
      responseStream: ResponseStream,
      context: unknown,
    ) => Promise<void>,
  ): (event: FunctionURLEvent, context: unknown) => Promise<void>;
  HttpResponseStream: {
    from(
      responseStream: ResponseStream,
      metadata: HttpResponseMetadata,
    ): ResponseStream;
  };
};

// ─── Streaming handler ────────────────────────────────────────────────────────

export const handler = awslambda.streamifyResponse(
  async (
    event: FunctionURLEvent,
    responseStream: ResponseStream,
  ): Promise<void> => {
    const method = event.requestContext?.http?.method ?? "";
    const path = event.requestContext?.http?.path ?? "";

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Stream handler invoked",
        method,
        path,
      }),
    );

    // Only handle POST /chat - reject everything else
    if (method !== "POST") {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(JSON.stringify({ message: "Method not allowed" }));
      errorStream.end();
      return;
    }

    // Parse request body
    let parsed: Partial<ChatRequest> = {};
    if (event.body) {
      try {
        const body = event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf-8")
          : event.body;
        parsed = JSON.parse(body) as Partial<ChatRequest>;
      } catch {
        const errorStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
        });
        errorStream.write(
          JSON.stringify({ message: "Invalid request body - expected JSON" }),
        );
        errorStream.end();
        return;
      }
    }

    if (!parsed.sessionId) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(JSON.stringify({ message: "sessionId is required" }));
      errorStream.end();
      return;
    }

    if (parsed.message === undefined || parsed.message === null) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(JSON.stringify({ message: "message is required" }));
      errorStream.end();
      return;
    }

    const request: ChatRequest = {
      message: parsed.message,
      sessionId: parsed.sessionId,
    };

    const tableName = process.env.SESSIONS_TABLE_NAME;
    const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;

    if (!tableName || !knowledgeBaseId) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(
        JSON.stringify({ message: "Server configuration error" }),
      );
      errorStream.end();
      return;
    }

    // Validate message length
    if (!request.message || request.message.length === 0) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(
        JSON.stringify({
          message: "Message must be between 1 and 2000 characters",
        }),
      );
      errorStream.end();
      return;
    }

    if (request.message.length > MAX_MESSAGE_LENGTH) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(
        JSON.stringify({
          message: "Message must be between 1 and 2000 characters",
        }),
      );
      errorStream.end();
      return;
    }

    // Fetch and validate session
    const session = await fetchSession(request.sessionId, tableName, getDdb());
    if (!session) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(
        JSON.stringify({
          errorCode: "session_expired",
          message: "Session not found or expired",
        }),
      );
      errorStream.end();
      return;
    }

    const validation = validateSession(session);
    if (!validation.valid) {
      const errorStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: validation.statusCode,
        headers: { "Content-Type": "application/json" },
      });
      errorStream.write(
        JSON.stringify({
          errorCode: validation.errorCode,
          message: validation.reason,
        }),
      );
      errorStream.end();
      return;
    }

    const validSession = validation.session;
    const confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;

    // All validations passed - start SSE streaming response
    const sseStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Note: CORS headers are handled by Function URL config, don't duplicate
      },
    });

    try {
      // Retrieve context from Bedrock KB
      let retrievedResults: RetrievalResult[] = [];
      try {
        retrievedResults = await retrieveContext(
          request.message,
          knowledgeBaseId,
          confidenceThreshold,
          getBedrockAgent(),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const event: SSEEvent = {
          type: "error",
          data: `Knowledge base retrieval failed: ${msg}`,
        };
        sseStream.write(formatSSEEvent(event));
        sseStream.end();
        return;
      }

      // No-answer fallback when KB has no relevant results
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

        // Stream fallback tokens
        const words = NO_ANSWER_FALLBACK.split(" ");
        for (const word of words) {
          const event: SSEEvent = { type: "token", data: word + " " };
          sseStream.write(formatSSEEvent(event));
        }

        // Persist session update
        const updatedSession = transitionSession(validSession, 1);
        await persistSession(updatedSession, tableName, getDdb());

        const doneEvent: SSEEvent = {
          type: "done",
          data: {
            sessionId: request.sessionId,
            turnCount: updatedSession.turnCount,
            tokensUsed: updatedSession.tokensUsed,
          },
        };
        sseStream.write(formatSSEEvent(doneEvent));
        sseStream.end();
        return;
      }

      // Emit citation events
      for (const r of retrievedResults) {
        const citationEvent: SSEEvent = {
          type: "citation",
          data: {
            sourceRecordId: r.sourceRecordId,
            title: r.title,
            relevanceScore: r.relevanceScore,
          },
        };
        sseStream.write(formatSSEEvent(citationEvent));
      }

      // Build system prompt from retrieved context
      const contextTexts = retrievedResults.map((r) => r.content);
      const contextBlock = contextTexts
        .map((t, i) => `[Source ${i + 1}]\n${t}`)
        .join("\n\n");

      const systemPrompt =
        `You are Pluto and you are a helpful assistant of Think-HQ (THQ). ` +
        `Use the context provided below from our knowledge base to answer the user's question. ` +
        `Any question irrelevant to the context or the context doesn't contain relevant information, just say: "${NO_ANSWER_FALLBACK}"\n\n` +
        `Here is the context:\n${contextBlock}\n\n` +
        `Just because the user asserts a fact does not mean it is true, make sure to double check the context to validate a user's assertion. ` +
        `Don't state that you have been given a context to answer the questions.\n` +
        `If the question is about an individual person, use gender-neutral terms to refer to them. ` +
        `Always use Australian English spelling, grammar, and style (e.g., 'colour' not 'color', 'organisation' not 'organization'). ` +
        `Unless the user question is in a different language. In that case, respond in the language of the user question. ` +
        `Always giving clickable source links from the context for further reference.\n` +
        `When providing information, please reference the source URLs included in the context (e.g., "Learn more: [Source URL]...").\n\n` +
        `## Response Formatting Rules\n` +
        `Format your responses for human readability using Markdown:\n` +
        `- Use **bold** for key terms, names, or important concepts.\n` +
        `- Use bullet points or numbered lists when presenting multiple items, steps, or options.\n` +
        `- Use headings (## or ###) only when the response covers multiple distinct topics.\n` +
        `- Use short paragraphs (2-3 sentences max) instead of long blocks of text.\n` +
        `- Add line breaks between logical sections for visual clarity.\n` +
        `- When listing dates, deadlines, or events, format them clearly (e.g., "**Due:** 15 March 2025").\n` +
        `- Keep responses concise and scannable - avoid unnecessary filler words.\n` +
        `- Place source links at the end of the relevant paragraph or section, not inline mid-sentence.`;

      // Stream Claude response - tokens are written to the stream as they arrive
      console.log(
        JSON.stringify({
          level: "INFO",
          message: "Starting Claude streaming response",
          sessionId: request.sessionId,
          contextChunks: retrievedResults.length,
        }),
      );

      try {
        for await (const chunk of streamClaudeResponse(
          request.message,
          systemPrompt,
          getBedrockRuntime(),
        )) {
          if (chunk.type === "token") {
            const tokenEvent: SSEEvent = { type: "token", data: chunk.text };
            sseStream.write(formatSSEEvent(tokenEvent));
          } else if (chunk.type === "usage") {
            totalInputTokens += chunk.inputTokens;
            totalOutputTokens += chunk.outputTokens;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorEvent: SSEEvent = {
          type: "error",
          data: `Response generation failed: ${msg}`,
        };
        sseStream.write(formatSSEEvent(errorEvent));
        sseStream.end();
        return;
      }

      const tokensThisTurn = totalInputTokens + totalOutputTokens;

      // Update session state
      const updatedSession = transitionSession(validSession, tokensThisTurn);
      await persistSession(updatedSession, tableName, getDdb());

      // Emit done event (exactly once, last)
      const doneEvent: SSEEvent = {
        type: "done",
        data: {
          sessionId: request.sessionId,
          turnCount: updatedSession.turnCount,
          tokensUsed: updatedSession.tokensUsed,
        },
      };
      sseStream.write(formatSSEEvent(doneEvent));
      sseStream.end();
    } catch (err: unknown) {
      console.error("Unexpected streaming error:", err);
      try {
        const errorEvent: SSEEvent = {
          type: "error",
          data: "An unexpected error occurred.",
        };
        sseStream.write(formatSSEEvent(errorEvent));
        sseStream.end();
      } catch {
        // Stream may already be closed
        responseStream.end();
      }
    }
  },
);
