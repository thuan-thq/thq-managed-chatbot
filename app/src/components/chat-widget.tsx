"use client";

import React, { useState, useRef, useEffect, useCallback, useId } from "react";
import { BrandingConfig } from "@/lib/branding";
import {
  ChatMessage,
  CitationMetadata,
  WidgetError,
  WidgetState,
} from "@/lib/types";
import { streamChat } from "@/lib/sse-client";
import { createSession } from "@/lib/session-client";
import { renderMarkdown } from "@/lib/markdown";

interface ChatWidgetProps {
  branding: BrandingConfig;
}

/**
 * Core chat widget UI rendered inside Shadow DOM.
 * Handles expand/collapse animation, streaming SSE messages, citations,
 * error states, and retry UX.
 * All interactive elements maintain 44×44 px minimum touch targets.
 */
export function ChatWidget({ branding }: ChatWidgetProps) {
  const [state, setState] = useState<WidgetState>({
    isExpanded: false,
    sessionToken: null,
    messages: [],
    isStreaming: false,
    error: null,
  });
  const [inputValue, setInputValue] = useState("");
  // Track the last user message for retry
  const lastUserMessageRef = useRef<string>("");
  // AbortController for the current stream
  const abortStreamRef = useRef<(() => void) | null>(null);
  // Countdown interval id for 429 retryAfter display
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
          const widgetErr = err as WidgetError;
          setState((prev) => ({
            ...prev,
            error: widgetErr,
          }));
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
      if (countdownRef.current !== null) {
        clearInterval(countdownRef.current);
      }
    };
  }, []);

  const startRetryCountdown = useCallback((seconds: number) => {
    setRetryCountdown(seconds);
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
    }
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

  const toggleExpanded = useCallback(() => {
    setState((prev) => ({ ...prev, isExpanded: !prev.isExpanded }));
  }, []);

  const dismissError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
    setRetryCountdown(null);
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  /**
   * Start a brand-new session: reset messages, errors, and create a new token.
   * Used when the user clicks "New Session" after expiry/exhaustion.
   */
  const startNewSession = useCallback(() => {
    // Abort any in-flight stream
    if (abortStreamRef.current) {
      abortStreamRef.current();
      abortStreamRef.current = null;
    }
    // Clear countdown
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setRetryCountdown(null);
    setInputValue("");
    lastUserMessageRef.current = "";

    setState({
      isExpanded: true,
      sessionToken: null,
      messages: [],
      isStreaming: false,
      error: null,
    });

    // Create a new session
    (async () => {
      try {
        const { sessionToken } = await createSession();
        setState((prev) => ({ ...prev, sessionToken }));
      } catch (err) {
        const widgetErr = err as WidgetError;
        setState((prev) => ({ ...prev, error: widgetErr }));
      }
    })();
  }, []);

  /**
   * Core send/stream logic. Accepts an explicit message string so it can be
   * reused by both handleSend() and retryLastMessage().
   */
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

      // Create a placeholder assistant message that will be built up token-by-token
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
          // Remove the empty assistant placeholder on error
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

    // Validate message length (1–2000 characters)
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

  // Abort stream on unmount
  useEffect(() => {
    return () => {
      if (abortStreamRef.current) {
        abortStreamRef.current();
      }
    };
  }, []);

  const isRateLimited =
    state.error?.code === "RATE_LIMITED" && retryCountdown !== null;

  /**
   * A session is terminal when the error puts it into expired or exhausted
   * status. In this state, the conversation is read-only and only a "New
   * Session" button is offered — no retry or dismiss.
   */
  const isSessionTerminal =
    state.error?.sessionStatus === "expired" ||
    state.error?.sessionStatus === "exhausted";

  const canRetry =
    !state.isStreaming &&
    state.error !== null &&
    !isSessionTerminal &&
    lastUserMessageRef.current !== "" &&
    !isRateLimited;

  /**
   * Show the generic error bar only for non-terminal errors (terminal sessions
   * get their own dedicated banner below).
   */
  const showErrorBar = state.error !== null && !isSessionTerminal;

  /**
   * Whether the input area should be disabled: streaming, rate limited, or
   * the session has reached a terminal state.
   */
  const isInputDisabled =
    state.isStreaming || isRateLimited || isSessionTerminal;

  return (
    <div className="widget-root">
      {/* Trigger Bubble */}
      <button
        className="widget-trigger"
        onClick={toggleExpanded}
        aria-expanded={state.isExpanded}
        aria-label="Toggle chat"
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
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* Chat Panel */}
      <div
        className="widget-panel"
        data-state={state.isExpanded ? "open" : "closed"}
        role="dialog"
        aria-label={branding.widgetTitle}
        aria-hidden={!state.isExpanded}
      >
        {/* Header */}
        <div className="widget-header">
          {branding.logoUrl && (
            <img
              src={branding.logoUrl}
              alt=""
              className="widget-header-logo"
              width={32}
              height={32}
            />
          )}
          <span className="widget-header-title">{branding.widgetTitle}</span>
          <button
            className="widget-close-btn"
            onClick={toggleExpanded}
            aria-label="Close chat"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="widget-messages" role="log" aria-live="polite">
          {state.messages.length === 0 && (
            <div className="widget-welcome">{branding.welcomeMessage}</div>
          )}
          {state.messages.map((msg) => (
            <div
              key={msg.id}
              className={`widget-message widget-message--${msg.role}`}
            >
              {msg.role === "assistant" ? (
                <div
                  className="widget-message-content"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(msg.content),
                  }}
                />
              ) : (
                msg.content
              )}
              {/* Citations for assistant messages */}
              {/* {msg.role === "assistant" &&
                msg.citations &&
                msg.citations.length > 0 && (
                  <div className="widget-citations">
                    {msg.citations.map((c, i) => (
                      <div key={i} className="widget-citation">
                        <span className="widget-citation-title">{c.title}</span>
                        <span className="widget-citation-score">
                          {Math.round(c.relevanceScore * 100)}% relevant
                        </span>
                      </div>
                    ))}
                  </div>
                )} */}
            </div>
          ))}
          {state.isStreaming && (
            <div className="widget-typing" aria-label="Assistant is typing">
              <div className="widget-typing-dot" />
              <div className="widget-typing-dot" />
              <div className="widget-typing-dot" />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Session terminal banner (expired / exhausted) — read-only mode */}
        {isSessionTerminal && (
          <div className="widget-session-banner" role="status">
            <span className="widget-session-banner-text">
              {state.error!.message}
            </span>
            <button
              className="widget-new-session-btn"
              onClick={startNewSession}
              aria-label="Start a new session"
              type="button"
            >
              New Session
            </button>
          </div>
        )}

        {/* Generic error display (non-terminal errors only) */}
        {showErrorBar && (
          <div className="widget-error" role="alert">
            <span>
              {state.error!.message}
              {isRateLimited && (
                <span
                  id={countdownId}
                  className="widget-rate-limit-countdown"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {" "}
                  ({retryCountdown}s)
                </span>
              )}
            </span>
            {canRetry && (
              <button
                className="widget-error-retry"
                onClick={retryLastMessage}
                aria-label="Retry sending your last message"
                type="button"
              >
                Retry
              </button>
            )}
            <button
              className="widget-error-dismiss"
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

        {/* Input Area */}
        <div
          className={`widget-input-area${isSessionTerminal ? " widget-input-area--readonly" : ""}`}
          aria-hidden={isSessionTerminal ? true : undefined}
        >
          <textarea
            ref={inputRef}
            className="widget-input"
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
            className="widget-send-btn"
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
    </div>
  );
}
