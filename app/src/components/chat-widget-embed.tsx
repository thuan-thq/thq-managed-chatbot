"use client";

import React from "react";
import { ShadowDomContainer } from "./shadow-dom-container";
import { ChatWidget } from "./chat-widget";
import { WidgetErrorBoundary } from "./widget-error-boundary";
import { getBrandingConfig } from "@/lib/branding";
import { generateWidgetStyles } from "@/lib/widget-styles";

/**
 * Top-level embed component that renders the chat widget inside a Shadow DOM
 * container with full style isolation and error boundaries.
 *
 * This is the entry point rendered on host pages via script tag.
 * - Shadow DOM prevents style leakage in/out
 * - Error boundary prevents uncaught exceptions on host page
 * - Branding comes from build-time env vars (no runtime AWS API calls)
 */
export function ChatWidgetEmbed() {
  const branding = getBrandingConfig();
  const styles = generateWidgetStyles(branding);

  return (
    <WidgetErrorBoundary>
      <ShadowDomContainer styles={styles}>
        <ChatWidget branding={branding} />
      </ShadowDomContainer>
    </WidgetErrorBoundary>
  );
}
