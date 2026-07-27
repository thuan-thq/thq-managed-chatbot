/**
 * MarkdownConverter class - main entry point.
 *
 * Routes Strapi entry data to the appropriate content-type converter
 * (page, team, person) and returns well-structured markdown optimized
 * for Bedrock Knowledge Base retrieval.
 *
 * Handles null/undefined input, unknown content types (generic fallback),
 * and conversion errors (error fallback markdown).
 */

import { convertPage, convertTeam, convertPerson } from "./content-types";
import { extractTitle, formatMetadata, cleanMarkdownText } from "./helpers";

// Re-export key utilities and types for external consumers
export { toSlug } from "./helpers";
export type { ContentBlock, StrapiImage, StrapiFile } from "./types";

/** Configuration options for the MarkdownConverter. */
export interface MarkdownConverterOptions {
  /** Front-end base URL for constructing source links (e.g. "https://staging.intranet.think-hq.com.au"). */
  baseUrl?: string;
}

/**
 * Main entry point for converting Strapi CMS content into markdown.
 *
 * Routes based on content type string to specialized converters.
 * Falls back to a generic converter for unknown types and returns
 * error fallback markdown if any conversion throws.
 */
export class MarkdownConverter {
  /**
   * Converts Strapi entry data to markdown.
   * Routes to the appropriate content-type converter based on contentType.
   * Returns empty string for null/undefined data.
   * Returns error fallback markdown on conversion failure.
   *
   * @param data - Strapi entry attributes
   * @param contentType - Collection name (e.g. "intranet-pages")
   * @param options - Optional config (baseUrl for source links)
   */
  static toMarkdown(
    data: Record<string, unknown> | null | undefined,
    contentType: string,
    options?: MarkdownConverterOptions,
  ): string {
    // Null/undefined guard
    if (data == null) {
      return "";
    }

    const baseUrl = options?.baseUrl;

    try {
      switch (contentType) {
        case "intranet-pages":
          return convertPage(data, baseUrl);
        case "intranet-teams":
          return convertTeam(data, baseUrl);
        case "intranet-people":
          return convertPerson(data, baseUrl);
        default:
          return MarkdownConverter.genericConvert(data, contentType);
      }
    } catch (error) {
      return MarkdownConverter.errorFallback(
        data,
        contentType,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Generic fallback converter for unknown content types.
   * Extracts title, metadata, and common text fields (summary, description, body, text).
   */
  private static genericConvert(
    data: Record<string, unknown>,
    contentType: string,
  ): string {
    const parts: string[] = [];

    // Extract title as H1
    const title = extractTitle(data);
    parts.push(`# ${title}`);

    // Metadata section
    const metadata = formatMetadata(data, contentType);
    if (metadata.length > 0) {
      parts.push(metadata);
    }

    // Extract common text fields
    const textFields = ["summary", "description", "body", "text"];
    for (const field of textFields) {
      const value = data[field];
      if (typeof value === "string" && value.length > 0) {
        parts.push(cleanMarkdownText(value));
      }
    }

    return parts.join("\n\n");
  }

  /**
   * Error fallback - returns minimal markdown with error info and raw data.
   * Ensures a document is still produced even when conversion fails.
   */
  private static errorFallback(
    data: Record<string, unknown>,
    contentType: string,
    error: Error,
  ): string {
    const title = extractTitle(data);

    const parts: string[] = [];
    parts.push(`# ${title}`);
    parts.push(`**Content Type:** ${contentType}`);
    parts.push(`**Conversion Error:** ${error.message}`);
    parts.push("## Raw Data\n");
    parts.push("```json\n" + JSON.stringify(data, null, 2) + "\n```");

    return parts.join("\n\n");
  }
}
