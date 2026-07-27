/**
 * Unit tests for markdown-converter helpers module.
 * Tasks 8.1, 8.2, 8.3
 */

import {
  toSlug,
  parseHTMLTableToMarkdown,
  formatMetadata,
  formatImage,
  formatLink,
  formatFile,
} from "../../lambda/ingestion/markdown-converter/helpers";

// ─── Task 8.1: toSlug ────────────────────────────────────────────────────────

describe("toSlug", () => {
  it("converts special characters", () => {
    expect(toSlug("Hello World!")).toBe("hello-world");
  });

  it("removes unicode characters", () => {
    expect(toSlug("Café Résumé")).toBe("caf-rsum");
  });

  it("handles empty strings", () => {
    expect(toSlug("")).toBe("");
  });

  it("is idempotent (already-slugified input)", () => {
    const slug = "already-slugified";
    expect(toSlug(slug)).toBe(slug);
    expect(toSlug(toSlug(slug))).toBe(slug);
  });

  it("collapses multiple spaces into single hyphen", () => {
    expect(toSlug("hello    world")).toBe("hello-world");
  });

  it("collapses multiple hyphens", () => {
    expect(toSlug("hello---world")).toBe("hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    expect(toSlug("-hello-world-")).toBe("hello-world");
    expect(toSlug("  hello  ")).toBe("hello");
  });

  it("handles mixed special chars, spaces, and hyphens", () => {
    expect(toSlug("  --My Page Title!!--  ")).toBe("my-page-title");
  });
});

// ─── Task 8.2: parseHTMLTableToMarkdown ──────────────────────────────────────

describe("parseHTMLTableToMarkdown", () => {
  it("parses table with <th> headers", () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Age</th></tr>
        <tr><td>Alice</td><td>30</td></tr>
        <tr><td>Bob</td><td>25</td></tr>
      </table>
    `;
    const result = parseHTMLTableToMarkdown(html);
    expect(result).toContain("| Name | Age |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Alice | 30 |");
    expect(result).toContain("| Bob | 25 |");
  });

  it("uses first row as header for td-only tables", () => {
    const html = `
      <table>
        <tr><td>Header1</td><td>Header2</td></tr>
        <tr><td>Value1</td><td>Value2</td></tr>
      </table>
    `;
    const result = parseHTMLTableToMarkdown(html);
    expect(result).toContain("| Header1 | Header2 |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| Value1 | Value2 |");
  });

  it("returns code block for malformed HTML (no table rows)", () => {
    const html = "<p>not a table</p>";
    const result = parseHTMLTableToMarkdown(html);
    expect(result).toContain("```html");
    expect(result).toContain("<p>not a table</p>");
    expect(result).toContain("```");
  });

  it("returns code block for empty tables", () => {
    const html = "<table></table>";
    const result = parseHTMLTableToMarkdown(html);
    expect(result).toContain("```html");
    expect(result).toContain("<table></table>");
  });

  it("decodes HTML entities (&nbsp;, &amp;, etc.)", () => {
    const html = `
      <table>
        <tr><th>Col&nbsp;1</th><th>Col&amp;2</th></tr>
        <tr><td>&lt;value&gt;</td><td>&quot;test&quot;</td></tr>
      </table>
    `;
    const result = parseHTMLTableToMarkdown(html);
    expect(result).toContain("Col 1");
    expect(result).toContain("Col&2");
    expect(result).toContain("<value>");
    expect(result).toContain('"test"');
  });
});

// ─── Task 8.3: formatMetadata, formatImage, formatLink, formatFile ───────────

describe("formatMetadata", () => {
  it("includes content type", () => {
    const result = formatMetadata({}, "intranet-pages");
    expect(result).toContain("**Content Type:** intranet-pages");
  });

  it("includes dates when present", () => {
    const data = {
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-15T00:00:00.000Z",
      publishedAt: "2024-01-10T00:00:00.000Z",
    };
    const result = formatMetadata(data, "intranet-pages");
    expect(result).toContain("**Created:**");
    expect(result).toContain("**Updated:**");
    expect(result).toContain("**Published:**");
  });

  it("includes tags from array", () => {
    const data = { tags: [{ name: "News" }, { name: "Update" }] };
    const result = formatMetadata(data, "intranet-pages");
    expect(result).toContain("**Tags:** News, Update");
  });

  it("includes team name from object", () => {
    const data = { team: { name: "Engineering" } };
    const result = formatMetadata(data, "intranet-teams");
    expect(result).toContain("**Team:** Engineering");
  });

  it("includes office name from object", () => {
    const data = { office: { name: "Melbourne" } };
    const result = formatMetadata(data, "intranet-pages");
    expect(result).toContain("**Office:** Melbourne");
  });

  it("includes source URL when provided", () => {
    const result = formatMetadata(
      {},
      "intranet-pages",
      "https://example.com/page",
    );
    expect(result).toContain("**View online:** https://example.com/page");
  });
});

describe("formatImage", () => {
  it("formats image with alt text", () => {
    const result = formatImage({ url: "/img.png", alternativeText: "A photo" });
    expect(result).toBe("![A photo](/img.png)");
  });

  it("formats image with caption", () => {
    const result = formatImage({
      url: "/img.png",
      alternativeText: "Photo",
      caption: "Team event",
    });
    expect(result).toBe("![Photo](/img.png)\n*Team event*");
  });

  it("falls back to name for alt text", () => {
    const result = formatImage({ url: "/img.png", name: "logo.png" });
    expect(result).toBe("![logo.png](/img.png)");
  });

  it("uses default alt text when neither alternativeText nor name provided", () => {
    const result = formatImage({ url: "/img.png" });
    expect(result).toBe("![image](/img.png)");
  });
});

describe("formatLink", () => {
  it("formats a simple link", () => {
    expect(formatLink("Click here", "https://example.com")).toBe(
      "[Click here](https://example.com)",
    );
  });

  it("adds external indicator when targetBlank is true", () => {
    expect(formatLink("External", "https://example.com", true)).toBe(
      "[External](https://example.com) ↗",
    );
  });

  it("does not add indicator when targetBlank is false", () => {
    expect(formatLink("Internal", "/page", false)).toBe("[Internal](/page)");
  });
});

describe("formatFile", () => {
  it("formats file with extension and size in KB", () => {
    const result = formatFile({
      url: "/file.pdf",
      name: "report.pdf",
      ext: ".pdf",
      size: 512,
    });
    expect(result).toBe("[report.pdf (PDF, 512 KB)](/file.pdf)");
  });

  it("formats file with size in MB", () => {
    const result = formatFile({
      url: "/file.zip",
      name: "archive.zip",
      ext: ".zip",
      size: 2048,
    });
    expect(result).toBe("[archive.zip (ZIP, 2.0 MB)](/file.zip)");
  });

  it("formats file with no ext or size", () => {
    const result = formatFile({ url: "/file", name: "data" });
    expect(result).toBe("[data](/file)");
  });

  it("uses default name when not provided", () => {
    const result = formatFile({ url: "/unknown" });
    expect(result).toBe("[file](/unknown)");
  });
});
