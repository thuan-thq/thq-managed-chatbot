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

    // ── Title (Req 3.1) — from titleFields only ──────────────────────────────
    const title = resolveTitle(
      attrs,
      config.fieldMappings.titleFields,
      config.fieldMappings.componentFields,
    );
    if (title !== undefined) {
      parts.push(`# ${title}`);
    }

    // ── Component field headings — each rendered as ## ────────────────────────
    const { componentFields } = config.fieldMappings;
    if (componentFields) {
      for (const [field, descriptor] of Object.entries(componentFields)) {
        const text = extractComponentFieldText(attrs[field], descriptor);
        if (text.length > 0) {
          parts.push(`\n\n${text}`);
        }
      }
    }

    // ── Summary section (Req 3.3) ────────────────────────────────────────────
    const { summaryField } = config.fieldMappings;
    if (summaryField !== undefined) {
      const summaryValue = attrs[summaryField];
      if (typeof summaryValue === "string" && summaryValue.length > 0) {
        parts.push(`## Summary\n\n${summaryValue}`);
      }
    }

    // ── Supplementary flat fields (non-flat-fields strategies only) ──────────
    // Renders flatFields as a metadata section when the primary strategy is
    // content-blocks or rich-text (e.g. head_title_animated on pages).
    if (
      config.markdownStrategy !== "flat-fields" &&
      config.fieldMappings.flatFields &&
      config.fieldMappings.flatFields.length > 0
    ) {
      const flatSection = renderSupplementaryFlatFields(
        attrs,
        config.fieldMappings.flatFields,
        config.fieldMappings.componentFields,
      );
      if (flatSection.length > 0) {
        parts.push(flatSection);
      }
    }

    // ── Relation metadata — taxonomy/relation fields populated at top level ──
    const relationSection = convertRelationMetadata(attrs);
    if (relationSection.length > 0) {
      parts.push(relationSection);
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
 * Resolves the document title from titleFields in order.
 * If a field has a componentFields descriptor, uses component extraction.
 * Otherwise falls back to plain string or generic string array.
 * Returns the first non-empty resolved string, or undefined.
 */
function resolveTitle(
  attrs: Record<string, unknown>,
  titleFields: string[] | undefined,
  componentFields?: StrapiCollectionConfig["fieldMappings"]["componentFields"],
): string | undefined {
  if (!titleFields || titleFields.length === 0) return undefined;

  for (const field of titleFields) {
    const value = attrs[field];
    const descriptor = componentFields?.[field];

    if (descriptor) {
      const text = extractComponentFieldText(value, descriptor);
      if (text.length > 0) return text;
      continue;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (Array.isArray(value) && value.length > 0) {
      const joined = value
        .filter((item): item is string => typeof item === "string")
        .join(" ")
        .trim();
      if (joined.length > 0) return joined;
    }
  }

  return undefined;
}

// ─── Supplementary flat fields ────────────────────────────────────────────────

/**
 * Renders flatFields as a supplementary metadata section for collections that
 * use the content-blocks or rich-text strategy. This lets fields like
 * head_title_animated be included in the markdown without switching the primary
 * strategy to flat-fields.
 *
 * Each non-blank field value is emitted as a bold key-value line.
 * componentFields descriptors are applied first; plain strings and generic
 * string arrays are handled as fallbacks.
 * Returns an empty string when all values are blank/absent.
 */
function renderSupplementaryFlatFields(
  attrs: Record<string, unknown>,
  flatFields: string[],
  componentFields?: StrapiCollectionConfig["fieldMappings"]["componentFields"],
): string {
  const lines: string[] = [];

  for (const field of flatFields) {
    const value = attrs[field];

    // componentFields descriptor
    const descriptor = componentFields?.[field];
    if (descriptor) {
      const text = extractComponentFieldText(value, descriptor);
      if (text.length > 0) lines.push(`**${field}:** ${text}`);
      continue;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      lines.push(`**${field}:** ${value.trim()}`);
    } else if (Array.isArray(value) && value.length > 0) {
      const joined = value
        .filter((item): item is string => typeof item === "string")
        .join(" ")
        .trim();
      if (joined.length > 0) {
        lines.push(`**${field}:** ${joined}`);
      }
    }
  }

  return lines.join("\n");
}

// ─── Component field extraction ───────────────────────────────────────────────

/** Type alias for the componentFields descriptor */
type ComponentFieldDescriptor = NonNullable<
  StrapiCollectionConfig["fieldMappings"]["componentFields"]
>[string];

/**
 * Extracts text from a component field based on its descriptor.
 * Handles both repeatable-component (array) and component (single object) types.
 */
function extractComponentFieldText(
  value: unknown,
  descriptor: ComponentFieldDescriptor,
): string {
  if (!value) return "";

  if (descriptor.type === "repeatable-component") {
    if (!Array.isArray(value) || value.length === 0) return "";
    return extractTextFromItems(value, descriptor.textFields);
  }

  if (descriptor.type === "component") {
    if (!value || typeof value !== "object") return "";
    return extractTextFromItem(
      value as Record<string, unknown>,
      descriptor.textFields,
    );
  }

  return "";
}

/**
 * Extracts text from multiple items in a repeatable-component array.
 * Each item's resolved textFields are joined with \n, items separated with \n.
 */
function extractTextFromItems(items: unknown[], textFields: string[]): string {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      return extractTextFromItem(item as Record<string, unknown>, textFields);
    })
    .filter((s) => s.trim().length > 0)
    .join("\n")
    .trim();
}

