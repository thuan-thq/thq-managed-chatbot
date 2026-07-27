/**
 * Helpers - shared formatting utilities for markdown conversion.
 *
 * Provides: formatMetadata, extractTitle, formatImage, formatLink,
 * formatFile, parseHTMLTableToMarkdown, cleanMarkdownText,
 * normalizeTags, and toSlug.
 *
 * Used by both content-type and content-block converters.
 * No external dependencies - uses built-in string operations and regex.
 */

import type { StrapiImage, StrapiFile } from "./types";

// ─── Slug Generation ─────────────────────────────────────────────────────────

/**
 * Converts a title/name string to a URL-safe slug.
 * Lowercase, hyphens for spaces, no special characters.
 */
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // remove special characters
    .replace(/\s+/g, "-") // spaces to hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
}

// ─── HTML Table Parsing ──────────────────────────────────────────────────────

/**
 * Parses an HTML table string into markdown table format.
 * Uses regex-based extraction. Falls back to wrapping raw HTML
 * in a code block if parsing fails.
 */
export function parseHTMLTableToMarkdown(html: string): string {
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  const headerCellRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;

  const rows: string[][] = [];
  let hasHeaderRow = false;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const cells: string[] = [];

    // Check if this row contains <th> elements
    const headerTest = rowContent.match(headerCellRegex);
    if (headerTest && rows.length === 0) {
      hasHeaderRow = true;
    }

    let cellMatch: RegExpExecArray | null;
    const localCellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    while ((cellMatch = localCellRegex.exec(rowContent)) !== null) {
      let cellText = cellMatch[1];
      // Strip HTML tags
      cellText = cellText.replace(/<[^>]+>/g, "");
      // Decode common HTML entities
      cellText = decodeHTMLEntities(cellText);
      cells.push(cellText.trim());
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  // Fallback: if no rows extracted, wrap in code block
  if (rows.length === 0) {
    return "```html\n" + html + "\n```";
  }

  // Determine header and data rows
  let headerRow: string[];
  let dataRows: string[][];

  if (hasHeaderRow) {
    headerRow = rows[0];
    dataRows = rows.slice(1);
  } else {
    // Use first row as header
    headerRow = rows[0];
    dataRows = rows.slice(1);
  }

  // Normalize column count across all rows
  const colCount = Math.max(headerRow.length, ...dataRows.map((r) => r.length));

  // Pad rows to consistent column count
  while (headerRow.length < colCount) {
    headerRow.push("");
  }
  dataRows = dataRows.map((row) => {
    while (row.length < colCount) {
      row.push("");
    }
    return row;
  });

  // Build markdown table
  const lines: string[] = [];
  lines.push("| " + headerRow.join(" | ") + " |");
  lines.push("| " + headerRow.map(() => "---").join(" | ") + " |");
  for (const row of dataRows) {
    lines.push("| " + row.join(" | ") + " |");
  }

  return lines.join("\n");
}

/**
 * Decodes common HTML entities to their character equivalents.
 */
function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ─── Metadata Formatting ────────────────────────────────────────────────────

/**
 * Formats a date string as a locale date string.
 */
function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString();
  } catch {
    return dateStr;
  }
}

/**
 * Formats a metadata section with bold-labeled key-value pairs.
 * Matches the old export service format (lib/export/converters/helpers.ts).
 */
