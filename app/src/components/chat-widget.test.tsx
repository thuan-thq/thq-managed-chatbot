import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import React from "react";
import { ChatWidget } from "./chat-widget";
import { BrandingConfig } from "@/lib/branding";
import type { SSECallbacks } from "@/lib/sse-client";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock session client so tests don't make real HTTP calls
vi.mock("@/lib/session-client", () => ({
  createSession: vi
    .fn()
    .mockResolvedValue({ sessionToken: "test-session-token" }),
}));

// Capture the most-recently registered SSE callbacks so tests can drive them
let capturedCallbacks: SSECallbacks | null = null;
const mockStreamChat = vi.fn(
  (_message: string, _token: string, callbacks: SSECallbacks) => {
    capturedCallbacks = callbacks;
    return () => {}; // abort noop
  },
);

vi.mock("@/lib/sse-client", () => ({
  streamChat: (...args: Parameters<typeof mockStreamChat>) =>
    mockStreamChat(...args),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const defaultBranding: BrandingConfig = {
  primaryColour: "#2563eb",
  accentColour: "#1d4ed8",
  logoUrl: null,
  widgetTitle: "Test Assistant",
  fontFamily: "system-ui, sans-serif",
  welcomeMessage: "Hello! How can I help?",
  bubblePosition: "bottom-right",
};

/** Render widget, wait for session to be created, return helpers. */
async function renderWidget() {
  const result = render(<ChatWidget branding={defaultBranding} />);
  // Wait for useEffect session creation to resolve
  await act(async () => {});
  return result;
}

/** Type a message and click send. */
async function sendMessage(text: string) {
  const input = screen.getByLabelText("Chat message input");
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Send message"));
  });
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedCallbacks = null;
  mockStreamChat.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Existing baseline tests
// ---------------------------------------------------------------------------

describe("ChatWidget — baseline", () => {
  it("renders the trigger button", async () => {
    await renderWidget();
    expect(screen.getByLabelText("Toggle chat")).toBeInTheDocument();
  });

  it("starts in collapsed state", async () => {
    await renderWidget();
    expect(screen.getByLabelText("Toggle chat")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("expands when trigger is clicked", async () => {
    await renderWidget();
    fireEvent.click(screen.getByLabelText("Toggle chat"));
    expect(screen.getByLabelText("Toggle chat")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("collapses when close button is clicked", async () => {
    await renderWidget();
    fireEvent.click(screen.getByLabelText("Toggle chat"));
    fireEvent.click(screen.getByLabelText("Close chat"));
    expect(screen.getByLabelText("Toggle chat")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("displays the widget title from branding config", async () => {
    await renderWidget();
    expect(screen.getByText("Test Assistant")).toBeInTheDocument();
  });

  it("displays the welcome message when no messages exist", async () => {
    await renderWidget();
    expect(screen.getByText("Hello! How can I help?")).toBeInTheDocument();
  });

  it("displays logo when logoUrl is provided", async () => {
    const brandingWithLogo = {
      ...defaultBranding,
      logoUrl: "https://example.com/logo.png",
    };
    const { container } = render(<ChatWidget branding={brandingWithLogo} />);
    await act(async () => {});
    const logo = container.querySelector(
      ".widget-header-logo",
    ) as HTMLImageElement;
    expect(logo).not.toBeNull();
    expect(logo.getAttribute("src")).toBe("https://example.com/logo.png");
  });

  it("does not display logo when logoUrl is null", async () => {
    const { container } = await renderWidget();
    expect(container.querySelector(".widget-header-logo")).toBeNull();
  });

  it("clears input after sending", async () => {
    await renderWidget();
    const input = screen.getByLabelText(
      "Chat message input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Hello there" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send message"));
    });
    expect(input.value).toBe("");
  });

  it("disables send button when input is empty", async () => {
    await renderWidget();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("sends message on Enter key", async () => {
    await renderWidget();
    const input = screen.getByLabelText("Chat message input");
    fireEvent.change(input, { target: { value: "Test message" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    });
    expect(mockStreamChat).toHaveBeenCalled();
  });

  it("does not send on Shift+Enter", async () => {
    await renderWidget();
    const input = screen.getByLabelText(
      "Chat message input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Test message" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockStreamChat).not.toHaveBeenCalled();
    expect(input.value).toBe("Test message");
  });

  it("shows error for messages exceeding 2000 characters", async () => {
    await renderWidget();
    const input = screen.getByLabelText("Chat message input");
    fireEvent.change(input, { target: { value: "a".repeat(2001) } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send message"));
    });
    expect(
      screen.getByText("Message must be 2000 characters or less."),
    ).toBeInTheDocument();
  });

  it("renders the chat panel as a dialog with correct aria-label", async () => {
    await renderWidget();
    const panel = screen.getByRole("dialog", { hidden: true });
    expect(panel).toHaveAttribute("aria-label", "Test Assistant");
  });

  it("hides the chat panel when collapsed", async () => {
    await renderWidget();
    const panel = screen.getByRole("dialog", { hidden: true });
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("data-state", "closed");
  });
});

// ---------------------------------------------------------------------------
// Streaming tests
// ---------------------------------------------------------------------------

describe("ChatWidget — streaming", () => {
  it("shows typing indicator while streaming", async () => {
    await renderWidget();
    await sendMessage("Hello");

    // onToken not yet called → assistant message building in progress
    expect(screen.getByLabelText("Assistant is typing")).toBeInTheDocument();
  });

  it("adds user message immediately on send", async () => {
    await renderWidget();
    await sendMessage("Hello");
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("builds assistant message progressively via onToken", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onToken("Hi");
    });
    await act(async () => {
      capturedCallbacks?.onToken(" there");
    });

    expect(screen.getByText("Hi there")).toBeInTheDocument();
  });

  it("hides typing indicator after onDone", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onToken("Done answer");
      capturedCallbacks?.onDone({
        sessionId: "s1",
        turnCount: 1,
        tokensUsed: 50,
      });
    });

    expect(
      screen.queryByLabelText("Assistant is typing"),
    ).not.toBeInTheDocument();
  });

  it("disables input while streaming", async () => {
    await renderWidget();
    await sendMessage("Hello");

    expect(screen.getByLabelText("Chat message input")).toBeDisabled();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("re-enables input after streaming completes", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onDone({
        sessionId: "s1",
        turnCount: 1,
        tokensUsed: 50,
      });
    });

    expect(screen.getByLabelText("Chat message input")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Citation rendering
// ---------------------------------------------------------------------------

describe("ChatWidget — citations", () => {
  it("renders citations with title and relevance score after streaming", async () => {
    await renderWidget();
    await sendMessage("Tell me about X");

    await act(async () => {
      capturedCallbacks?.onToken("Here is the info.");
      capturedCallbacks?.onCitation({
        sourceRecordId: "rec-1",
        title: "Knowledge Base Doc",
        relevanceScore: 0.92,
      });
      capturedCallbacks?.onDone({
        sessionId: "s1",
        turnCount: 1,
        tokensUsed: 100,
      });
    });

    expect(screen.getByText("Knowledge Base Doc")).toBeInTheDocument();
    expect(screen.getByText("92% relevant")).toBeInTheDocument();
  });

  it("renders multiple citations", async () => {
    await renderWidget();
    await sendMessage("Multi-cite?");

    await act(async () => {
      capturedCallbacks?.onToken("Answer");
      capturedCallbacks?.onCitation({
        sourceRecordId: "r1",
        title: "Source One",
        relevanceScore: 0.8,
      });
      capturedCallbacks?.onCitation({
        sourceRecordId: "r2",
        title: "Source Two",
        relevanceScore: 0.6,
      });
      capturedCallbacks?.onDone({
        sessionId: "s1",
        turnCount: 1,
        tokensUsed: 100,
      });
    });

    expect(screen.getByText("Source One")).toBeInTheDocument();
    expect(screen.getByText("80% relevant")).toBeInTheDocument();
    expect(screen.getByText("Source Two")).toBeInTheDocument();
    expect(screen.getByText("60% relevant")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

describe("ChatWidget — error states", () => {
  it("shows error message when onError is called", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "Service is down.",
      });
    });

    expect(screen.getByRole("alert", { hidden: true })).toBeInTheDocument();
    expect(screen.getByText(/Service is down\./)).toBeInTheDocument();
  });

  it("shows retry button when there is an error and a prior message", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "Service is down.",
      });
    });

    expect(
      screen.getByLabelText("Retry sending your last message"),
    ).toBeInTheDocument();
  });

  it("retry button re-sends the last failed message", async () => {
    await renderWidget();
    await sendMessage("Try me");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "Service is down.",
      });
    });

    expect(mockStreamChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Retry sending your last message"));
    });

    // streamChat should be called again with the same message
    expect(mockStreamChat).toHaveBeenCalledTimes(2);
    expect(mockStreamChat.mock.calls[1][0]).toBe("Try me");
  });

  it("shows countdown for rate-limited errors", async () => {
    vi.useFakeTimers();
    await renderWidget();
    await sendMessage("Rate me");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "RATE_LIMITED",
        message: "Too many messages.",
        retryAfter: 10,
      });
    });

    expect(screen.getByText(/Too many messages\./)).toBeInTheDocument();
    // Countdown should show "10s"
    expect(screen.getByText(/10s/)).toBeInTheDocument();

    // Advance 5 seconds
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/5s/)).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("dismisses error when dismiss button is clicked", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "Something went wrong.",
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss error"));
    });

    expect(
      screen.queryByRole("alert", { hidden: true }),
    ).not.toBeInTheDocument();
  });

  it("stops streaming state on error", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "STREAM_ERROR",
        message: "Stream broke.",
      });
    });

    // Input should be re-enabled
    expect(screen.getByLabelText("Chat message input")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Session terminal states (expired / exhausted) — Req 3.7, 14.3
// ---------------------------------------------------------------------------

describe("ChatWidget — session terminal states", () => {
  it("shows session expired banner with New Session button", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please start a new session.",
        sessionStatus: "expired",
      });
    });

    expect(
      screen.getByText("Your session has expired. Please start a new session."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Start a new session")).toBeInTheDocument();
  });

  it("shows session exhausted banner with New Session button", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXHAUSTED",
        message:
          "You have reached the conversation limit. Start a new session to continue.",
        sessionStatus: "exhausted",
      });
    });

    expect(
      screen.getByText(
        "You have reached the conversation limit. Start a new session to continue.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Start a new session")).toBeInTheDocument();
  });

  it("disables input when session is expired", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please start a new session.",
        sessionStatus: "expired",
      });
    });

    expect(screen.getByLabelText("Chat message input")).toBeDisabled();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("disables input when session is exhausted", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXHAUSTED",
        message:
          "You have reached the conversation limit. Start a new session to continue.",
        sessionStatus: "exhausted",
      });
    });

    expect(screen.getByLabelText("Chat message input")).toBeDisabled();
  });

  it("does not show dismiss button or retry button in terminal state", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please start a new session.",
        sessionStatus: "expired",
      });
    });

    expect(screen.queryByLabelText("Dismiss error")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Retry sending your last message"),
    ).not.toBeInTheDocument();
  });

  it("New Session button resets widget state and creates a new session", async () => {
    const { createSession } = await import("@/lib/session-client");
    const mockedCreateSession = createSession as ReturnType<typeof vi.fn>;
    mockedCreateSession.mockResolvedValueOnce({
      sessionToken: "new-session-token",
    });

    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onToken("Some response");
      capturedCallbacks?.onDone({
        sessionId: "s1",
        turnCount: 1,
        tokensUsed: 50,
      });
    });

    // Trigger exhausted state
    await sendMessage("Next message");
    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXHAUSTED",
        message:
          "You have reached the conversation limit. Start a new session to continue.",
        sessionStatus: "exhausted",
      });
    });

    // Messages should still be visible (read-only history)
    expect(screen.getByText("Hello")).toBeInTheDocument();

    // Click New Session
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Start a new session"));
    });

    // Banner should be gone
    expect(
      screen.queryByLabelText("Start a new session"),
    ).not.toBeInTheDocument();

    // Input should be re-enabled
    await waitFor(() => {
      expect(screen.getByLabelText("Chat message input")).not.toBeDisabled();
    });
  });

  it("previous conversation messages are preserved as read-only history when session ends", async () => {
    await renderWidget();
    await sendMessage("First question");

    await act(async () => {
      capturedCallbacks?.onToken("First answer");
      capturedCallbacks?.onDone({
        sessionId: "s1",
        turnCount: 1,
        tokensUsed: 50,
      });
    });

    await sendMessage("Second question");
    await act(async () => {
      capturedCallbacks?.onError({
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please start a new session.",
        sessionStatus: "expired",
      });
    });

    // Previous messages still shown
    expect(screen.getByText("First question")).toBeInTheDocument();
    expect(screen.getByText("First answer")).toBeInTheDocument();
    expect(screen.getByText("Second question")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 503 Bedrock unavailability — Req 14.1
// ---------------------------------------------------------------------------

describe("ChatWidget — 503 service unavailable", () => {
  it("shows service unavailable error message", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
      });
    });

    expect(
      screen.getByText(
        "The service is temporarily unavailable. Please try again.",
      ),
    ).toBeInTheDocument();
  });

  it("shows retry option after 503 error", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
      });
    });

    expect(
      screen.getByLabelText("Retry sending your last message"),
    ).toBeInTheDocument();
  });

  it("re-enables input after 503 error so user can retry", async () => {
    await renderWidget();
    await sendMessage("Hello");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
      });
    });

    expect(screen.getByLabelText("Chat message input")).not.toBeDisabled();
  });

  it("retry button re-sends the last message after 503 error", async () => {
    await renderWidget();
    await sendMessage("Try again");

    await act(async () => {
      capturedCallbacks?.onError({
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again.",
      });
    });

    expect(mockStreamChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Retry sending your last message"));
    });

    expect(mockStreamChat).toHaveBeenCalledTimes(2);
    expect(mockStreamChat.mock.calls[1][0]).toBe("Try again");
  });
});
