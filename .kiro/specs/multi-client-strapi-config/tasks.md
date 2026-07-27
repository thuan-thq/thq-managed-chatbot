# Implementation Plan: Multi-Client Strapi Configuration

## Overview

Replace all hard-coded Strapi collection logic in the ingestion Lambda with a config-driven
approach. A per-client `deployment.json` declares each collection's populate parameters, field
mappings, URL path template, and markdown strategy. Four new modules are introduced:
`config-types.ts`, `config-loader.ts`, `configurable-strapi-adapter.ts`, and
`collection-markdown-converter.ts`. `handler.ts` is updated to load config at cold start and
remove all hard-coded constants.

## Tasks

- [x] 1. Define configuration types
  - [x] 1.1 Create `infra/lambda/ingestion/config-types.ts`
    - Declare `MarkdownStrategy` union type (`"content-blocks" | "rich-text" | "flat-fields"`)
    - Declare `PopulateField`, `PopulateConfig`, `ContentFieldMapping`, `StrapiCollectionConfig`
    - Declare `StrapiConfig` (baseUrl, apiToken, webhookSecret, frontendBaseUrl, pageSize, collections)
    - Declare `ClientConfig` with `strapi: StrapiConfig` as the canonical block and retain existing top-level fields (clientId, region, modelId, confidenceThreshold, session, rateLimit, apiKeys, monitoring)
    - Export all types
    - _Requirements: 1.1, 1.6, 1.7, 2.1, 2.2, 3.1–3.8, 4.1_

- [x] 2. Implement ConfigLoader with validation
  - [x] 2.1 Create `infra/lambda/ingestion/config-loader.ts`
    - Implement `ConfigLoader.validate(raw: unknown): ValidationResult` — collects all errors before returning
    - Implement `ConfigLoader.load(raw: unknown): ClientConfig` — calls `validate`, throws with newline-separated error list on failure
    - Implement all validation rules from the design table (missing strapi block, invalid baseUrl pattern, empty collections, missing/empty name/strapiUid, invalid markdownStrategy, rich-text missing richTextField, flat-fields missing/empty flatFields)
    - Export `ConfigLoader`, `ValidationResult`, `ValidationError`
    - _Requirements: 7.1–7.7, 1.2, 1.4, 1.5_

  - [ ]\* 2.2 Write property test: config round-trip preserves validation outcome (Property 1)
    - **Property 1: Config schema round-trip preserves validation outcome**
    - **Validates: Requirements 7.7, 2.5**
    - File: `infra/lambda/ingestion/__tests__/config-loader.property.test.ts`
    - Use `fc.assert(fc.property(arbitraryClientConfigLike(), ...))` with `{ numRuns: 100 }`

  - [ ]\* 2.3 Write property test: missing/non-object strapi block fails validation (Property 3)
    - **Property 3: Missing or non-object strapi block fails validation**
    - **Validates: Requirements 1.2**
    - File: `infra/lambda/ingestion/__tests__/config-loader.property.test.ts`

  - [ ]\* 2.4 Write property test: missing required collection fields fail with correct index (Property 4)
    - **Property 4: Missing required collection fields fail validation with correct index**
    - **Validates: Requirements 1.5, 1.6**
    - File: `infra/lambda/ingestion/__tests__/config-loader.property.test.ts`

  - [ ]\* 2.5 Write property test: strategy/field cross-validation catches all mismatches (Property 16)
    - **Property 16: strategy/field cross-validation catches all mismatches**
    - **Validates: Requirements 7.5, 7.6**
    - File: `infra/lambda/ingestion/__tests__/config-loader.property.test.ts`

  - [ ]\* 2.6 Write property test: invalid baseUrl values produce validation errors (Property 17)
    - **Property 17: Invalid baseUrl values produce validation errors**
    - **Validates: Requirements 7.3**
    - File: `infra/lambda/ingestion/__tests__/config-loader.property.test.ts`

  - [ ]\* 2.7 Write unit tests for ConfigLoader edge cases
    - Empty collections array returns error (Req 1.4)
    - Missing strapi block returns error (Req 1.2)
    - Valid config with all three strategy examples loads without error (Req 9.3)
    - Error message is newline-separated list of path: message entries (Req 7.1)
    - File: `infra/lambda/ingestion/__tests__/config-loader.test.ts`

