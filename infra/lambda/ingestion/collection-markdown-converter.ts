/**
 * CollectionMarkdownConverter - config-driven markdown converter.
 *
 * Converts a raw Strapi entry attributes object to a markdown document
 * using the strategy and field mappings declared in a StrapiCollectionConfig.
 *
 * Supported strategies:
 *   - content-blocks: delegates each dynamic zone element to convertContentBlock
 *   - rich-text:      reads a single rich text / HTML field as raw text
 *   - flat-fields:    concatenates configured plain-text fields, skipping blanks
 *
 * All strategies prepend a resolved title (from titleFields) and an optional
 * ## Summary section (from summaryField) before the content body.
 *
 * Requirements: 3.1, 3.3, 3.4, 3.5, 3.6
 */

import type { StrapiCollectionConfig } from "./config-types";
import { convertContentBlock } from "./markdown-converter/content-blocks";
import type { ContentBlock } from "./markdown-converter/types";

// ─── CollectionMarkdownConverter ─────────────────────────────────────────────

export class CollectionMarkdownConverter {
  /**
   * Converts a raw Strapi entry's attributes to a markdown document.
   *
   * @param attrs   - The entry's attribute object from the Strapi REST API response.
   * @param config  - The StrapiCollectionConfig that controls field mappings and strategy.
   * @param options - Optional conversion options (e.g. baseUrl for future use).
   * @returns       - A markdown string for the entry.
   */
  static convert(
    attrs: Record<string, unknown>,
    config: StrapiCollectionConfig,
    _options: { baseUrl?: string },
  ): string {
    const parts: string[] = [];

    // ── Title (Req 3.1) ──────────────────────────────────────────────────────
    const title = resolveTitle(attrs, config.fieldMappings.titleFields);
    if (title !== undefined) {
      parts.push(`# ${title}`);
    }

    // ── Summary section (Req 3.3) ────────────────────────────────────────────
    const { summaryField } = config.fieldMappings;
    if (summaryField !== undefined) {
      const summaryValue = attrs[summaryField];
      if (typeof summaryValue === "string" && summaryValue.length > 0) {
        parts.push(`## Summary\n\n${summaryValue}`);
      }
    }

    // ── Content body — strategy dispatch ─────────────────────────────────────
    const contentBody = dispatchStrategy(attrs, config);
    if (contentBody.length > 0) {
      parts.push(contentBody);
    }

    return parts.join("\n\n");
  }
}

// ─── Strategy dispatch ────────────────────────────────────────────────────────

/**
 * Dispatches to the appropriate content body converter based on the
 * collection's markdownStrategy.
 */
function dispatchStrategy(
  attrs: Record<string, unknown>,
  config: StrapiCollectionConfig,
): string {
  switch (config.markdownStrategy) {
    case "content-blocks":
      return convertContentBlocksStrategy(attrs, config);

    case "rich-text":
      return convertRichTextStrategy(attrs, config);

    case "flat-fields":
      return convertFlatFieldsStrategy(attrs, config);

    default:
      return "";
  }
}

// ─── content-blocks strategy (Req 3.4) ───────────────────────────────────────

/**
 * Reads the dynamic zone array from attrs[contentBlocksField ?? "content_blocks"]
 * and delegates each element to convertContentBlock, joining results with "\n".
 */
function convertContentBlocksStrategy(
  attrs: Record<string, unknown>,
  config: StrapiCollectionConfig,
): string {
  const fieldName = config.fieldMappings.contentBlocksField ?? "content_blocks";
  const blocks = attrs[fieldName];

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return "";
  }

  return blocks
    .map((block) => convertContentBlock(block as ContentBlock))
    .filter((s) => s.length > 0)
    .join("\n");
}

// ─── rich-text strategy (Req 3.5) ────────────────────────────────────────────

/**
 * Reads attrs[richTextField] as raw text and returns it directly.
 */
function convertRichTextStrategy(
  attrs: Record<string, unknown>,
  config: StrapiCollectionConfig,
): string {
  const { richTextField } = config.fieldMappings;
  if (!richTextField) {
    return "";
  }

  const value = attrs[richTextField];
  if (typeof value !== "string") {
    return "";
  }

  return value;
}

// ─── flat-fields strategy (Req 3.6) ──────────────────────────────────────────

/**
 * Concatenates the non-null, non-undefined, non-whitespace-only values of
 * attrs[field] for each field in flatFields, separated by "\n\n".
 * If all resolved values are blank/absent, returns an empty string.
 */
function convertFlatFieldsStrategy(
  attrs: Record<string, unknown>,
  config: StrapiCollectionConfig,
): string {
  const { flatFields } = config.fieldMappings;
  if (!flatFields || flatFields.length === 0) {
    return "";
  }

  const values = flatFields
    .map((field) => attrs[field])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );

  return values.join("\n\n");
}

// ─── Title resolution (Req 3.1) ───────────────────────────────────────────────

/**
 * Iterates titleFields in order and returns the first value that is a
 * non-null, non-undefined, non-whitespace-only string.
 * Returns undefined if no such value is found.
 */
function resolveTitle(
  attrs: Record<string, unknown>,
  titleFields: string[] | undefined,
): string | undefined {
  if (!titleFields || titleFields.length === 0) {
    return undefined;
  }

  for (const field of titleFields) {
    const value = attrs[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}
