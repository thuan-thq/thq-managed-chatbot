/**
 * ConfigLoader: loads, parses, and validates ClientConfig at Lambda cold start.
 *
 * - `validate(raw)` collects all errors and returns a `ValidationResult` without throwing.
 * - `load(raw)` calls `validate`, then throws a single Error with a newline-separated
 *   list of all violations if any are found.
 *
 * Requirements: 7.1–7.7, 1.2, 1.4, 1.5
 */

import type {
  ClientConfig,
  MarkdownStrategy,
  StrapiCollectionConfig,
} from "./config-types";

// ─── Public types ─────────────────────────────────────────────────────────────

/** A single validation failure with a dot-notation path and human-readable message. */
export interface ValidationError {
  /** Dot-notation field path, e.g. `"strapi.collections[2].name"` */
  path: string;
  /** Human-readable description of the violation. */
  message: string;
}

/** The result returned by `ConfigLoader.validate`. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_MARKDOWN_STRATEGIES: readonly MarkdownStrategy[] = [
  "content-blocks",
  "rich-text",
  "flat-fields",
];

/** Pattern: http(s)://host — at least one character after "://" */
const BASE_URL_PATTERN = /^https?:\/\/.+/;

// ─── ConfigLoader ─────────────────────────────────────────────────────────────

export class ConfigLoader {
  /**
   * Merges an optional external collections array into the raw config, then
   * loads and validates it.
   *
   * When `collectionsRaw` is a non-empty array it is injected as
   * `strapi.collections`, overriding any inline collections already present
   * in `deploymentRaw`. This lets operators keep the bulky collections config
   * in a separate `collections.json` file while keeping `deployment.json`
   * lean.
   *
   * Falls back to plain `ConfigLoader.load(deploymentRaw)` when
   * `collectionsRaw` is absent, null, or not an array.
   */
  static loadWithCollections(
    deploymentRaw: unknown,
    collectionsRaw?: unknown,
  ): ClientConfig {
    if (Array.isArray(collectionsRaw) && collectionsRaw.length > 0) {
      // Deep-clone so we don't mutate the caller's object
      const merged = JSON.parse(JSON.stringify(deploymentRaw)) as Record<
        string,
        unknown
      >;
      if (
        merged["strapi"] &&
        typeof merged["strapi"] === "object" &&
        !Array.isArray(merged["strapi"])
      ) {
        (merged["strapi"] as Record<string, unknown>)["collections"] =
          collectionsRaw;
      }
      return ConfigLoader.load(merged);
    }
    return ConfigLoader.load(deploymentRaw);
  }

