import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getBrandingConfig } from "./branding";

describe("getBrandingConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default values when no env vars are set", () => {
    delete process.env.NEXT_PUBLIC_PRIMARY_COLOUR;
    delete process.env.NEXT_PUBLIC_ACCENT_COLOUR;
    delete process.env.NEXT_PUBLIC_LOGO_URL;
    delete process.env.NEXT_PUBLIC_WIDGET_TITLE;
    delete process.env.NEXT_PUBLIC_FONT_FAMILY;
    delete process.env.NEXT_PUBLIC_WELCOME_MESSAGE;
    delete process.env.NEXT_PUBLIC_BUBBLE_POSITION;

    const config = getBrandingConfig();

    expect(config.primaryColour).toBe("#2563eb");
    expect(config.accentColour).toBe("#1d4ed8");
    expect(config.logoUrl).toBeNull();
    expect(config.widgetTitle).toBe("Chat Assistant");
    expect(config.fontFamily).toBe("system-ui, -apple-system, sans-serif");
    expect(config.welcomeMessage).toBe("Hi! How can I help you today?");
    expect(config.bubblePosition).toBe("bottom-right");
  });

  it("reads values from environment variables", () => {
    process.env.NEXT_PUBLIC_PRIMARY_COLOUR = "#ff0000";
    process.env.NEXT_PUBLIC_ACCENT_COLOUR = "#cc0000";
    process.env.NEXT_PUBLIC_LOGO_URL = "https://example.com/logo.png";
    process.env.NEXT_PUBLIC_WIDGET_TITLE = "My Bot";
    process.env.NEXT_PUBLIC_FONT_FAMILY = "Inter, sans-serif";
    process.env.NEXT_PUBLIC_WELCOME_MESSAGE = "Welcome!";
    process.env.NEXT_PUBLIC_BUBBLE_POSITION = "bottom-left";

    const config = getBrandingConfig();

    expect(config.primaryColour).toBe("#ff0000");
    expect(config.accentColour).toBe("#cc0000");
    expect(config.logoUrl).toBe("https://example.com/logo.png");
    expect(config.widgetTitle).toBe("My Bot");
    expect(config.fontFamily).toBe("Inter, sans-serif");
    expect(config.welcomeMessage).toBe("Welcome!");
    expect(config.bubblePosition).toBe("bottom-left");
  });

  it("returns null for logoUrl when empty string", () => {
    process.env.NEXT_PUBLIC_LOGO_URL = "";
    const config = getBrandingConfig();
    expect(config.logoUrl).toBeNull();
  });

  it("defaults to bottom-right for invalid bubble position", () => {
    process.env.NEXT_PUBLIC_BUBBLE_POSITION = "top-right";
    const config = getBrandingConfig();
    expect(config.bubblePosition).toBe("bottom-right");
  });
});
