"use client";

import React from "react";
import { ChatBlock } from "./chat-block";
import { ChatErrorBoundary } from "./chat-error-boundary";

/**
 * Top-level inline chat block component.
 * No Shadow DOM, no branding — styles come from the host page's global CSS.
 * Drop this anywhere in a page layout; it renders as a plain block element.
 */
export function ChatBlockPanel() {
  return (
    <ChatErrorBoundary>
      <ChatBlock />
    </ChatErrorBoundary>
  );
}
