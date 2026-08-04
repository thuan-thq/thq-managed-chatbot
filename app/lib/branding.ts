/**
 * Branding configuration loaded from build-time environment variables.
 * No runtime API calls to AWS — changes require a Vercel redeploy.
 */
export interface BrandingConfig {
  primaryColour: string;
  accentColour: string;
  logoUrl: string | null;
  widgetTitle: string;
  fontFamily: string;
  welcomeMessage: string;
  bubblePosition: "bottom-right" | "bottom-left";
}

const DEFAULT_PRIMARY_COLOUR = "#2563eb";
const DEFAULT_ACCENT_COLOUR = "#1d4ed8";
const DEFAULT_WIDGET_TITLE = "Chat Assistant";
const DEFAULT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
const DEFAULT_WELCOME_MESSAGE = "Hi! How can I help you today?";
const DEFAULT_BUBBLE_POSITION = "bottom-right";

function parseBubblePosition(
  value: string | undefined,
): "bottom-right" | "bottom-left" {
  if (value === "bottom-left") return "bottom-left";
  return DEFAULT_BUBBLE_POSITION;
}

export function getBrandingConfig(): BrandingConfig {
  return {
    primaryColour:
      process.env.NEXT_PUBLIC_PRIMARY_COLOUR || DEFAULT_PRIMARY_COLOUR,
    accentColour:
      process.env.NEXT_PUBLIC_ACCENT_COLOUR || DEFAULT_ACCENT_COLOUR,
    logoUrl: process.env.NEXT_PUBLIC_LOGO_URL || null,
    widgetTitle: process.env.NEXT_PUBLIC_WIDGET_TITLE || DEFAULT_WIDGET_TITLE,
    fontFamily: process.env.NEXT_PUBLIC_FONT_FAMILY || DEFAULT_FONT_FAMILY,
    welcomeMessage:
      process.env.NEXT_PUBLIC_WELCOME_MESSAGE || DEFAULT_WELCOME_MESSAGE,
    bubblePosition: parseBubblePosition(
      process.env.NEXT_PUBLIC_BUBBLE_POSITION,
    ),
  };
}
