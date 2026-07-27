/**
 * Unit tests for markdown-converter content-blocks module.
 * Task 8.4
 */

import { convertContentBlock } from "../../lambda/ingestion/markdown-converter/content-blocks";
import type { ContentBlock } from "../../lambda/ingestion/markdown-converter/types";

describe("convertContentBlock", () => {
  // ─── Null/undefined handling ─────────────────────────────────────────

  it("returns empty string for null block", () => {
    expect(convertContentBlock(null as unknown as ContentBlock)).toBe("");
  });

  it("returns empty string for undefined block", () => {
    expect(convertContentBlock(undefined as unknown as ContentBlock)).toBe("");
  });

  // ─── Text block ─────────────────────────────────────────────────────

  it("converts text-block with simple text", () => {
    const block: ContentBlock = {
      __component: "dynamic.text-block",
      text: "Hello world\n\nThis is paragraph two.",
    };
    const result = convertContentBlock(block);
    expect(result).toContain("Hello world");
    expect(result).toContain("This is paragraph two.");
  });

  // ─── Accordion ──────────────────────────────────────────────────────

  it("converts accordion with items", () => {
    const block: ContentBlock = {
      __component: "dynamic.accordion",
      items: [
        { __component: "", title: "FAQ 1", summary: "Answer 1" },
        { __component: "", title: "FAQ 2", summary: "Answer 2" },
      ],
    };
    const result = convertContentBlock(block);
    expect(result).toContain("### FAQ 1");
    expect(result).toContain("Answer 1");
    expect(result).toContain("### FAQ 2");
    expect(result).toContain("Answer 2");
  });

  // ─── 50-50 text-n-image ─────────────────────────────────────────────

  it("converts 50-50-text-n-image with left and right sections", () => {
    const block: ContentBlock = {
      __component: "dynamic.50-50-text-n-image",
      left: {
        __component: "",
        title: "Left Title",
        text: "Left body text",
      },
      right: {
        __component: "",
        title: "Right Title",
        text: "Right body text",
      },
    };
    const result = convertContentBlock(block);
    expect(result).toContain("**Left Title**");
    expect(result).toContain("Left body text");
    expect(result).toContain("**Right Title**");
    expect(result).toContain("Right body text");
  });

  // ─── Double text block ──────────────────────────────────────────────

  it("converts double-text-block with column titles and bodies", () => {
    const block: ContentBlock = {
      __component: "dynamic.double-text-block",
      leftColumnTitle: "Column A",
      leftColumnBody: "Content A",
      rightColumnTitle: "Column B",
      rightColumnBody: "Content B",
    };
    const result = convertContentBlock(block);
    expect(result).toContain("**Column A**");
    expect(result).toContain("Content A");
    expect(result).toContain("**Column B**");
    expect(result).toContain("Content B");
  });

  // ─── Links ──────────────────────────────────────────────────────────

  it("converts links with link items", () => {
    const block: ContentBlock = {
      __component: "sidebar.link-block",
      title: "Useful Links",
      links: [
        { text: "Google", url: "https://google.com", target_blank: true },
        { text: "Internal", url: "/page" },
      ],
    };
    const result = convertContentBlock(block);
    expect(result).toContain("**Useful Links**");
    expect(result).toContain("[Google](https://google.com) ↗");
    expect(result).toContain("[Internal](/page)");
  });

  // ─── Documents ──────────────────────────────────────────────────────

  it("converts documents with file items", () => {
    const block: ContentBlock = {
      __component: "sidebar.document-block",
      title: "Downloads",
      files: {
        data: [
          {
            attributes: {
              url: "/doc.pdf",
              name: "guide.pdf",
              ext: ".pdf",
              size: 100,
            },
          },
        ],
      },
    };
    const result = convertContentBlock(block);
    expect(result).toContain("**Downloads**");
    expect(result).toContain("[guide.pdf (PDF, 100 KB)](/doc.pdf)");
  });

  // ─── Photos ─────────────────────────────────────────────────────────

  it("converts photos with photo data", () => {
    const block: ContentBlock = {
      __component: "dynamic.photos-block",
      photos: {
        data: [
          {
            attributes: {
              url: "/photo1.jpg",
              alternativeText: "Team photo",
            },
          },
          {
            attributes: {
              url: "/photo2.jpg",
              name: "office.jpg",
            },
          },
        ],
      },
    };
    const result = convertContentBlock(block);
    expect(result).toContain("![Team photo](/photo1.jpg)");
    expect(result).toContain("![office.jpg](/photo2.jpg)");
  });

  // ─── Table ──────────────────────────────────────────────────────────

  it("converts table with HTML table content", () => {
    const block: ContentBlock = {
      __component: "dynamic.table",
      table:
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    };
    const result = convertContentBlock(block);
    expect(result).toContain("| A | B |");
    expect(result).toContain("| --- | --- |");
    expect(result).toContain("| 1 | 2 |");
  });

  // ─── Link cards ─────────────────────────────────────────────────────

  it("converts link-cards with cards", () => {
    const block: ContentBlock = {
      __component: "intranet-blocks.link-cards",
      cards: [
        { title: "Card 1", link: "https://example.com/1" },
        { title: "Card 2", link: "https://example.com/2" },
      ],
    };
    const result = convertContentBlock(block);
    expect(result).toContain("### Card 1");
    expect(result).toContain("[Card 1](https://example.com/1)");
    expect(result).toContain("### Card 2");
    expect(result).toContain("[Card 2](https://example.com/2)");
  });

  // ─── Unknown block fallback ─────────────────────────────────────────

  it("handles unknown block type by extracting text/title/summary", () => {
    const block: ContentBlock = {
      __component: "dynamic.some-new-block",
      title: "New Block Title",
      text: "Some content here",
    };
    const result = convertContentBlock(block);
    expect(result).toContain("**New Block Title**");
    expect(result).toContain("Some content here");
  });

  it("returns empty string for unknown block with no text fields", () => {
    const block: ContentBlock = {
      __component: "dynamic.empty-unknown",
    };
    const result = convertContentBlock(block);
    expect(result).toBe("");
  });
});
