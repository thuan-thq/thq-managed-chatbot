# Design Document: Multi-Client Strapi Configuration

## Overview

This feature replaces all hard-coded Strapi collection logic in the ingestion Lambda with a
configuration-driven approach. Currently, `handler.ts` hard-codes `STRAPI_COLLECTIONS` and
`STRAPI_UID_TO_COLLECTION`; `strapi-adapter.ts` hard-codes `addPopulateParams` with a
per-collection `switch`; and the markdown converter hard-codes `convertPage`, `convertTeam`,
`convertPerson` per collection type.

After this change, a per-client `deployment.json` declares each Strapi collection with its
populate parameters, field mappings, URL path template, and markdown rendering strategy. The
ingestion Lambda reads this config at cold start, validates it, and hands it to a new
`ConfigurableStrapiAdapter`. Adding a new client or collection requires only editing
`deployment.json` — no TypeScript changes.

### Key Design Goals

- **Config-driven, not code-driven**: all collection-specific behaviour lives in JSON.
- **Fail-fast validation**: misconfigured deployments throw a descriptive error at cold start
  before processing any events.
- **Backward compatibility**: the ThinkHQ client's markdown output and S3 key paths are
  string-identical to the current hard-coded adapter.
- **Extensibility**: new `MarkdownStrategy` types can be added without touching existing
  collection configs.

---

## Architecture

The change touches three layers of the ingestion Lambda:

```
┌─────────────────────────────────────────────────────────────┐
│                     handler.ts (cold start)                 │
│  1. Load deployment.json via ConfigLoader                   │
│  2. Validate ClientConfig (fail fast on error)              │
│  3. Build UidCollectionMap from strapi.collections          │
│  4. Construct ConfigurableStrapiAdapter                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │   ConfigurableStrapiAdapter      │
              │  - Accepts StrapiCollectionConfig│
              │  - Builds URLs with PopulateConfig│
              │  - Delegates to               │
              │    CollectionMarkdownConverter   │
              └────────────────┬────────────────┘
                               │
              ┌────────────────▼────────────────┐
              │  CollectionMarkdownConverter     │
              │  - content-blocks strategy       │
              │  - rich-text strategy            │
              │  - flat-fields strategy          │
              └─────────────────────────────────┘
```

The `ConfigLoader` is a new module. `ConfigurableStrapiAdapter` replaces `StrapiAdapter` for
multi-collection use cases (the existing `StrapiAdapter` can be kept for backward compatibility
until all callers are migrated).

---

## Components and Interfaces

### 1. Configuration Types (`infra/lambda/ingestion/config-types.ts`)

New file declaring all configuration interfaces.

```typescript
export type MarkdownStrategy = "content-blocks" | "rich-text" | "flat-fields";

export interface PopulateField {
  key: string;
  value: string;
}

export interface PopulateConfig {
  wildcard?: boolean;
  fields?: PopulateField[];
}

export interface ContentFieldMapping {
  titleFields?: string[];
  slugField?: string;
  summaryField?: string;
  contentBlocksField?: string; // default: "content_blocks"
  richTextField?: string;
  flatFields?: string[];
  lastModifiedField?: string; // default: "updatedAt"
}

export interface StrapiCollectionConfig {
  name: string; // REST API path, e.g. "intranet-pages"
  strapiUid: string; // Full UID, e.g. "api::intranet-page.intranet-page"
  markdownStrategy: MarkdownStrategy;
  fieldMappings: ContentFieldMapping;
  populate?: PopulateConfig;
  urlPathTemplate?: string; // e.g. "/team/{slug}"
}

export interface StrapiConfig {
  baseUrl: string;
  apiToken: string;
  webhookSecret: string;
  frontendBaseUrl?: string;
  pageSize?: number;
  collections: StrapiCollectionConfig[];
}

export interface ClientConfig {
  clientId: string;
  region: string;
  modelId: string;
  confidenceThreshold: number;
  dataSource: StrapiConfig; // renamed from loosely-typed dataSource
  strapi: StrapiConfig; // canonical path for collection config
  session: SessionConfig;
  rateLimit: RateLimitConfig;
  apiKeys: ApiKeysConfig;
  monitoring: MonitoringConfig;
}
```

