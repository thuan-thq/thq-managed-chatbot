"use client";

import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Error boundary that catches render and initialization errors.
 * Prevents uncaught exceptions from propagating to the host page.
 * Renders nothing (invisible) on error — no broken UI on the host page.
 */
export class ChatErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error silently without throwing to host page
    if (typeof console !== "undefined" && console.error) {
      console.error("[Chat] Initialization error caught:", error.message);
      console.error("[Chat] Component stack:", errorInfo.componentStack);
    }
  }

  render() {
    if (this.state.hasError) {
      // Render nothing — no broken UI on host page
      return null;
    }

    return this.props.children;
  }
}
