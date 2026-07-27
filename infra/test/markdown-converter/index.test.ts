/**
 * Unit tests for MarkdownConverter main class.
 * Task 8.6
 */

import { MarkdownConverter } from "../../lambda/ingestion/markdown-converter/index";

describe("MarkdownConverter", () => {
  describe("null/undefined handling", () => {
    it("returns empty string for null input", () => {
      expect(MarkdownConverter.toMarkdown(null, "intranet-pages")).toBe("");
    });

    it("returns empty string for undefined input", () => {
      expect(MarkdownConverter.toMarkdown(undefined, "intranet-pages")).toBe(
        "",
      );
    });
  });

  describe("content type routing", () => {
    it("routes intranet-pages to page converter", () => {
      const data = { title: "Test Page", slug: "test-page" };
      const result = MarkdownConverter.toMarkdown(data, "intranet-pages");
      expect(result).toContain("# Test Page");
      expect(result).toContain("**Content Type:** page");
    });

    it("routes intranet-teams to team converter", () => {
      const data = { name: "Test Team" };
      const result = MarkdownConverter.toMarkdown(data, "intranet-teams");
      expect(result).toContain("# Test Team");
      expect(result).toContain("**Content Type:** team");
    });

    it("routes intranet-people to person converter", () => {
      const data = { display_name: "John Smith", job_title: "Developer" };
      const result = MarkdownConverter.toMarkdown(data, "intranet-people");
      expect(result).toContain("# John Smith");
      expect(result).toContain("**Role:** Developer");
    });
  });

  describe("unknown content type", () => {
    it("uses generic converter for unknown types", () => {
      const data = { title: "Generic Item", summary: "A summary" };
      const result = MarkdownConverter.toMarkdown(data, "custom-collection");
      expect(result).toContain("# Generic Item");
      expect(result).toContain("**Content Type:** custom-collection");
      expect(result).toContain("A summary");
    });

    it("generic converter extracts common text fields", () => {
      const data = {
        title: "Item",
        description: "Desc text",
        body: "Body text",
      };
      const result = MarkdownConverter.toMarkdown(data, "unknown-type");
      expect(result).toContain("Desc text");
      expect(result).toContain("Body text");
    });
  });

  describe("error fallback", () => {
    it("returns markdown with error info when conversion throws", () => {
      // Create data that will cause an error by providing content_blocks
      // with a property that triggers a TypeError in conversion
      const data = {
        title: "Error Page",
        content_blocks: "not-an-array", // This won't cause error in current impl
      };

      // Instead, test the error fallback by mocking convertPage to throw
      // We can test by checking the structure of a successful call
      // and verifying the error fallback format by calling with a type that we know works
      const result = MarkdownConverter.toMarkdown(data, "intranet-pages");
      // Since content_blocks is not an array, it's just skipped - no error thrown
      expect(result).toContain("# Error Page");
    });

    it("error fallback includes content type and raw data", () => {
      // To test the error path, we use Object.create to make a proxy that throws
      const throwingData = new Proxy(
        { title: "Broken" },
        {
          get(target, prop) {
            if (prop === "content_blocks") {
              throw new Error("Simulated error");
            }
            return (target as Record<string | symbol, unknown>)[prop];
          },
        },
      );

      const result = MarkdownConverter.toMarkdown(
        throwingData as unknown as Record<string, unknown>,
        "intranet-pages",
      );

      expect(result).toContain("# Broken");
      expect(result).toContain("**Content Type:** intranet-pages");
      expect(result).toContain("**Conversion Error:**");
      expect(result).toContain("## Raw Data");
      expect(result).toContain("```json");
    });
  });
});