> **Design decision**: `ClientConfig.strapi` is the canonical block for collection config.
> The existing `dataSource` block is preserved for non-breaking compatibility during migration
> but `ConfigLoader` merges `dataSource.*` into `strapi.*` when `strapi` is absent.

### 2. ConfigLoader (`infra/lambda/ingestion/config-loader.ts`)

Responsible for reading, parsing, and validating `ClientConfig`.

**Interface:**

```typescript
export class ConfigLoader {
  static load(raw: unknown): ClientConfig; // throws on validation error
  static validate(raw: unknown): ValidationResult; // returns errors without throwing
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string; // dot-notation, e.g. "strapi.collections[2].name"
  message: string;
}
```

**Validation rules** (fail-fast, all errors collected before throwing):

| Rule                                                  | Error path                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `strapi` absent or not an object                      | `strapi`                                                       |
| `strapi.baseUrl` not `http(s)://host`                 | `strapi.baseUrl`                                               |
| `strapi.collections` absent or not an array           | `strapi.collections`                                           |
| `strapi.collections` empty array                      | `strapi.collections`                                           |
| Collection missing `name` or empty `name`             | `strapi.collections[i].name`                                   |
| Collection missing `strapiUid` or empty               | `strapi.collections[i].strapiUid`                              |
| Collection `markdownStrategy` not valid literal       | `strapi.collections[i].markdownStrategy` (or `[i]` if no name) |
| `rich-text` strategy but `richTextField` absent/empty | `strapi.collections[i].fieldMappings.richTextField`            |
| `flat-fields` strategy but `flatFields` absent/empty  | `strapi.collections[i].fieldMappings.flatFields`               |

If one or more errors are found, `load()` throws a single `Error` whose message is a
newline-separated list of `"${path}: ${message}"` strings.

### 3. ConfigurableStrapiAdapter (`infra/lambda/ingestion/configurable-strapi-adapter.ts`)

Replaces the per-collection `switch` in `StrapiAdapter` with config-driven behaviour.

```typescript
export interface ConfigurableStrapiAdapterConfig {
  baseUrl: string;
  apiToken: string;
  frontendBaseUrl?: string;
  collections: StrapiCollectionConfig[];
}

export class ConfigurableStrapiAdapter implements DataSourceAdapter {
  constructor(
    config: ConfigurableStrapiAdapterConfig,
    httpClient?: RetryHttpClient,
  );

  listContent(
    pagination: PaginationParams,
    collectionName: string,
  ): Promise<PagedResult<ContentRecord>>;
  fetchById(
    recordId: string,
    collectionName: string,
  ): Promise<ContentRecord | null>;
  detectChanges(since: string, collectionName: string): Promise<ChangeSet>;
}
```

URL building delegates to a pure `buildUrl(collection: StrapiCollectionConfig, ...)` function
that reads `collection.populate` to append query params.

### 4. CollectionMarkdownConverter (`infra/lambda/ingestion/collection-markdown-converter.ts`)

A new converter that applies the configured `MarkdownStrategy` and `ContentFieldMapping`.

```typescript
export class CollectionMarkdownConverter {
  static convert(
    attrs: Record<string, unknown>,
    config: StrapiCollectionConfig,
    options: { baseUrl?: string },
  ): string;
}
```

Strategy dispatch:

- **`content-blocks`**: reads `attrs[fieldMappings.contentBlocksField ?? "content_blocks"]`
  as a dynamic zone array, delegates each element to the existing `convertContentBlock`.
- **`rich-text`**: reads `attrs[fieldMappings.richTextField]` as raw HTML/markdown text.
- **`flat-fields`**: concatenates `attrs[field]` for each field in `fieldMappings.flatFields`,
  joined by `\n\n`, skipping null/undefined/whitespace values.

All three strategies prepend the title (resolved from `titleFields`) and optionally a
`## Summary` section (from `summaryField`) before the content body.

### 5. UidCollectionMap (built in handler.ts)

```typescript
// Built once at cold start from ClientConfig
const uidMap: Map<string, string> = new Map(
  config.strapi.collections.map((c) => [c.strapiUid, c.name]),
);
```