export function formatMetadata(
  data: Record<string, unknown>,
  contentType: string,
  sourceUrl?: string,
): string {
  const lines: string[] = [];

  lines.push(`**Content Type:** ${contentType}`);

  if (data["id"]) {
    lines.push(`**ID:** ${data["id"]}`);
  }

  const slug = data["slug"];
  if (typeof slug === "string" && slug.length > 0) {
    lines.push(`**Slug:** ${slug}`);
  }

  // Dates (formatted as locale date string like old export service)
  const createdAt = data["createdAt"] || data["created_at"];
  if (typeof createdAt === "string") {
    lines.push(`**Created:** ${formatDate(createdAt)}`);
  }

  const updatedAt = data["updatedAt"] || data["updated_at"];
  if (typeof updatedAt === "string") {
    lines.push(`**Updated:** ${formatDate(updatedAt)}`);
  }

  const publishedAt = data["publishedAt"] || data["published_at"];
  if (typeof publishedAt === "string") {
    lines.push(`**Published:** ${formatDate(publishedAt)}`);
  }

  // People fields
  const jobTitle = data["job_title"] || data["jobTitle"];
  if (typeof jobTitle === "string" && jobTitle.length > 0) {
    lines.push(`**Job Title:** ${jobTitle}`);
  }

  const email = data["email"];
  if (typeof email === "string" && email.length > 0) {
    lines.push(`**Email:** ${email}`);
  }

  const phone = data["phone"];
  if (typeof phone === "string" && phone.length > 0) {
    lines.push(`**Phone:** ${phone}`);
  }

  const location = data["location"];
  if (typeof location === "string" && location.length > 0) {
    lines.push(`**Location:** ${location}`);
  }

  // Team (from intranet_team relation)
  const intranetTeam = data["intranet_team"] as
    | Record<string, unknown>
    | undefined;
  if (intranetTeam?.data) {
    const teamAttrs = (intranetTeam["data"] as Record<string, unknown>)?.[
      "attributes"
    ] as Record<string, unknown> | undefined;
    if (teamAttrs) {
      const teamName = teamAttrs["title"] || teamAttrs["name"];
      const teamSlug = teamAttrs["slug"];
      if (typeof teamName === "string" && typeof teamSlug === "string") {
        lines.push(`**Team:** [${teamName}](/team/${teamSlug})`);
      } else if (typeof teamName === "string") {
        lines.push(`**Team:** ${teamName}`);
      }
    }
  } else {
    const team = data["team"];
    if (team && typeof team === "object") {
      const teamData = team as Record<string, unknown>;
      const teamName = teamData["name"] || teamData["title"];
      if (typeof teamName === "string") {
        lines.push(`**Team:** ${teamName}`);
      }
    } else if (typeof team === "string" && team.length > 0) {
      lines.push(`**Team:** ${team}`);
    }
  }

  // Office
  const office = data["office"];
  if (office && typeof office === "object") {
    const officeData = office as Record<string, unknown>;
    const officeName =
      officeData["name"] ||
      (
        (officeData["data"] as Record<string, unknown> | undefined)?.[
          "attributes"
        ] as Record<string, unknown> | undefined
      )?.["name"];
    if (typeof officeName === "string") {
      lines.push(`**Office:** ${officeName}`);
    }
  }
  const offices = data["offices"] as Record<string, unknown> | undefined;
  if (offices?.data && Array.isArray(offices["data"])) {
    const officeNames = (offices["data"] as Array<Record<string, unknown>>)
      .map(
        (o) =>
          (o["attributes"] as Record<string, unknown> | undefined)?.["name"],
      )
      .filter((n) => typeof n === "string")
      .join(", ");
    if (officeNames.length > 0) {
      lines.push(`**Offices:** ${officeNames}`);
    }
  }

  // Tags
  const tags = normalizeTags(data["tags"]);
  if (tags.length > 0) {
    lines.push(`**Tags:** ${tags.join(", ")}`);
  }

  // Flags
  if (data["is_initiative"] !== undefined) {
    lines.push(`**Initiative:** ${data["is_initiative"] ? "Yes" : "No"}`);
  }

  // Source URL (at the bottom, matching old export format)
  if (sourceUrl) {
    lines.push(`**View online:** ${sourceUrl}`);
  }

  return lines.join("\n") + "\n\n";
}

// ─── Image Formatting ────────────────────────────────────────────────────────

/**
 * Formats a Strapi image as a markdown image with alt text and optional caption.
 */
