import { describe, it, expect } from "vitest";
import { generateWidgetStyles } from "./widget-styles";
import { BrandingConfig } from "./branding";

const defaultBranding: BrandingConfig = {
  primaryColour: "#2563eb",
  accentColour: "#1d4ed8",
  logoUrl: null,
  widgetTitle: "Test",
  fontFamily: "system-ui, sans-serif",
  welcomeMessage: "Hello",
  bubblePosition: "bottom-right",
};

describe("generateWidgetStyles", () => {
  it("generates CSS string with branding colours", () => {
    const styles = generateWidgetStyles(defaultBranding);
    expect(styles).toContain("--widget-primary: #2563eb");
    expect(styles).toContain("--widget-accent: #1d4ed8");
  });

  it("includes font family from branding", () => {
    const styles = generateWidgetStyles(defaultBranding);
    expect(styles).toContain("system-ui, sans-serif");
  });

  it("positions widget to bottom-right by default", () => {
    const styles = generateWidgetStyles(defaultBranding);
    expect(styles).toContain("right: 16px");
    expect(styles).toContain("bottom: 16px");
  });

  it("positions widget to bottom-left when configured", () => {
    const leftBranding = {
      ...defaultBranding,
      bubblePosition: "bottom-left" as const,
    };
    const styles = generateWidgetStyles(leftBranding);
    expect(styles).toContain("left: 16px");
    expect(styles).toContain("bottom: 16px");
  });

  it("enforces 44x44px minimum touch targets", () => {
    const styles = generateWidgetStyles(defaultBranding);
    expect(styles).toContain("min-width: 44px");
    expect(styles).toContain("min-height: 44px");
  });

  it("uses animation duration under 300ms", () => {
    const styles = generateWidgetStyles(defaultBranding);
    // All transitions use 200ms
    expect(styles).toContain("200ms");
    // Ensure no 300ms+ transitions
    expect(styles).not.toMatch(/(?:3[0-9]{2}|[4-9]\d{2}|\d{4,})ms.*transition/);
  });

  it("includes responsive breakpoints for viewport range", () => {
    const styles = generateWidgetStyles(defaultBranding);
    // Should have media query for small viewports (<=480px goes full-screen)
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain("width: 100%");
  });

  it("contains :host rule for shadow DOM isolation", () => {
    const styles = generateWidgetStyles(defaultBranding);
    expect(styles).toContain(":host");
    expect(styles).toContain("all: initial");
  });

  it("includes box-sizing reset within shadow DOM", () => {
    const styles = generateWidgetStyles(defaultBranding);
    expect(styles).toContain("box-sizing: border-box");
  });
});