- [x] 3. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement `buildPopulateParams` URL helper
  - [x] 4.1 Create `infra/lambda/ingestion/populate-params.ts`
    - Implement pure function `buildPopulateParams(populate: PopulateConfig | undefined): URLSearchParams`
    - Wildcard=true sets `populate=*` and ignores fields (Req 2.1, 2.3)
    - Non-empty fields array appends each `{ key, value }` pair as a query param (Req 2.2)
    - Absent/null populate or empty fields with no wildcard produces empty params (Req 2.4)
    - Export `buildPopulateParams`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]\* 4.2 Write property test: wildcard=true produces populate=\* and suppresses fields (Property 5)
    - **Property 5: wildcard=true produces exactly populate=\* in URL and suppresses fields**
    - **Validates: Requirements 2.1, 2.3**
    - File: `infra/lambda/ingestion/__tests__/populate-params.property.test.ts`

  - [ ]\* 4.3 Write property test: non-empty fields array produces all entries as query params (Property 6)
    - **Property 6: Non-empty fields array produces all entries as query params**
    - **Validates: Requirements 2.2**
    - File: `infra/lambda/ingestion/__tests__/populate-params.property.test.ts`

- [x] 5. Implement `UidCollectionMap` helper
  - [x] 5.1 Create `infra/lambda/ingestion/uid-collection-map.ts`
    - Implement `buildUidCollectionMap(collections: StrapiCollectionConfig[]): Map<string, string>` — maps each `strapiUid` to `name`
    - Implement `lookupCollection(map: Map<string, string>, uid: string): string | undefined` — returns undefined for non-`api::` UIDs and unknown UIDs, logs WARN for both cases
    - Export both functions
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]\* 5.2 Write property test: UidCollectionMap exactly mirrors config (Property 12)
    - **Property 12: UidCollectionMap exactly mirrors config**
    - **Validates: Requirements 5.1, 5.3**
    - File: `infra/lambda/ingestion/__tests__/uid-collection-map.property.test.ts`

  - [ ]\* 5.3 Write property test: Non-api:: UIDs resolve to undefined (Property 13)
    - **Property 13: Non-api:: UIDs resolve to undefined**
    - **Validates: Requirements 5.5**
    - File: `infra/lambda/ingestion/__tests__/uid-collection-map.property.test.ts`

- [x] 6. Implement `CollectionMarkdownConverter`
  - [x] 6.1 Create `infra/lambda/ingestion/collection-markdown-converter.ts`
    - Implement `CollectionMarkdownConverter.convert(attrs, config, options)` static method
    - Prepend title resolved from `titleFields` (first non-blank value) as H1
    - Render `## Summary` section when `summaryField` resolves to a non-empty string
    - Dispatch to `content-blocks` strategy: read `attrs[contentBlocksField ?? "content_blocks"]` and delegate each element to existing `convertContentBlock`
    - Dispatch to `rich-text` strategy: read `attrs[richTextField]` as raw text
    - Dispatch to `flat-fields` strategy: concatenate non-null/non-whitespace values of `attrs[field]` for each field in `flatFields`, joined by `\n\n`
    - Export `CollectionMarkdownConverter`
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6_

  - [ ]\* 6.2 Write property test: titleFields resolution returns first non-blank value (Property 7)
    - **Property 7: titleFields resolution returns first non-blank value**
    - **Validates: Requirements 3.1**
    - File: `infra/lambda/ingestion/__tests__/collection-markdown-converter.property.test.ts`

  - [ ]\* 6.3 Write property test: flat-fields concatenation excludes null/whitespace values (Property 9)
    - **Property 9: flat-fields concatenation excludes null/whitespace values**
    - **Validates: Requirements 3.6**
    - File: `infra/lambda/ingestion/__tests__/collection-markdown-converter.property.test.ts`

  - [ ]\* 6.4 Write unit tests for CollectionMarkdownConverter
    - Summary section rendered correctly with non-empty summaryField (Req 3.3)
    - content-blocks strategy delegates to existing `convertContentBlock` (Req 3.4)
    - rich-text strategy reads richTextField verbatim (Req 3.5)
    - flat-fields strategy with all blank values produces empty content body (Req 3.6)
    - File: `infra/lambda/ingestion/__tests__/collection-markdown-converter.test.ts`