`normalizeStrapiPayload` looks up `raw.uid` in `uidMap` instead of `STRAPI_UID_TO_COLLECTION`.

### 6. Updated handler.ts

Changes:

- Remove `STRAPI_COLLECTIONS` constant.
- Remove `STRAPI_UID_TO_COLLECTION` constant.
- Add `ConfigLoader.load()` call at module init; Lambda fails cold start on validation error.
- Build `uidMap` from loaded config.
- Replace `createAdapter` factory with construction of `ConfigurableStrapiAdapter`.
- `handleFullSync` iterates `config.strapi.collections.map(c => c.name)`.

---

## Data Models

### deployment.json (updated shape)

```json
{
  "clientId": "thq-managed-chatbot",
  "region": "ap-southeast-2",
  "strapi": {
    "baseUrl": "https://api.think-hq.com.au",
    "frontendBaseUrl": "https://think-hq.com.au",
    "collections": [
      {
        "name": "intranet-pages",
        "strapiUid": "api::intranet-page.intranet-page",
        "markdownStrategy": "content-blocks",
        "fieldMappings": {
          "titleFields": ["head_title", "title"],
          "slugField": "slug",
          "summaryField": "summary",
          "contentBlocksField": "content_blocks",
          "lastModifiedField": "updatedAt"
        },
        "urlPathTemplate": "/{slug}",
        "populate": {
          "fields": [
            { "key": "populate[head_title][populate]", "value": "*" },
            { "key": "populate[seo][populate]", "value": "*" },
            { "key": "populate[heading][populate]", "value": "*" },
            {
              "key": "populate[sidebar_blocks][on][sidebar.link-block][populate]",
              "value": "*"
            },
            {
              "key": "populate[content_blocks][on][dynamic.text-block][populate]",
              "value": "*"
            }
          ]
        }
      },
      {
        "name": "intranet-teams",
        "strapiUid": "api::intranet-team.intranet-team",
        "markdownStrategy": "content-blocks",
        "fieldMappings": {
          "titleFields": ["title", "name"],
          "slugField": "slug",
          "summaryField": "summary",
          "contentBlocksField": "content_blocks",
          "lastModifiedField": "updatedAt"
        },
        "urlPathTemplate": "/team/{slug}",
        "populate": {
          "fields": [
            { "key": "populate[team_picture][populate]", "value": "*" },
            { "key": "populate[banner_graphic][populate]", "value": "*" },
            { "key": "populate[intranet_people][populate]", "value": "*" },
            { "key": "populate[icon][populate]", "value": "*" },
            {
              "key": "populate[content_blocks][on][dynamic.text-block][populate]",
              "value": "*"
            }
          ]
        }
      },
      {
        "name": "intranet-people",
        "strapiUid": "api::intranet-person.intranet-person",
        "markdownStrategy": "content-blocks",
        "fieldMappings": {
          "titleFields": ["display_name", "displayName", "name"],
          "slugField": "slug",
          "summaryField": "bio",
          "contentBlocksField": "content_blocks",
          "lastModifiedField": "updatedAt"
        },
        "urlPathTemplate": "/people/{slug}",
        "populate": {
          "fields": [
            { "key": "populate[headshot][populate]", "value": "*" },
            {
              "key": "populate[pronunciation_voice_clip][populate]",
              "value": "*"
            },
            { "key": "populate[intranet_team][populate]", "value": "*" },
            {
              "key": "populate[content_blocks][on][dynamic.text-block][populate]",
              "value": "*"
            }
          ]
        }
      }
    ]
  }
}
```

### PopulateConfig query-building algorithm

```
function buildPopulateParams(populate: PopulateConfig | undefined): URLSearchParams:
  params = new URLSearchParams()
  if populate is undefined or null: return params
  if populate.wildcard === true:
    params.set("populate", "*")
    return params               // wildcard wins; ignore fields
  if populate.fields is non-empty:
    for each { key, value } in populate.fields:
      params.append(key, value)
  return params
```

### S3 document key derivation (unchanged algorithm)

