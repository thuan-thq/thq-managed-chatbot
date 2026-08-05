"use client";

import React, { useState, useRef, useEffect, useCallback, useId } from "react";
import { ChatMessage, CitationMetadata, WidgetError } from "../../lib/types";
import { streamChat } from "../../lib/sse-client";
import { createSession } from "../../lib/session-client";
import { renderMarkdown } from "../../lib/markdown";

interface ChatBlockState {
  sessionToken: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  error: WidgetError | null;
}

/**
 * Inline chat block — always visible, no floating bubble, no branding.
 * Intended to be placed inside a page layout and styled via global CSS.
 * Class names use the "chat-block-" prefix to avoid collisions.
 */
export function ChatBlock() {
  const [state, setState] = useState<ChatBlockState>({
    sessionToken: null,
    messages: [],
    isStreaming: false,
    error: null,
  });
  const [inputValue, setInputValue] = useState("");

  const lastUserMessageRef = useRef<string>("");
  const abortStreamRef = useRef<(() => void) | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const countdownId = useId();

  const scrollToBottom = useCallback(() => {
    if (
      messagesEndRef.current &&
      typeof messagesEndRef.current.scrollIntoView === "function"
    ) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [state.messages, state.isStreaming, scrollToBottom]);

  // Auto-create a session on first mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { sessionToken } = await createSession();
        if (!cancelled) {
          setState((prev) => ({ ...prev, sessionToken }));
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, error: err as WidgetError }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clean up countdown on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current !== null) clearInterval(countdownRef.current);
    };
  }, []);

  // Abort stream on unmount
  useEffect(() => {
    return () => {
      if (abortStreamRef.current) abortStreamRef.current();
    };
  }, []);

  const startRetryCountdown = useCallback((seconds: number) => {
    setRetryCountdown(seconds);
    if (countdownRef.current !== null) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev === null || prev <= 1) {
          if (countdownRef.current !== null) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const dismissError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
    setRetryCountdown(null);
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const startNewSession = useCallback(() => {
    if (abortStreamRef.current) {
      abortStreamRef.current();
      abortStreamRef.current = null;
    }
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setRetryCountdown(null);
    setInputValue("");
    lastUserMessageRef.current = "";

    setState({
      sessionToken: null,
      messages: [],
      isStreaming: false,
      error: null,
    });

    (async () => {
      try {
        const { sessionToken } = await createSession();
        setState((prev) => ({ ...prev, sessionToken }));
      } catch (err) {
        setState((prev) => ({ ...prev, error: err as WidgetError }));
      }
    })();
  }, []);

  const sendMessage = useCallback(
    (message: string) => {
      if (!message || state.isStreaming) return;

      const sessionToken = state.sessionToken;
      if (!sessionToken) {
        setState((prev) => ({
          ...prev,
          error: {
            code: "SESSION_NOT_READY",
            message: "Session is not ready yet. Please wait a moment.",
          },
        }));
        return;
      }

      lastUserMessageRef.current = message;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      };

      const assistantMessageId = crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        citations: [],
        timestamp: new Date().toISOString(),
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, assistantMessage],
        isStreaming: true,
        error: null,
      }));

      const abort = streamChat(message, sessionToken, {
        onToken: (text) => {
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: m.content + text }
                : m,
            ),
          }));
        },
        onCitation: (citation: CitationMetadata) => {
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessageId
                ? { ...m, citations: [...(m.citations ?? []), citation] }
                : m,
            ),
          }));
        },
        onDone: () => {
          setState((prev) => ({ ...prev, isStreaming: false }));
          abortStreamRef.current = null;
        },
        onError: (error: WidgetError) => {
          setState((prev) => ({
            ...prev,
            isStreaming: false,
            messages: prev.messages.filter(
              (m) => !(m.id === assistantMessageId && m.content === ""),
            ),
            error,
          }));
          abortStreamRef.current = null;

          if (error.code === "RATE_LIMITED" && error.retryAfter) {
            startRetryCountdown(error.retryAfter);
          }
        },
      });

      abortStreamRef.current = abort;
    },
    [state.isStreaming, state.sessionToken, startRetryCountdown],
  );

  const handleSend = useCallback(() => {
    const message = inputValue.trim();
    if (!message || state.isStreaming) return;

    if (message.length > 2000) {
      setState((prev) => ({
        ...prev,
        error: {
          code: "MESSAGE_TOO_LONG",
          message: "Message must be 2000 characters or less.",
        },
      }));
      return;
    }

    setInputValue("");
    sendMessage(message);
  }, [inputValue, state.isStreaming, sendMessage]);

  const retryLastMessage = useCallback(() => {
    const last = lastUserMessageRef.current;
    if (!last) return;
    dismissError();
    sendMessage(last);
  }, [sendMessage, dismissError]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const isRateLimited =
    state.error?.code === "RATE_LIMITED" && retryCountdown !== null;

  const isSessionTerminal =
    state.error?.sessionStatus === "expired" ||
    state.error?.sessionStatus === "exhausted";

  const canRetry =
    !state.isStreaming &&
    state.error !== null &&
    !isSessionTerminal &&
    lastUserMessageRef.current !== "" &&
    !isRateLimited;

  const showErrorBar = state.error !== null && !isSessionTerminal;

  const isInputDisabled =
    state.isStreaming || isRateLimited || isSessionTerminal;

  return (
    <div className="chat-block">
      {/* Messages */}
      <div className="chat-block-messages" role="log" aria-live="polite">
        {state.messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-block-message chat-block-message--${msg.role}`}
          >
            {msg.role === "assistant" ? (
              <div
                className="chat-block-message-content"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(msg.content),
                }}
              />
            ) : (
              msg.content
            )}
          </div>
        ))}
        {state.isStreaming && (
          <div className="chat-block-typing" aria-label="Assistant is typing">
            <div className="chat-block-typing-dot" />
            <div className="chat-block-typing-dot" />
            <div className="chat-block-typing-dot" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Session terminal banner */}
      {isSessionTerminal && (
        <div className="chat-block-session-banner" role="status">
          <span>{state.error!.message}</span>
          <button
            className="chat-block-new-session-btn"
            onClick={startNewSession}
            aria-label="Start a new session"
            type="button"
          >
            New Session
          </button>
        </div>
      )}

      {/* Error bar */}
      {showErrorBar && (
        <div className="chat-block-error" role="alert">
          <span>
            {state.error!.message}
            {isRateLimited && (
              <span id={countdownId} aria-live="polite" aria-atomic="true">
                {" "}
                ({retryCountdown}s)
              </span>
            )}
          </span>
          {canRetry && (
            <button
              className="chat-block-error-retry"
              onClick={retryLastMessage}
              aria-label="Retry sending your last message"
              type="button"
            >
              Retry
            </button>
          )}
          <button
            className="chat-block-error-dismiss"
            onClick={dismissError}
            aria-label="Dismiss error"
            type="button"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              width={16}
              height={16}
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Input area */}
      <div
        className={`chat-block-input-area${isSessionTerminal ? " chat-block-input-area--readonly" : ""}`}
        aria-hidden={isSessionTerminal ? true : undefined}
      >
        <textarea
          ref={inputRef}
          className="chat-block-input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isSessionTerminal
              ? "Start a new session to continue"
              : "Type a message..."
          }
          rows={1}
          aria-label="Chat message input"
          disabled={isInputDisabled}
        />
        <button
          className="chat-block-send-btn"
          onClick={handleSend}
          disabled={!inputValue.trim() || isInputDisabled}
          aria-label="Send message"
          type="button"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