  /**
   * Validates `raw` against the ClientConfig schema.
   *
   * All errors are collected before returning (fail-slow collection).
   * Never throws — callers that want fail-fast behaviour should use `load`.
   */
  static validate(raw: unknown): ValidationResult {
    const errors: ValidationError[] = [];

    // ── 1. strapi block ──────────────────────────────────────────────────────

    if (!isNonNullObject(raw)) {
      // Can't validate further if the top-level value isn't an object.
      errors.push({ path: "strapi", message: "must be a non-null object" });
      return { valid: false, errors };
    }

    const top = raw as Record<string, unknown>;
    const strapi = top["strapi"];

    if (!isNonNullObject(strapi)) {
      errors.push({
        path: "strapi",
        message: "must be a non-null object (strapi block is required)",
      });
      // Without a valid strapi block we cannot validate deeper fields.
      return { valid: false, errors };
    }

    const strapiObj = strapi as Record<string, unknown>;

    // ── 2. strapi.baseUrl ────────────────────────────────────────────────────

    const baseUrl = strapiObj["baseUrl"];
    if (typeof baseUrl !== "string" || !BASE_URL_PATTERN.test(baseUrl)) {
      errors.push({
        path: "strapi.baseUrl",
        message:
          "must be a string starting with http:// or https:// followed by a non-empty host",
      });
    }

    // ── 3. strapi.collections ────────────────────────────────────────────────

    const collections = strapiObj["collections"];

    if (!Array.isArray(collections)) {
      errors.push({
        path: "strapi.collections",
        message: "must be an array",
      });
      // Can't validate individual collections without an array.
      return { valid: errors.length === 0, errors };
    }

    if (collections.length === 0) {
      errors.push({
        path: "strapi.collections",
        message: "must contain at least one collection",
      });
      // No elements to validate further.
      return { valid: false, errors };
    }

    // ── 4. Per-collection validation ─────────────────────────────────────────

    for (let i = 0; i < collections.length; i++) {
      validateCollection(collections[i], i, errors);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Loads and validates a raw config object, returning it typed as `ClientConfig`.
   *
   * Throws a single `Error` if validation fails. The error message starts with
   * `"Configuration validation failed:\n"` followed by each violation on its own
   * line in the format `"  ${path}: ${message}"`.
   *
   * Requirements: 7.1
   */
  static load(raw: unknown): ClientConfig {
    const result = ConfigLoader.validate(raw);

    if (!result.valid) {
      const lines = result.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join("\n");
      throw new Error(`Configuration validation failed:\n${lines}`);
    }

    return raw as ClientConfig;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if `value` is a non-null, non-array object.
 */
function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns true if `value` is a non-empty string (after trimming).
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a single collection entry at the given index, pushing any errors
 * onto the shared `errors` array.
 */
function validateCollection(
  item: unknown,
  index: number,
  errors: ValidationError[],
): void {
  const prefix = `strapi.collections[${index}]`;

  if (!isNonNullObject(item)) {
    errors.push({ path: prefix, message: "must be a non-null object" });
    return;
  }

  const col = item as Partial<StrapiCollectionConfig>;

  // ── name ──────────────────────────────────────────────────────────────────

  if (!isNonEmptyString(col.name)) {
    errors.push({
      path: `${prefix}.name`,
      message: "must be a non-empty string",
    });
  }

  // ── strapiUid ─────────────────────────────────────────────────────────────

  if (!isNonEmptyString(col.strapiUid)) {
    errors.push({
      path: `${prefix}.strapiUid`,
      message: "must be a non-empty string",
    });
  }

  // ── markdownStrategy ──────────────────────────────────────────────────────

  const strategy = (col as Record<string, unknown>)["markdownStrategy"];
  const strategyValid =
    typeof strategy === "string" &&
    (VALID_MARKDOWN_STRATEGIES as string[]).includes(strategy);

  if (!strategyValid) {
    errors.push({
      path: `${prefix}.markdownStrategy`,
      message: `must be one of ${VALID_MARKDOWN_STRATEGIES.join(", ")}`,
    });
  }

  // ── Strategy-specific fieldMappings cross-validation ─────────────────────
  // Only validate when the strategy itself is valid (otherwise the strategy
  // error already covers the problem).

  if (strategyValid) {
    const fieldMappings = (col as Record<string, unknown>)["fieldMappings"];
    const fm = isNonNullObject(fieldMappings)
      ? (fieldMappings as Record<string, unknown>)
      : {};

    if (strategy === "rich-text") {
      // richTextField must be a non-empty string
      if (!isNonEmptyString(fm["richTextField"])) {
        errors.push({
          path: `${prefix}.fieldMappings.richTextField`,
          message:
            "required when markdownStrategy is rich-text; must be a non-empty string",
        });
      }
    }

    if (strategy === "flat-fields") {
      // flatFields must be a non-empty array
      const flatFields = fm["flatFields"];
      if (!Array.isArray(flatFields) || flatFields.length === 0) {
        errors.push({
          path: `${prefix}.fieldMappings.flatFields`,
          message:
            "required when markdownStrategy is flat-fields; must contain at least one entry",
        });
      }
    }
  }
}
