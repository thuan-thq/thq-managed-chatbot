import { WidgetError } from "./types";

export interface SessionCreationResult {
  sessionToken: string;
}

/**
 * Create a new chat session by calling POST /session on the backend.
 * Returns the session token on success, or throws a WidgetError on failure.
 */
export async function createSession(): Promise<SessionCreationResult> {
  const endpoint = process.env.NEXT_PUBLIC_API_ENDPOINT;
  if (!endpoint) {
    const err: WidgetError = {
      code: "CONFIGURATION_ERROR",
      message: "API endpoint is not configured.",
    };
    throw err;
  }

  console.log("[session-client] Creating session at:", `${endpoint}/session`);

  let response: Response;
  try {
    response = await fetch(`${endpoint}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    console.error("[session-client] Network error:", e);
    const err: WidgetError = {
      code: "NETWORK_ERROR",
      message: "Failed to connect. Please check your connection.",
    };
    throw err;
  }

  console.log("[session-client] Response status:", response.status);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[session-client] Error response body:", text);
    const err: WidgetError = {
      code: "SESSION_CREATION_FAILED",
      message: `Failed to create session (HTTP ${response.status}).`,
    };
    throw err;
  }

  let body: { sessionId?: string; token?: string };
  try {
    body = (await response.json()) as { sessionId?: string; token?: string };
  } catch {
    console.error("[session-client] Failed to parse response JSON");
    const err: WidgetError = {
      code: "SESSION_CREATION_FAILED",
      message: "Invalid response from session endpoint.",
    };
    throw err;
  }

  console.log("[session-client] Response body:", body);

  if (!body.sessionId) {
    console.error("[session-client] sessionId missing from response");
    const err: WidgetError = {
      code: "SESSION_CREATION_FAILED",
      message: "Session ID missing from response.",
    };
    throw err;
  }

  console.log("[session-client] Session created:", body.sessionId);
  return { sessionToken: body.sessionId };
}