- [x] 7. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement `ConfigurableStrapiAdapter`
  - [x] 8.1 Create `infra/lambda/ingestion/configurable-strapi-adapter.ts`
    - Implement `ConfigurableStrapiAdapter` class implementing `DataSourceAdapter`
    - Constructor accepts `ConfigurableStrapiAdapterConfig` (baseUrl, apiToken, frontendBaseUrl, collections) and optional `RetryHttpClient`
    - `listContent(pagination, collectionName)`: build URL with pagination + `buildPopulateParams` for the matching collection, call Strapi, transform entries
    - `fetchById(recordId, collectionName)`: build URL with `buildPopulateParams` for the matching collection, call Strapi, transform entry
    - `detectChanges(since, collectionName)`: build URL with `filters[updatedAt][$gt]`, transform entries
    - Slug resolution: prefer `attrs[slugField]`, fall back to entry `id` when absent/whitespace (Req 3.2)
    - `lastModified` resolution: prefer `attrs[lastModifiedField ?? "updatedAt"]`, fall back to `attrs.createdAt`, log WARN and omit when both absent (Req 3.7, 3.8)
    - `sourceUrl` construction using `urlPathTemplate` + `frontendBaseUrl` + resolved slug (Req 4.1, 4.2, 4.3)
    - Warn and omit `sourceUrl` for invalid template/slug/baseUrl combinations (Req 4.4–4.7)
    - Delegate content body generation to `CollectionMarkdownConverter.convert`
    - Export `ConfigurableStrapiAdapter`, `ConfigurableStrapiAdapterConfig`
    - _Requirements: 1.3, 1.8, 3.2, 3.7, 3.8, 4.1–4.7_

  - [ ]\* 8.2 Write property test: collections pass-through is exact (Property 2)
    - **Property 2: Collections pass-through is exact**
    - **Validates: Requirements 1.3**
    - File: `infra/lambda/ingestion/__tests__/configurable-strapi-adapter.property.test.ts`

  - [ ]\* 8.3 Write property test: whitespace-only or absent slug falls back to entry id (Property 8)
    - **Property 8: Whitespace-only or absent slug falls back to entry id**
    - **Validates: Requirements 3.2**
    - File: `infra/lambda/ingestion/__tests__/configurable-strapi-adapter.property.test.ts`

  - [ ]\* 8.4 Write property test: sourceUrl construction is correct for any valid template and slug (Property 10)
    - **Property 10: sourceUrl construction is correct for any valid template and slug**
    - **Validates: Requirements 4.2**
    - File: `infra/lambda/ingestion/__tests__/configurable-strapi-adapter.property.test.ts`

  - [ ]\* 8.5 Write property test: sourceUrl is omitted for invalid templates, slugs, or base URLs (Property 11)
    - **Property 11: sourceUrl is omitted for invalid templates, slugs, or base URLs**
    - **Validates: Requirements 4.4, 4.5, 4.6, 4.7**
    - File: `infra/lambda/ingestion/__tests__/configurable-strapi-adapter.property.test.ts`

  - [ ]\* 8.6 Write unit tests for ConfigurableStrapiAdapter
    - No populate params when `populate` is absent (Req 1.8, 2.4)
    - `urlPathTemplate` absent/empty omits sourceUrl (Req 4.3)
    - `frontendBaseUrl` absent omits sourceUrl for all collections (Req 4.7)
    - `lastModified` fallback chain: field present / only createdAt / neither (Req 3.8)
    - File: `infra/lambda/ingestion/__tests__/configurable-strapi-adapter.test.ts`

- [x] 9. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 10. Update `handler.ts` to use config-driven adapter
  - [x] 10.1 Remove hard-coded constants and wire config at cold start
    - Remove `STRAPI_COLLECTIONS` and `STRAPI_UID_TO_COLLECTION` constants from `handler.ts`
    - Add `ConfigLoader.load()` call at module init; Lambda fails cold start on validation error
    - Build `uidMap` from `config.strapi.collections` via `buildUidCollectionMap`
    - Replace `createAdapter` factory with construction of `ConfigurableStrapiAdapter`
    - Update `handleFullSync` to iterate `config.strapi.collections.map(c => c.name)`
    - Update `normalizeStrapiPayload` to use `lookupCollection(uidMap, raw.uid)` instead of the hard-coded map; log WARN for unrecognised UIDs (Req 5.4, 5.5)
    - Handle empty collections in full sync: return immediately with zero `FullSyncResult` and INFO log (Req 6.2)
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2_

  - [ ]\* 10.2 Write property test: full sync processes exactly the configured collections (Property 14)
    - **Property 14: Full sync processes exactly the configured collections**
    - **Validates: Requirements 6.1**
    - Mock `FullSyncPipeline` to capture invocations; assert one call per `config.strapi.collections[*].name`
    - File: `infra/lambda/ingestion/__tests__/handler.property.test.ts`

  - [ ]\* 10.3 Write property test: full sync aggregates results correctly (Property 15)
    - **Property 15: Full sync aggregates results correctly**
    - **Validates: Requirements 6.4**
    - File: `infra/lambda/ingestion/__tests__/handler.property.test.ts`

  - [ ]\* 10.4 Write unit tests for updated handler
    - Cold start with invalid config throws descriptive error (Req 7.1, 7.2)
    - Full sync with empty collections returns zero FullSyncResult (Req 6.2)
    - Per-collection failure logs WARN and continues (Req 6.3)
    - File: `infra/lambda/ingestion/__tests__/handler.test.ts`