```
priority: attrs[slugField] → toSlug(attrs[titleFields[0]]) → toSlug(attrs.name) → recordId
path:     documents/{collection.name}/{filename}.json
```

This preserves exact key compatibility with the current `StrapiAdapter.deriveDocumentPath`.

---

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system - essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

### Property 1: Config schema round-trip preserves validation outcome

_For any_ `ClientConfig`-shaped object (valid or invalid), serialising it to JSON and deserialising it back SHALL produce an object that yields the same `ConfigLoader` validation outcome (pass or fail, with identical error messages).

**Validates: Requirements 7.7, 2.5**

### Property 2: Collections pass-through is exact

_For any_ non-empty array of `StrapiCollectionConfig` objects embedded in a valid `ClientConfig`, the array passed to `ConfigurableStrapiAdapter` by `ConfigLoader` SHALL contain exactly the same elements in the same order - no additions, removals, or mutations.

**Validates: Requirements 1.3**

### Property 3: Missing or non-object strapi block fails validation

_For any_ value that is not a non-null object (including `undefined`, `null`, numbers, strings, arrays), assigning it as `ClientConfig.strapi` SHALL cause `ConfigLoader` to return a validation error referencing the `strapi` path.

**Validates: Requirements 1.2**

### Property 4: Missing required collection fields fail validation with correct index

_For any_ collections array where one or more elements are missing `name`, `strapiUid`, `markdownStrategy`, or `fieldMappings`, the `ConfigLoader` validation error SHALL identify each violating element by its zero-based index.

**Validates: Requirements 1.5, 1.6**

### Property 5: wildcard=true produces exactly populate=\* in URL and suppresses fields

_For any_ `StrapiCollectionConfig` where `populate.wildcard` is `true`, regardless of whether `populate.fields` is also present and non-empty, all API request URLs generated by `ConfigurableStrapiAdapter` for that collection SHALL contain `populate=*` and SHALL NOT contain any query parameter key that begins with `populate[`.

**Validates: Requirements 2.1, 2.3**

### Property 6: Non-empty fields array produces all entries as query params

_For any_ `PopulateConfig` where `wildcard` is absent or `false` and `fields` is a non-empty array, all generated API request URLs SHALL contain exactly the key=value pairs declared in `fields`, with no extras or omissions.

**Validates: Requirements 2.2**

### Property 7: titleFields resolution returns first non-blank value

_For any_ `ContentFieldMapping.titleFields` array and any entry attributes object, the resolved title SHALL be the value of the first field in `titleFields` whose resolved value is non-null, non-undefined, and not composed solely of whitespace characters. If no such field exists, the title SHALL be omitted from the markdown output.

**Validates: Requirements 3.1**

### Property 8: Whitespace-only or absent slug falls back to entry id

_For any_ entry attributes where the value of `slugField` is absent, null, or composed solely of whitespace characters, the `ConfigurableStrapiAdapter` SHALL use the entry's `id` as the document slug.

**Validates: Requirements 3.2**

### Property 9: flat-fields concatenation excludes null/whitespace values

_For any_ `ContentFieldMapping.flatFields` array and any entry attributes, the produced content body SHALL contain exactly the non-null, non-undefined, non-whitespace-only values of the listed fields, joined by `\n\n`, with no trailing/leading separator.

**Validates: Requirements 3.6**

### Property 10: sourceUrl construction is correct for any valid template and slug

_For any_ non-empty `urlPathTemplate` containing the `{slug}` placeholder, any non-empty resolved slug, and any `frontendBaseUrl` starting with `http://` or `https://`, the generated `sourceUrl` SHALL equal `frontendBaseUrl + urlPathTemplate` with every occurrence of `{slug}` replaced by the resolved slug value.

**Validates: Requirements 4.2**

### Property 11: sourceUrl is omitted for invalid templates, slugs, or base URLs

_For any_ combination where `urlPathTemplate` does not contain `{slug}`, or the resolved slug is empty/whitespace-only, or `frontendBaseUrl` is absent/empty/does not start with `http://` or `https://`, the `sourceUrl` field SHALL be absent from the produced document metadata.

**Validates: Requirements 4.4, 4.5, 4.6, 4.7**

### Property 12: UidCollectionMap exactly mirrors config

