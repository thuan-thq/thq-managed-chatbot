import { BrandingConfig } from "./branding";

/**
 * Generate CSS string for injection into the Shadow DOM.
 * Uses CSS custom properties derived from branding config.
 * All styles are scoped within the shadow boundary.
 */
export function generateWidgetStyles(branding: BrandingConfig): string {
  return `
    :host {
      all: initial;
      display: block;
      font-family: ${branding.fontFamily};
      --widget-primary: ${branding.primaryColour};
      --widget-accent: ${branding.accentColour};
      --widget-font: ${branding.fontFamily};
      --widget-radius: 12px;
      --widget-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      --widget-transition: 200ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .widget-root {
      position: fixed;
      ${branding.bubblePosition === "bottom-right" ? "right: 16px;" : "left: 16px;"}
      bottom: 16px;
      z-index: 2147483647;
      font-family: var(--widget-font);
      font-size: 14px;
      line-height: 1.5;
      color: #1f2937;
    }

    /* Responsive positioning */
    @media (min-width: 640px) {
      .widget-root {
        ${branding.bubblePosition === "bottom-right" ? "right: 24px;" : "left: 24px;"}
        bottom: 24px;
      }
    }

    /* Trigger bubble button */
    .widget-trigger {
      width: 56px;
      height: 56px;
      min-width: 44px;
      min-height: 44px;
      border-radius: 50%;
      background-color: var(--widget-primary);
      color: white;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--widget-shadow);
      transition: transform var(--widget-transition), opacity var(--widget-transition);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .widget-trigger:hover {
      transform: scale(1.05);
    }

    .widget-trigger:active {
      transform: scale(0.95);
    }

    .widget-trigger:focus-visible {
      outline: 2px solid var(--widget-primary);
      outline-offset: 2px;
    }

    .widget-trigger svg {
      width: 24px;
      height: 24px;
    }

    .widget-trigger[aria-expanded="true"] {
      transform: scale(0);
      opacity: 0;
      pointer-events: none;
    }

    /* Chat panel */
    .widget-panel {
      position: absolute;
      bottom: 72px;
      ${branding.bubblePosition === "bottom-right" ? "right: 0;" : "left: 0;"}
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 520px;
      max-height: calc(100vh - 120px);
      min-height: 300px;
      background: white;
      border-radius: var(--widget-radius);
      box-shadow: var(--widget-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform-origin: bottom ${branding.bubblePosition === "bottom-right" ? "right" : "left"};
      transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1),
                  opacity 200ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .widget-panel[data-state="closed"] {
      transform: scale(0.9) translateY(8px);
      opacity: 0;
      pointer-events: none;
    }

    .widget-panel[data-state="open"] {
      transform: scale(1) translateY(0);
      opacity: 1;
    }

    /* Responsive: full-screen on very small viewports */
    @media (max-width: 480px) {
      .widget-panel {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        max-width: 100%;
        height: 100%;
        max-height: 100%;
        border-radius: 0;
      }
    }

    /* Header */
    .widget-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      background: var(--widget-primary);
      color: white;
      flex-shrink: 0;
    }

    .widget-header-logo {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      object-fit: contain;
      flex-shrink: 0;
    }

    .widget-header-title {
      font-size: 15px;
      font-weight: 600;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .widget-close-btn {
      width: 44px;
      height: 44px;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      color: white;
      cursor: pointer;
      border-radius: 6px;
      transition: background var(--widget-transition);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .widget-close-btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    .widget-close-btn:focus-visible {
      outline: 2px solid white;
      outline-offset: -2px;
    }

    .widget-close-btn svg {
      width: 20px;
      height: 20px;
    }

    /* Messages area */
    .widget-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .widget-welcome {
      text-align: center;
      color: #6b7280;
      font-size: 13px;
      padding: 24px 16px;
    }

    .widget-message {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .widget-message--user {
      align-self: flex-end;
      background: var(--widget-primary);
      color: white;
      border-bottom-right-radius: 4px;
    }

    .widget-message--assistant {
      align-self: flex-start;
      background: #f3f4f6;
      color: #1f2937;
      border-bottom-left-radius: 4px;
    }

    /* Markdown content styling for assistant messages */
    .widget-message-content {
      line-height: 1.6;
    }

    .widget-message-content p {
      margin: 0 0 8px 0;
    }

    .widget-message-content p:last-child {
      margin-bottom: 0;
    }

    .widget-message-content h3 {
      font-size: 15px;
      font-weight: 600;
      margin: 12px 0 6px 0;
    }

    .widget-message-content h3:first-child {
      margin-top: 0;
    }

    .widget-message-content h4 {
      font-size: 14px;
      font-weight: 600;
      margin: 10px 0 4px 0;
    }

    .widget-message-content h4:first-child {
      margin-top: 0;
    }

    .widget-message-content ul,
    .widget-message-content ol {
      margin: 6px 0;
      padding-left: 20px;
    }

    .widget-message-content li {
      margin-bottom: 4px;
    }

    .widget-message-content strong {
      font-weight: 600;
    }

    .widget-message-content em {
      font-style: italic;
    }

    .widget-message-content code {
      background: rgba(0, 0, 0, 0.06);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 13px;
    }

    .widget-message-content a {
      color: var(--widget-primary);
      text-decoration: underline;
      word-break: break-all;
    }

    .widget-message-content a:hover {
      opacity: 0.8;
    }

    .widget-message-content br {
      display: block;
      content: "";
      margin-top: 8px;
    }

    /* Input area */
    .widget-input-area {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .widget-input {
      flex: 1;
      min-height: 44px;
      max-height: 120px;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-family: var(--widget-font);
      font-size: 14px;
      line-height: 1.5;
      resize: none;
      outline: none;
      transition: border-color var(--widget-transition);
    }

    .widget-input:focus {
      border-color: var(--widget-primary);
    }

    .widget-input::placeholder {
      color: #9ca3af;
    }

    .widget-send-btn {
      width: 44px;
      height: 44px;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--widget-primary);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background var(--widget-transition), opacity var(--widget-transition);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .widget-send-btn:hover:not(:disabled) {
      background: var(--widget-accent);
    }

    .widget-send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .widget-send-btn:focus-visible {
      outline: 2px solid var(--widget-primary);
      outline-offset: 2px;
    }

    .widget-send-btn svg {
      width: 20px;
      height: 20px;
    }

    /* Error state */
    .widget-error {
      padding: 12px 16px;
      background: #fef2f2;
      border-top: 1px solid #fecaca;
      color: #991b1b;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .widget-error-dismiss {
      margin-left: auto;
      width: 44px;
      height: 44px;
      min-width: 44px;
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      color: #991b1b;
      cursor: pointer;
      border-radius: 4px;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .widget-error-dismiss:focus-visible {
      outline: 2px solid #991b1b;
      outline-offset: 2px;
    }

    /* Streaming indicator */
    .widget-typing {
      display: flex;
      gap: 4px;
      padding: 10px 14px;
      align-self: flex-start;
      background: #f3f4f6;
      border-radius: 12px;
      border-bottom-left-radius: 4px;
    }

    .widget-typing-dot {
      width: 6px;
      height: 6px;
      background: #9ca3af;
      border-radius: 50%;
      animation: typing-bounce 1.4s infinite;
    }

    .widget-typing-dot:nth-child(2) {
      animation-delay: 0.2s;
    }

    .widget-typing-dot:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-4px); }
    }

    /* Citation card displayed below assistant message text */
    .widget-citation {
      margin-top: 8px;
      padding: 8px 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
    }

    .widget-citation-title {
      color: #374151;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .widget-citation-score {
      flex-shrink: 0;
      padding: 2px 8px;
      background: #dbeafe;
      color: #1e40af;
      border-radius: 99px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }

    /* Retry button shown inside the error bar */
    .widget-error-retry {
      margin-left: 8px;
      padding: 6px 14px;
      min-width: 44px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #991b1b;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-family: var(--widget-font);
      cursor: pointer;
      transition: background var(--widget-transition);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .widget-error-retry:hover {
      background: #7f1d1d;
    }

    .widget-error-retry:focus-visible {
      outline: 2px solid #991b1b;
      outline-offset: 2px;
    }

    /* Countdown display for 429 rate-limit errors */
    .widget-rate-limit-countdown {
      font-weight: 600;
      margin-left: 4px;
    }

    /* Session terminal banner (expired / exhausted) */
    .widget-session-banner {
      padding: 12px 16px;
      background: #fefce8;
      border-top: 1px solid #fde68a;
      color: #92400e;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .widget-session-banner-text {
      flex: 1;
      line-height: 1.4;
    }

    .widget-new-session-btn {
      flex-shrink: 0;
      padding: 8px 16px;
      min-width: 44px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #92400e;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      font-family: var(--widget-font);
      cursor: pointer;
      white-space: nowrap;
      transition: background var(--widget-transition);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .widget-new-session-btn:hover {
      background: #78350f;
    }

    .widget-new-session-btn:focus-visible {
      outline: 2px solid #92400e;
      outline-offset: 2px;
    }

    /* Readonly overlay on input area when session is terminal */
    .widget-input-area--readonly {
      background: #f9fafb;
      pointer-events: none;
      opacity: 0.5;
    }
  `;
}
