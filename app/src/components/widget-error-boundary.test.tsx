import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { WidgetErrorBoundary } from "./widget-error-boundary";

function ThrowingComponent(): React.JSX.Element {
  throw new Error("Test initialization error");
}

function WorkingComponent() {
  return <div>Widget loaded successfully</div>;
}

describe("WidgetErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <WidgetErrorBoundary>
        <WorkingComponent />
      </WidgetErrorBoundary>,
    );
    expect(screen.getByText("Widget loaded successfully")).toBeInTheDocument();
  });

  it("renders nothing when a child component throws", () => {
    // Suppress React error boundary console output
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { container } = render(
      <WidgetErrorBoundary>
        <ThrowingComponent />
      </WidgetErrorBoundary>,
    );

    // Should render nothing — no broken UI
    expect(container.innerHTML).toBe("");

    consoleSpy.mockRestore();
  });

  it("does not throw uncaught exceptions to the host page", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // This should NOT throw
    expect(() => {
      render(
        <WidgetErrorBoundary>
          <ThrowingComponent />
        </WidgetErrorBoundary>,
      );
    }).not.toThrow();

    consoleSpy.mockRestore();
  });

  it("logs error silently via console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <WidgetErrorBoundary>
        <ThrowingComponent />
      </WidgetErrorBoundary>,
    );

    // Should have logged the error (React logs + our custom log)
    expect(consoleSpy).toHaveBeenCalled();
    const calls = consoleSpy.mock.calls.flat().join(" ");
    expect(calls).toContain("ChatWidget");

    consoleSpy.mockRestore();
  });
});
