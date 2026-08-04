export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: CitationMetadata[];
  timestamp: string;
}

export interface CitationMetadata {
  sourceRecordId: string;
  title: string;
  relevanceScore: number;
}

/**
 * Terminal session states. When set, the widget becomes read-only.
 * - "expired"   → session duration exceeded (401 + session_expired)
 * - "exhausted" → turn/token limit reached (401 + session_exhausted)
 */
export type SessionTerminalStatus = "expired" | "exhausted";

export interface WidgetError {
  code: string;
  message: string;
  retryAfter?: number;
  /** Set when the error puts the session into a terminal (read-only) state */
  sessionStatus?: SessionTerminalStatus;
}

export interface WidgetState {
  isExpanded: boolean;
  sessionToken: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  error: WidgetError | null;
}

export interface CompletionMetadata {
  sessionId: string;
  turnCount: number;
  tokensUsed: number;
}