_For any_ non-empty `StrapiCollectionConfig` array, the `UidCollectionMap` built from it SHALL contain exactly one entry per collection where the key equals `strapiUid` and the value equals `name`, with no additional entries.

**Validates: Requirements 5.1, 5.3**

### Property 13: Non-api:: UIDs resolve to undefined

_For any_ UID string that does not begin with `api::`, calling `lookupCollection` SHALL return `undefined`.

**Validates: Requirements 5.5**

### Property 14: Full sync processes exactly the configured collections

_For any_ non-empty `strapi.collections` array, a full sync invocation SHALL create exactly one sync pipeline for each `name` in the array, and SHALL NOT create pipelines for any name not in the array.

**Validates: Requirements 6.1**

### Property 15: Full sync aggregates results correctly

_For any_ set of N collections where collection i produces `ri` records processed and `ei` errors, the returned `FullSyncResult` SHALL have `totalRecords = sum(ri)`, `totalErrors = sum(ei)`, and `success = (totalErrors == 0)`.

**Validates: Requirements 6.4**

### Property 16: strategy/field cross-validation catches all mismatches

_For any_ `StrapiCollectionConfig` where `markdownStrategy` is `"rich-text"` and `fieldMappings.richTextField` is absent or empty, or where `markdownStrategy` is `"flat-fields"` and `fieldMappings.flatFields` is absent or empty, `ConfigLoader` validation SHALL produce an error identifying the collection and the violated constraint.

**Validates: Requirements 7.5, 7.6**

### Property 17: Invalid baseUrl values produce validation errors

_For any_ string that does not match the pattern `/^https?:\/\/.+/` (including empty string, relative paths, protocol-relative URLs), assigning it as `strapi.baseUrl` SHALL cause `ConfigLoader` to return a validation error for the path `strapi.baseUrl`.

**Validates: Requirements 7.3**

## Error Handling

### ConfigLoader validation errors

All violations are collected before throwing. The thrown `Error.message` is a single human-readable string with each violation on its own line:

```
Configuration validation failed:
  strapi.collections[1].name: must be a non-empty string
  strapi.collections[1].markdownStrategy: must be one of content-blocks, rich-text, flat-fields
  strapi.collections[2].fieldMappings.richTextField: required when markdownStrategy is rich-text
```

This error propagates through the Lambda init and is logged by the runtime. The Lambda instance refuses all events until the next cold start with a valid config.

### sourceUrl construction warnings

All sourceUrl-related warning logs are structured JSON at WARN level, emitted once per entry where the condition is hit:

```json
{
  "level": "WARN",
  "message": "Omitting sourceUrl: urlPathTemplate missing {slug} placeholder",
  "collection": "example-collection",
  "recordId": "42",
  "urlPathTemplate": "/no-placeholder-here"
}
```

The same pattern applies for: empty slug, missing/malformed `frontendBaseUrl`, and absent `urlPathTemplate`.

### lastModified fallback

When both `lastModifiedField` and `createdAt` are absent or null, the adapter logs:

```json
{
  "level": "WARN",
  "message": "No lastModified timestamp found for record - omitting from metadata",
  "collection": "example-collection",
  "recordId": "42"
}
```

The record is still ingested; `lastModified` is simply absent from document metadata.

### Unrecognised webhook UID

```json
{
  "level": "WARN",
  "message": "Unrecognised Strapi uid - collection unknown",
  "uid": "api::unknown-type.unknown-type"
}
```

The normalised payload has `collection: undefined`. The `WebhookEventRouter` log will show the unresolved collection and the event will be routed using the source path parameter as fallback (existing behaviour).

### Full sync per-collection failure

When a collection sync throws, the handler logs at WARN level and continues:

```json
{
  "level": "WARN",
  "message": "Sync failed for collection - continuing with remaining",
  "collection": "example-collection",
  "errors": 3
}
```

The final `FullSyncResult.success` is `false` if the aggregate error count is non-zero.

## Testing Strategy

The project uses **Vitest** (app) and **Jest** (infra). Property-based tests for the ingestion Lambda use **fast-check**, which is already available as a dev dependency in the Node/TypeScript ecosystem and integrates naturally with Jest.

