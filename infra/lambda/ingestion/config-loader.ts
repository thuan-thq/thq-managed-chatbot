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
  DataSourceConfig,
  MarkdownStrategy,
  StrapiCollectionConfig,
  StrapiConfig,
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
   * When `collectionsRaw` is a non-empty array it is injected into every
   * `dataSources` entry that matches `sourceId` (or into all Strapi entries
   * when `sourceId` is omitted). This lets operators keep bulky collection
   * configs in a separate `collections.json` file while keeping
   * `deployment.json` lean.
   *
   * Falls back to plain `ConfigLoader.load(deploymentRaw)` when
   * `collectionsRaw` is absent, null, or not an array.
   */
  static loadWithCollections(
    deploymentRaw: unknown,
    collectionsRaw?: unknown,
    sourceId?: string,
  ): ClientConfig {
    if (Array.isArray(collectionsRaw) && collectionsRaw.length > 0) {
      // Deep-clone so we don't mutate the caller's object
      const merged = JSON.parse(JSON.stringify(deploymentRaw)) as Record<
        string,
        unknown
      >;
      const dataSources = merged["dataSources"];
      if (Array.isArray(dataSources)) {
        for (const ds of dataSources) {
          if (
            isNonNullObject(ds) &&
            (ds as Record<string, unknown>)["type"] === "strapi"
          ) {
            const dsObj = ds as Record<string, unknown>;
            // Inject if no sourceId filter, or if the id matches
            if (!sourceId || dsObj["id"] === sourceId) {
              dsObj["collections"] = collectionsRaw;
            }
          }
        }
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

    if (!isNonNullObject(raw)) {
      errors.push({ path: "root", message: "must be a non-null object" });
      return { valid: false, errors };
    }

    const top = raw as Record<string, unknown>;

    // ── dataSources array ────────────────────────────────────────────────────

    const dataSources = top["dataSources"];

    if (!Array.isArray(dataSources)) {
      errors.push({
        path: "dataSources",
        message: "must be an array (dataSources block is required)",
      });
      return { valid: false, errors };
    }

    if (dataSources.length === 0) {
      errors.push({
        path: "dataSources",
        message: "must contain at least one data source",
      });
      return { valid: false, errors };
    }

    for (let i = 0; i < dataSources.length; i++) {
      validateDataSource(dataSources[i], i, errors);
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
 * Validates a single data source entry at the given index.
 */
function validateDataSource(
  item: unknown,
  index: number,
  errors: ValidationError[],
): void {
  const prefix = `dataSources[${index}]`;

  if (!isNonNullObject(item)) {
    errors.push({ path: prefix, message: "must be a non-null object" });
    return;
  }

  const ds = item as Record<string, unknown>;

  // ── id ────────────────────────────────────────────────────────────────────
  if (!isNonEmptyString(ds["id"])) {
    errors.push({
      path: `${prefix}.id`,
      message: "must be a non-empty string",
    });
  }

  // ── type ──────────────────────────────────────────────────────────────────
  const type = ds["type"];
  if (type !== "strapi") {
    errors.push({
      path: `${prefix}.type`,
      message: `must be one of: strapi (got: ${String(type)})`,
    });
    // Can't validate type-specific fields without a known type
    return;
  }

  // ── Strapi-specific fields ────────────────────────────────────────────────

  const apiEndpoint = ds["apiEndpoint"];
  if (typeof apiEndpoint !== "string" || !BASE_URL_PATTERN.test(apiEndpoint)) {
    errors.push({
      path: `${prefix}.apiEndpoint`,
      message:
        "must be a string starting with http:// or https:// followed by a non-empty host",
    });
  }

  const collections = ds["collections"];

  if (!Array.isArray(collections)) {
    errors.push({
      path: `${prefix}.collections`,
      message: "must be an array",
    });
    return;
  }

  if (collections.length === 0) {
    errors.push({
      path: `${prefix}.collections`,
      message: "must contain at least one collection",
    });
    return;
  }

  for (let i = 0; i < collections.length; i++) {
    validateCollection(collections[i], i, errors, prefix);
  }
}

/**
 * Validates a single collection entry at the given index, pushing any errors
 * onto the shared `errors` array.
 */
function validateCollection(
  item: unknown,
  index: number,
  errors: ValidationError[],
  sourcePrefix = "dataSources[0]",
): void {
  const prefix = `${sourcePrefix}.collections[${index}]`;

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