/**
 * Extracts text from a single component object using multiple textFields.
 * Each resolved textField value is placed on its own line.
 * Handles both flat (`item.field`) and nested (`item.attributes.field`) formats.
 */
function extractTextFromItem(
  item: Record<string, unknown>,
  textFields: string[],
): string {
  // Try flat format first (Strapi v4.14+)
  const flatValues = textFields
    .map((field) =>
      typeof item[field] === "string" ? (item[field] as string).trim() : "",
    )
    .filter((s) => s.length > 0);

  if (flatValues.length > 0) {
    return flatValues.join("\n");
  }

  // Try nested format (Strapi v4 with attributes wrapper)
  const attrs = item["attributes"] as Record<string, unknown> | undefined;
  if (attrs) {
    const nestedValues = textFields
      .map((field) =>
        typeof attrs[field] === "string" ? (attrs[field] as string).trim() : "",
      )
      .filter((s) => s.length > 0);

    if (nestedValues.length > 0) {
      return nestedValues.join("\n");
    }
  }

  return "";
}

// ─── Relation metadata ────────────────────────────────────────────────────────

/**
 * Extracts names from a Strapi relation array in `{ data: [{ attributes: { name } }] }` format.
 * Checks `name`, `title`, and `slug` in that order for the label.
 */
function extractRelationNames(field: unknown): string[] {
  if (!field || typeof field !== "object") return [];
  const rel = field as Record<string, unknown>;
  const data = rel["data"];
  if (!Array.isArray(data) || data.length === 0) return [];

  return data
    .map((item) => {
      const attrs = (item as Record<string, unknown>)?.["attributes"] as
        | Record<string, unknown>
        | undefined;
      if (!attrs) return "";
      return (
        (attrs["name"] as string) ||
        (attrs["title"] as string) ||
        (attrs["slug"] as string) ||
        ""
      );
    })
    .filter((s) => s.length > 0);
}

/**
 * Extracts a single-relation name from `{ data: { attributes: { name } } }` format.
 */
function extractSingleRelationName(field: unknown): string {
  if (!field || typeof field !== "object") return "";
  const rel = field as Record<string, unknown>;
  const data = rel["data"] as Record<string, unknown> | undefined;
  if (!data) return "";
  const attrs = data["attributes"] as Record<string, unknown> | undefined;
  if (!attrs) return "";
  return (
    (attrs["name"] as string) ||
    (attrs["title"] as string) ||
    (attrs["slug"] as string) ||
    ""
  );
}

/**
 * Scans well-known relation fields on an entry and emits a metadata section
 * for any that are populated. Currently handles:
 *   - deliverables       → "## Deliverables"
 *   - specialty_taxonomies → "**Specialties:**"
 *   - client             → "**Client:**"
 *
 * Returns an empty string when none of the fields are present.
 */
function convertRelationMetadata(attrs: Record<string, unknown>): string {
  const lines: string[] = [];

  // Client — single relation
  const clientName = extractSingleRelationName(attrs["client"]);
  if (clientName.length > 0) {
    lines.push(`**Client:** ${clientName}`);
  }

  // Specialty taxonomies — many relation
  const specialties = extractRelationNames(attrs["specialty_taxonomies"]);
  if (specialties.length > 0) {
    lines.push(`**Specialties:** ${specialties.join(", ")}`);
  }

  if (lines.length === 0 && !attrs["deliverables"]) {
    return "";
  }

  const parts: string[] = [];

  if (lines.length > 0) {
    parts.push(lines.join("\n"));
  }

  // Deliverables — many relation, rendered as a list
  const deliverables = extractRelationNames(attrs["deliverables"]);
  if (deliverables.length > 0) {
    parts.push(
      `## Deliverables\n\n${deliverables.map((d) => `- ${d}`).join("\n")}`,
    );
  }

  return parts.join("\n\n");
}
