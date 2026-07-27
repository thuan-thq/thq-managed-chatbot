"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";

interface ShadowDomContainerProps {
  children: React.ReactNode;
  styles?: string;
}

/**
 * Shadow DOM container that isolates widget styles from the host page.
 * Prevents style leakage in both directions:
 * - Host page styles cannot affect widget elements
 * - Widget styles cannot affect host page elements
 */
export function ShadowDomContainer({
  children,
  styles = "",
}: ShadowDomContainerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  const [mountPoint, setMountPoint] = useState<HTMLDivElement | null>(null);

  const initShadowDom = useCallback(() => {
    if (!hostRef.current) return;

    // Only attach shadow root once
    if (hostRef.current.shadowRoot) {
      setShadowRoot(hostRef.current.shadowRoot);
      const existing =
        hostRef.current.shadowRoot.getElementById("widget-mount");
      if (existing) {
        setMountPoint(existing as HTMLDivElement);
      }
      return;
    }

    const shadow = hostRef.current.attachShadow({ mode: "open" });

    // Inject styles into the shadow DOM
    const styleElement = document.createElement("style");
    styleElement.textContent = styles;
    shadow.appendChild(styleElement);

    // Create mount point for React portal
    const mount = document.createElement("div");
    mount.id = "widget-mount";
    shadow.appendChild(mount);

    setShadowRoot(shadow);
    setMountPoint(mount);
  }, [styles]);

  useEffect(() => {
    initShadowDom();
  }, [initShadowDom]);

  // Update styles when they change
  useEffect(() => {
    if (!shadowRoot) return;
    const styleEl = shadowRoot.querySelector("style");
    if (styleEl) {
      styleEl.textContent = styles;
    }
  }, [styles, shadowRoot]);

  return (
    <div ref={hostRef} data-testid="shadow-host">
      {mountPoint && createPortal(children, mountPoint)}
    </div>
  );
}
