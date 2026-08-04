import { CitationMetadata, CompletionMetadata, WidgetError } from "./types";

export interface SSECallbacks {
  onToken: (text: string) => void;
  onCitation: (citation: CitationMetadata) => void;
  onDone: (metadata: CompletionMetadata) => void;
  onError: (error: WidgetError) => void;
}

/**
 * Raw SSE event shapes emitted by the Chat Lambda backend.
 */
interface TokenEvent {
  type: "token";
  data: string;
}

interface CitationEvent {
  type: "citation";
  data: CitationMetadata;
}

interface DoneEvent {
  type: "done";
  data: CompletionMetadata;
}

interface ErrorEvent {
  type: "error";
  data: string;
}

type BackendEvent = TokenEvent | CitationEvent | DoneEvent | ErrorEvent;

/**
 * Map HTTP error status codes to WidgetError values.
 * Extracts Retry-After header for 429 responses.
 * For 401s, the errorCode param distinguishes expired vs exhausted.
 */
function httpErrorToWidgetError(
  status: number,
  retryAfterHeader: string | null,
  errorCode?: string,
): WidgetError {
  switch (status) {
    case 400:
      return {
        code: "MESSAGE_INVALID",
        message: "Message is empty or exceeds 2000 characters.",
      };
    case 401: {
      if (errorCode === "session_exhausted") {
        return {
          code: "SESSION_EXHAUSTED",
          message:
            "You have reached the conversation limit. Start a new session to continue.",
          sessionStatus: "exhausted",
        };
      }
      // Default: session_expired (also covers malformed/missing tokens)
      return {
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please start a new session.",
        sessionStatus: "expired",
      };
    }
    case 409:
      return {
        code: "CONCURRENT_REQUEST",
        message: "Please wait for the current response to finish.",
      };
    case 429: {
      const retryAfter = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : undefined;
      return {
        code: "RATE_LIMITED",
        message: "Too many messages. Please wait before sending another.",
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
      };
    }
    case 503:
      return {
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
      };
    default:
      return {
        code: "UNKNOWN_ERROR",
        message: `Unexpected error (HTTP ${status}).`,
      };
  }
}

/**
 * Parse a single SSE `data:` line into a BackendEvent.
 * Returns null if the line cannot be parsed.
 */
function parseSSELine(line: string): BackendEvent | null {
  const prefix = "data:";
  if (!line.startsWith(prefix)) return null;

  const json = line.slice(prefix.length).trim();
  if (!json) return null;

  try {
    return JSON.parse(json) as BackendEvent;
  } catch {
    return null;
  }
}

/**
 * Stream a chat message via SSE using fetch + ReadableStream.
 *
 * Uses `fetch` (not `EventSource`) because the endpoint requires a POST request.
 * The returned function can be called to abort the stream early (e.g., on unmount).
 *
 * @returns An abort function that cancels the in-flight stream.
 */
export function streamChat(
  message: string,
  sessionToken: string,
  callbacks: SSECallbacks,
): () => void {
  const controller = new AbortController();

  const endpoint = process.env.NEXT_PUBLIC_API_ENDPOINT;
  if (!endpoint) {
    callbacks.onError({
      code: "CONFIGURATION_ERROR",
      message: "API endpoint is not configured.",
    });
    return () => {};
  }

  (async () => {
    let response: Response;
    try {
      const streamEndpoint = process.env.NEXT_PUBLIC_STREAM_ENDPOINT;
      const chatUrl = streamEndpoint ? streamEndpoint : `${endpoint}/chat`;
      console.log("[sse-client] Sending chat message:", {
        endpoint: chatUrl,
        sessionToken,
        messageLength: message.length,
      });
      response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, sessionId: sessionToken }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("[sse-client] Network error:", err);
      callbacks.onError({
        code: "NETWORK_ERROR",
        message: "Failed to connect. Please check your connection.",
      });
      return;
    }

    console.log("[sse-client] Response status:", response.status);

    if (!response.ok) {
      const retryAfter = response.headers.get("Retry-After");
      // For 401 responses, attempt to read the error body to distinguish
      // session_expired from session_exhausted
      if (response.status === 401) {
        let errorCode: string | undefined;
        try {
          const body = (await response.json()) as { error_code?: string };
          errorCode = body.error_code;
        } catch {
          // Body unreadable — fall back to default session_expired
        }
        callbacks.onError(
          httpErrorToWidgetError(response.status, retryAfter, errorCode),
        );
      } else {
        callbacks.onError(httpErrorToWidgetError(response.status, retryAfter));
      }
      return;
    }

    const body = response.body;
    if (!body) {
      callbacks.onError({
        code: "UNKNOWN_ERROR",
        message: "Empty response from server.",
      });
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE messages are separated by double newlines; process complete lines
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const event = parseSSELine(trimmed);
          if (!event) continue;

          switch (event.type) {
            case "token":
              callbacks.onToken(event.data);
              break;
            case "citation":
              console.log("[sse-client] Citation received:", event.data);
              callbacks.onCitation(event.data);
              break;
            case "done":
              console.log("[sse-client] Stream done:", event.data);
              callbacks.onDone(event.data);
              return;
            case "error":
              console.error("[sse-client] Stream error event:", event.data);
              callbacks.onError({
                code: "STREAM_ERROR",
                message:
                  typeof event.data === "string"
                    ? event.data
                    : "An error occurred during streaming.",
              });
              return;
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      callbacks.onError({
        code: "STREAM_ERROR",
        message: "Stream interrupted unexpectedly.",
      });
    } finally {
      reader.releaseLock();
    }
  })();

  return () => controller.abort();
}