export function formatImage(
  image: StrapiImage | Record<string, unknown>,
): string {
  const url = (image as Record<string, unknown>)["url"] || "";
  const alt =
    (image as Record<string, unknown>)["alternativeText"] ||
    (image as Record<string, unknown>)["name"] ||
    "image";

  let result = `![${alt}](${url})`;

  const caption = (image as Record<string, unknown>)["caption"];
  if (caption) {
    result += `\n*${caption}*`;
  }

  return result;
}

// ─── Link Formatting ─────────────────────────────────────────────────────────

/**
 * Formats a markdown link with optional external indicator.
 */
export function formatLink(
  text: string,
  url: string,
  targetBlank?: boolean,
): string {
  const link = `[${text}](${url})`;
  if (targetBlank) {
    return `${link} ↗`;
  }
  return link;
}

// ─── File Formatting ─────────────────────────────────────────────────────────

/**
 * Formats a file/document attachment reference as a markdown link.
 */
export function formatFile(file: StrapiFile): string {
  const url = file.url || "";
  const name = file.name || "file";

  const details: string[] = [];
  if (file.ext) {
    details.push(file.ext.replace(/^\./, "").toUpperCase());
  }
  if (file.size) {
    details.push(formatFileSize(file.size));
  }

  const label = details.length > 0 ? `${name} (${details.join(", ")})` : name;
  return `[${label}](${url})`;
}

/**
 * Formats file size in human-readable form.
 */
function formatFileSize(sizeKb: number): string {
  if (sizeKb < 1024) {
    return `${Math.round(sizeKb)} KB`;
  }
  return `${(sizeKb / 1024).toFixed(1)} MB`;
}

// ─── Text Cleaning ───────────────────────────────────────────────────────────

/**
 * Trims and normalizes rich text content from Strapi.
 * Normalizes line endings and collapses excessive blank lines.
 */
export function cleanMarkdownText(text: string): string {
  return text
    .replace(/\r\n/g, "\n") // normalize line endings
    .replace(/\r/g, "\n") // normalize remaining CR
    .replace(/\n{3,}/g, "\n\n") // collapse excessive blank lines
    .trim();
}

// ─── Tag Normalization ───────────────────────────────────────────────────────

/**
 * Normalizes tags from various Strapi formats to a string array.
 * Handles: arrays (of strings or objects with name field),
 * comma-separated strings, and null/undefined.
 */
export function normalizeTags(tags: unknown): string[] {
  if (!tags) {
    return [];
  }

  if (Array.isArray(tags)) {
    return tags
      .map((tag) => {
        if (typeof tag === "string") {
          return tag.trim();
        }
        if (tag && typeof tag === "object") {
          const tagObj = tag as Record<string, unknown>;
          const name = tagObj["name"] || tagObj["title"] || tagObj["label"];
          if (typeof name === "string") {
            return name.trim();
          }
        }
        return "";
      })
      .filter((t) => t.length > 0);
  }

  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  return [];
}

// ─── Title Extraction ────────────────────────────────────────────────────────

/**
 * Extracts the best available title from various Strapi field patterns.
 * Checks: title, Title, name, Name, displayName, firstName+lastName.
 */
export function extractTitle(data: Record<string, unknown>): string {
  // Direct title fields
  if (typeof data["title"] === "string" && data["title"].length > 0) {
    return data["title"];
  }
  if (typeof data["Title"] === "string" && data["Title"].length > 0) {
    return data["Title"];
  }

  // Name fields
  if (typeof data["name"] === "string" && data["name"].length > 0) {
    return data["name"];
  }
  if (typeof data["Name"] === "string" && data["Name"].length > 0) {
    return data["Name"];
  }

  // Display name
  if (
    typeof data["displayName"] === "string" &&
    data["displayName"].length > 0
  ) {
    return data["displayName"];
  }

  // firstName + lastName combination
  const firstName = data["firstName"] || data["first_name"];
  const lastName = data["lastName"] || data["last_name"];
  if (typeof firstName === "string" && typeof lastName === "string") {
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName.length > 0) {
      return fullName;
    }
  }
  if (typeof firstName === "string" && firstName.length > 0) {
    return firstName;
  }

  return "Untitled";
}