- [x] 11. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 12. Write backward-compatibility regression tests
  - [x] 12.1 Create `infra/lambda/ingestion/__tests__/backward-compat.test.ts`
    - Load fixture data for each ThinkHQ collection (intranet-pages, intranet-teams, intranet-people) matching current hard-coded converter outputs
    - Assert `CollectionMarkdownConverter` with ThinkHQ config produces string-equal output to current `convertPage`, `convertTeam`, `convertPerson` for each fixture (Req 8.2, 8.3, 8.4)
    - Assert S3 document key from updated adapter is string-equal to current `deriveDocumentPath` output for each fixture (Req 8.5)
    - _Requirements: 8.2, 8.3, 8.4, 8.5_

- [x] 13. Update `deployment.json` and `deployment.example.json`
  - [x] 13.1 Update `infra/config/deployment.json` for ThinkHQ client
    - Add `strapi.collections` array with entries for `intranet-pages`, `intranet-teams`, and `intranet-people`
    - Each entry carries `strapiUid`, `fieldMappings`, `urlPathTemplate`, and `populate` values that exactly replicate the current hard-coded adapter logic (see design data model section)
    - _Requirements: 8.1_

  - [x] 13.2 Update `infra/config/deployment.example.json`
    - Add `strapi.collections` array with three example entries — one per strategy: `content-blocks`, `rich-text`, `flat-fields`
    - All required fields populated with clearly labelled placeholder values
    - _Requirements: 9.1, 9.3_

- [x] 14. Create client onboarding documentation
  - [x] 14.1 Create `docs/onboarding-new-client.md`
    - Numbered procedure: (1) copy `deployment.example.json` → `deployment.json` and replace placeholders, (2) define `strapi.collections` with correct `markdownStrategy` per collection, (3) set `urlPathTemplate` per collection, (4) store Strapi API token and secrets in AWS Secrets Manager using referenced key names, (5) run `cdk deploy`, (6) trigger full sync via admin API to populate the Knowledge Base
    - _Requirements: 9.2_

- [x] 15. Config artifact tests
  - [x] 15.1 Create `infra/lambda/ingestion/__tests__/config-artifact.test.ts`
    - Parse `deployment.example.json` and verify all three strategy examples are present (Req 9.1)
    - Load and validate `deployment.example.json` with placeholders replaced by structurally valid values — ConfigLoader returns no errors (Req 9.3)
    - _Requirements: 9.1, 9.3_

- [x] 16. Final checkpoint — Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property-based tests use `fast-check` (`fc.assert(fc.property(...))`, `numRuns: 100`) matching the Jest test runner in `infra/`
- Each property test file has a comment tag above each test: `// Feature: multi-client-strapi-config, Property N: <property text>`
- The existing `StrapiAdapter` is kept unchanged for backward compatibility; `ConfigurableStrapiAdapter` is introduced alongside it
- Backward-compat tests in task 12.1 guard against any markdown output regression for existing ThinkHQ collections
- `deployment.json` is not committed to source control (it's in `.gitignore`); task 13.1 updates it in the local environment

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "4.1", "5.1"] },
    {
      "id": 2,
      "tasks": [
        "2.2",
        "2.3",
        "2.4",
        "2.5",
        "2.6",
        "2.7",
        "4.2",
        "4.3",
        "5.2",
        "5.3",
        "6.1"
      ]
    },
    { "id": 3, "tasks": ["6.2", "6.3", "6.4", "8.1"] },
    { "id": 4, "tasks": ["8.2", "8.3", "8.4", "8.5", "8.6", "10.1"] },
    { "id": 5, "tasks": ["10.2", "10.3", "10.4", "12.1"] },
    { "id": 6, "tasks": ["13.1", "13.2", "14.1"] },
    { "id": 7, "tasks": ["15.1"] }
  ]
}
```