### Property-based tests

Each correctness property from the Correctness Properties section above maps to one property-based test in `infra/lambda/ingestion/__tests__/`. Tests run with a minimum of 100 iterations.

Tag format comment above each test: `// Feature: multi-client-strapi-config, Property N: <property text>`

Library: `fast-check` (`fc.assert(fc.property(...))`)

Example test skeleton:

```typescript
import * as fc from "fast-check";
import { loadAndValidateConfig } from "../config-loader";

// Feature: multi-client-strapi-config, Property 1: Config schema round-trip preserves validation outcome
test("config round-trip preserves validation outcome", () => {
  fc.assert(
    fc.property(arbitraryClientConfigLike(), (raw) => {
      const result1 = safeValidate(raw);
      const result2 = safeValidate(JSON.parse(JSON.stringify(raw)));
      expect(result2.valid).toBe(result1.valid);
      expect(result2.errors).toEqual(result1.errors);
    }),
    { numRuns: 100 },
  );
});
```

Properties covered by property-based tests:

- Property 1: Config schema round-trip (config-loader)
- Property 2: Collections pass-through (config-loader + adapter construction)
- Property 3: Missing strapi block fails validation (config-loader)
- Property 4: Missing required fields fail with correct index (config-loader)
- Property 5: wildcard=true produces populate=\* and suppresses fields (configurable-strapi-adapter)
- Property 6: Non-empty fields array produces correct query params (configurable-strapi-adapter)
- Property 7: titleFields first-non-blank resolution (collection-markdown-converter)
- Property 8: Slug fallback to id (configurable-strapi-adapter)
- Property 9: flat-fields concatenation excludes null/whitespace (collection-markdown-converter)
- Property 10: sourceUrl construction (configurable-strapi-adapter)
- Property 11: sourceUrl omission conditions (configurable-strapi-adapter)
- Property 12: UidCollectionMap mirrors config (uid-collection-map)
- Property 13: Non-api:: UIDs resolve to undefined (uid-collection-map)
- Property 14: Full sync processes exactly configured collections (handler - with adapter mock)
- Property 15: Full sync aggregates results correctly (handler - with adapter mock)
- Property 16: Strategy/field cross-validation (config-loader)
- Property 17: Invalid baseUrl values (config-loader)

### Unit / example-based tests

- `ConfigLoader` with empty collections array returns error (Req 1.4)
- `ConfigLoader` with missing `strapi` block returns error (Req 1.2)
- `PopulateConfig` with no populate parameters produces clean URL (Req 2.4)
- `CollectionMarkdownConverter` summary section rendered correctly with non-empty summaryField (Req 3.3)
- `lastModified` fallback chain: field present / only createdAt / neither (Req 3.8)
- `urlPathTemplate` absent/empty omits sourceUrl (Req 4.3)
- `frontendBaseUrl` absent omits sourceUrl for all collections (Req 4.7)
- Full sync with empty collections returns zero FullSyncResult (Req 6.2)

### Backward-compatibility regression tests

One test file `infra/lambda/ingestion/__tests__/backward-compat.test.ts` compares new vs old output for each ThinkHQ collection using fixture data that mirrors the current hard-coded converters:

- `convertPage` fixture: verify `CollectionMarkdownConverter` with ThinkHQ `intranet-pages` config produces string-equal output (Req 8.2)
- `convertTeam` fixture: same for `intranet-teams` (Req 8.3)
- `convertPerson` fixture: same for `intranet-people` (Req 8.4)
- S3 document key fixture: verify derived path matches current `deriveDocumentPath` logic (Req 8.5)

### Integration tests (not run in CI by default)

- Lambda cold start with valid `deployment.json` - no error (Req 7.2)
- Lambda cold start with invalid `deployment.json` - error logged, events rejected (Req 7.2)
- End-to-end full sync using ThinkHQ config and a real Strapi sandbox (Req 8.1)

### Config artifact tests

- Parse `deployment.example.json` and verify all three strategy examples present (Req 9.1)
- Load and validate `deployment.example.json` with placeholders replaced by structurally valid values - ConfigLoader returns no errors (Req 9.3)
