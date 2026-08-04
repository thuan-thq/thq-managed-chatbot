/**
 * Lightweight Markdown-to-HTML renderer for chatbot responses.
 *
 * Supports:
 *  - Headings (## and ###)
 *  - Bold (**text**)
 *  - Italic (*text* or _text_)
 *  - Unordered lists (- item or * item)
 *  - Ordered lists (1. item)
 *  - Links [text](url)
 *  - Line breaks / paragraphs
 *  - Inline code (`code`)
 *
 * Does NOT support: code blocks, tables, images, nested lists.
 * Sanitises output to prevent XSS by escaping HTML entities first.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMarkdown(markdown: string): string {
  if (!markdown) return "";

  const lines = markdown.split("\n");
  const output: string[] = [];
  let inList: "ul" | "ol" | null = null;

  function closePendingList(): void {
    if (inList === "ul") {
      output.push("</ul>");
    } else if (inList === "ol") {
      output.push("</ol>");
    }
    inList = null;
  }

  function processInline(text: string): string {
    let result = escapeHtml(text);

    // Inline code: `code`
    result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Links: [text](url)
    result = result.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );

    // Bold: **text**
    result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic: *text* or _text_ (but not inside words for underscore)
    result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<em>$1</em>");
    result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<em>$1</em>");

    return result;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Empty line = paragraph break
    if (trimmed === "") {
      closePendingList();
      output.push("<br/>");
      continue;
    }

    // Headings
    if (trimmed.startsWith("### ")) {
      closePendingList();
      output.push(`<h4>${processInline(trimmed.slice(4))}</h4>`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      closePendingList();
      output.push(`<h3>${processInline(trimmed.slice(3))}</h3>`);
      continue;
    }

    // Unordered list: - item or * item (but not bold **)
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch && !trimmed.startsWith("**")) {
      if (inList !== "ul") {
        closePendingList();
        output.push("<ul>");
        inList = "ul";
      }
      output.push(`<li>${processInline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list: 1. item
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== "ol") {
        closePendingList();
        output.push("<ol>");
        inList = "ol";
      }
      output.push(`<li>${processInline(olMatch[1])}</li>`);
      continue;
    }

    // Regular paragraph line
    closePendingList();
    output.push(`<p>${processInline(trimmed)}</p>`);
  }

  closePendingList();
  return output.join("");
}
