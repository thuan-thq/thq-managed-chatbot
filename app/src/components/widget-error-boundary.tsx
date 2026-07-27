"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Error boundary that catches all widget initialization and render errors.
 * Prevents uncaught exceptions from propagating to the host page.
 * Renders nothing (invisible) on error — no broken UI on the host page.
 *
 * Requirement 1.7: IF the embed script fails to load or encounters an
 * initialization error, THEN the Chat_Widget SHALL not throw uncaught
 * exceptions on the host page and SHALL not render any visible broken UI elements.
 */
export class WidgetErrorBoundary extends Component<Props, State> {
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
      console.error("[ChatWidget] Initialization error caught:", error.message);
      console.error("[ChatWidget] Component stack:", errorInfo.componentStack);
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
