# Requirements Document

## Introduction

This feature makes the chatbot project fully configurable for different clients, each of which has their own Strapi CMS instance with distinct content types, collections, dynamic zone components, and URL structures. Currently, collections, populate queries, markdown converters, and UID-to-collection mappings are all hard-coded in TypeScript. Onboarding a new client requires editing multiple source files across the ingestion Lambda.

The goal is a **configuration-driven approach**: a single per-client JSON/YAML configuration file declares the Strapi collections to ingest, the Strapi API populate parameters for each collection, the markdown rendering strategy for each collection, and the field mappings needed to extract metadata (title, slug, source URL). When a new client is onboarded, an operator edits only that configuration file — no TypeScript source changes are required.

## Glossary

- **Client**: An organisation that deploys its own instance of the managed chatbot, with its own Strapi CMS, AWS resources, and `deployment.json`.
- **ClientConfig**: The top-level configuration object for a single client, loaded from `infra/config/deployment.json`.
- **StrapiCollectionConfig**: A per-collection configuration block that declares the populate parameters, field mappings, URL path template, and markdown strategy for one Strapi REST API collection.
- **ContentFieldMapping**: A configuration block specifying which Strapi field names to use for title, slug, summary, content blocks, and last-modified timestamp extraction.
- **PopulateConfig**: A structured declaration of Strapi `populate` query parameters for a collection, used to build REST API URLs.
- **MarkdownStrategy**: An enumeration of content rendering strategies: `content-blocks` (render via the dynamic zone converter), `rich-text` (render a single rich text field), and `flat-fields` (concatenate configured string fields).
- **CollectionMarkdownConverter**: A per-collection converter that applies the configured `MarkdownStrategy` and `ContentFieldMapping` to produce a markdown document from a raw Strapi entry.
- **ConfigurableStrapiAdapter**: The updated Strapi adapter that accepts a list of `StrapiCollectionConfig` objects at construction time instead of hard-coded collection details.
- **ConfigLoader**: The component responsible for loading, parsing, and validating `ClientConfig` at Lambda cold start.
- **DynamicZoneRegistry**: A registry that maps `__component` discriminators to converter functions, allowing new component types to be added via configuration rather than code changes.
- **UidCollectionMap**: A map from Strapi content-type UIDs (e.g. `api::intranet-page.intranet-page`) to REST API collection names (e.g. `intranet-pages`), used by the webhook normaliser.
- **Strapi**: The headless CMS used as the content source. Accessed via its v4 REST API.
- **Knowledge_Base**: The Amazon Bedrock Knowledge Base that stores vector embeddings of ingested documents for retrieval.

## Requirements

### Requirement 1: Per-Client Strapi Collection Configuration

**User Story:** As a developer onboarding a new client, I want to declare all Strapi collections in a configuration file, so that I do not need to change TypeScript source files to add or remove collections.

#### Acceptance Criteria

1. THE `ClientConfig` SHALL contain a `strapi` block with a `collections` array, where each element is a `StrapiCollectionConfig` object.
2. IF `ClientConfig.strapi` is absent or not an object, THEN THE ConfigLoader SHALL return a validation error indicating the `strapi` block is required.
3. WHEN the ingestion Lambda starts with a valid `ClientConfig`, THE ConfigLoader SHALL pass an array containing exactly the `StrapiCollectionConfig` objects declared in `ClientConfig.strapi.collections` to `ConfigurableStrapiAdapter` — no additional or fewer entries.
4. WHEN `ClientConfig.strapi.collections` is an empty array, THE ConfigLoader SHALL return a validation error indicating at least one collection must be configured.
5. WHEN a `StrapiCollectionConfig` element is missing the required `name` field, or `name` is present but is an empty string, THE ConfigLoader SHALL return a validation error identifying the invalid element by its zero-based array index.
6. THE `StrapiCollectionConfig` SHALL declare the following required fields: `name` (non-empty string — the Strapi REST API collection path, e.g. `intranet-pages`), `strapiUid` (non-empty string — the Strapi content-type UID, e.g. `api::intranet-page.intranet-page`), `markdownStrategy` (one of `content-blocks`, `rich-text`, `flat-fields`), and `fieldMappings` (a `ContentFieldMapping` object).
7. THE `StrapiCollectionConfig` SHALL accept an optional `populate` field containing a `PopulateConfig` object.
8. IF `populate` is omitted from a `StrapiCollectionConfig`, THEN THE `ConfigurableStrapiAdapter` SHALL make list and fetch-by-id requests for that collection with no populate query parameters.

### Requirement 2: Configurable Populate Parameters

**User Story:** As a developer, I want to declare Strapi populate parameters in the collection configuration, so that the adapter builds the correct REST API query for each client's dynamic zones without hard-coded switch-case logic.

#### Acceptance Criteria

1. THE `PopulateConfig` SHALL declare a `wildcard` boolean field; WHEN `wildcard` is `true`, THE `ConfigurableStrapiAdapter` SHALL append `populate=*` to list and fetch-by-id API requests for that collection.
2. THE `PopulateConfig` SHALL declare a `fields` array of objects with the shape `{ key: string; value: string }`; WHEN `fields` is present and non-empty, THE `ConfigurableStrapiAdapter` SHALL append each object as a separate query parameter in the form `key=value` (e.g. `populate[content_blocks][on][dynamic.text-block][populate]=*`).
3. WHEN `wildcard` is `true` and `fields` is also present and non-empty in a `PopulateConfig`, THE `ConfigurableStrapiAdapter` SHALL append only `populate=*` and SHALL NOT append any of the `fields` entries.
4. WHEN `populate` is absent, `populate` is `null`, or `populate.fields` is an empty array and `wildcard` is `false` or absent, THE `ConfigurableStrapiAdapter` SHALL make list and fetch-by-id requests with no populate query parameters.
5. FOR ALL valid `PopulateConfig` objects, serialising the config to JSON and deserialising it SHALL produce a `PopulateConfig` whose query parameters are string-equal to those generated from the original object.

### Requirement 3: Configurable Field Mappings

**User Story:** As a developer, I want to specify which Strapi field names map to title, slug, summary, and content in the collection config, so that the adapter can extract the correct metadata and content body without hard-coded field names.

#### Acceptance Criteria

1. THE `ContentFieldMapping` SHALL include an optional `titleFields` string array; WHEN provided, THE `CollectionMarkdownConverter` SHALL iterate through `titleFields` in order and use the first value that is not null, not undefined, and not a string containing only whitespace characters as the document title; IF all values are absent or whitespace-only, THE converter SHALL omit the title from the output.
2. THE `ContentFieldMapping` SHALL include an optional `slugField` string; WHEN provided and `attrs[slugField]` resolves to a non-empty, non-whitespace-only string, THE `ConfigurableStrapiAdapter` SHALL use that value as the document slug for S3 key derivation and `sourceUrl` construction; IF `slugField` is provided but the resolved value is absent or whitespace-only, THE adapter SHALL fall back to the entry's `id` as the slug.
3. THE `ContentFieldMapping` SHALL include an optional `summaryField` string; WHEN provided and `attrs[summaryField]` is a non-empty string, THE `CollectionMarkdownConverter` SHALL render a level-2 markdown heading `## Summary` followed by the field value as a paragraph immediately after the title section.
4. THE `ContentFieldMapping` SHALL include an optional `contentBlocksField` string (default: `content_blocks`); WHEN `markdownStrategy` is `content-blocks`, THE `CollectionMarkdownConverter` SHALL read the dynamic zone array from `attrs[contentBlocksField]`.
5. THE `ContentFieldMapping` SHALL include an optional `richTextField` string; WHEN `markdownStrategy` is `rich-text`, THE `CollectionMarkdownConverter` SHALL read the rich text body from `attrs[richTextField]`.
6. THE `ContentFieldMapping` SHALL include an optional `flatFields` string array; WHEN `markdownStrategy` is `flat-fields`, THE `CollectionMarkdownConverter` SHALL concatenate the non-null, non-undefined, non-whitespace-only values of `attrs[field]` for each field in `flatFields`, separated by `\n\n`; IF all resolved values are absent or whitespace-only, THE converter SHALL produce an empty content body.
7. THE `ContentFieldMapping` SHALL include an optional `lastModifiedField` string (default: `updatedAt`); WHEN `attrs[lastModifiedField]` is present and non-null, THE `ConfigurableStrapiAdapter` SHALL use that value as the `lastModified` timestamp.
8. IF `attrs[lastModifiedField]` is absent or null, THE `ConfigurableStrapiAdapter` SHALL fall back to `attrs.createdAt`; IF `attrs.createdAt` is also absent or null, THE adapter SHALL log a WARN-level entry and omit `lastModified` from the document metadata.

### Requirement 4: Configurable Source URL Template

**User Story:** As a developer, I want to declare a URL path template per collection, so that the correct front-end link is embedded in each document's metadata without hard-coded path prefixes.

#### Acceptance Criteria

1. THE `StrapiCollectionConfig` SHALL include an optional `urlPathTemplate` string field using `{slug}` as the sole placeholder token (e.g. `/team/{slug}`, `/people/{slug}`, `/{slug}`); a `urlPathTemplate` that is an empty string SHALL be treated as absent.
2. IF `urlPathTemplate` is present (non-empty) and the entry's resolved slug is a non-empty, non-whitespace-only string and `urlPathTemplate` contains the `{slug}` placeholder, THEN THE `ConfigurableStrapiAdapter` SHALL construct `sourceUrl` as `{frontendBaseUrl}{urlPathTemplate}` with all occurrences of `{slug}` replaced by the entry's slug value.
3. IF `urlPathTemplate` is absent or empty, THEN THE `ConfigurableStrapiAdapter` SHALL omit `sourceUrl` from the document metadata.
4. IF the entry's resolved slug is empty or whitespace-only, THEN THE `ConfigurableStrapiAdapter` SHALL log a WARN-level structured JSON entry and omit `sourceUrl` from the document metadata, regardless of `urlPathTemplate`.
5. IF `urlPathTemplate` does not contain the `{slug}` placeholder, THEN THE `ConfigurableStrapiAdapter` SHALL log a WARN-level structured JSON entry and omit `sourceUrl` from the document metadata.
6. IF the resolved `sourceUrl` does not start with `http://` or `https://` (e.g. because `frontendBaseUrl` is missing or malformed), THEN THE `ConfigurableStrapiAdapter` SHALL log a WARN-level structured JSON entry and omit `sourceUrl` from the document metadata.
7. IF `frontendBaseUrl` in `ClientConfig` is absent or an empty string, THEN THE `ConfigurableStrapiAdapter` SHALL log a WARN-level structured JSON entry and omit `sourceUrl` from the document metadata for all collections.

### Requirement 5: Configurable Webhook UID-to-Collection Mapping

**User Story:** As a developer, I want the webhook normaliser to derive collection names from configuration rather than a hard-coded map, so that new client content types are handled without modifying handler.ts.

#### Acceptance Criteria

1. WHEN the ingestion Lambda initialises, THE webhook handler SHALL build a `UidCollectionMap` by iterating `ClientConfig.strapi.collections` and mapping each `StrapiCollectionConfig.strapiUid` (the full UID string, e.g. `api::intranet-page.intranet-page`) to the corresponding `StrapiCollectionConfig.name`.
2. THE webhook handler SHALL NOT contain a hard-coded `STRAPI_UID_TO_COLLECTION` constant or any literal UID-to-collection mappings in source code.
3. WHEN a Strapi webhook arrives with a `uid` field, THE webhook normaliser SHALL look up the full `uid` value against the `UidCollectionMap` keys and, if a match is found, use the corresponding `StrapiCollectionConfig.name` as the collection for event routing.
4. WHEN no matching entry is found in the `UidCollectionMap` for the incoming `uid`, THE webhook normaliser SHALL log a WARN-level structured JSON entry containing the unrecognised UID and SHALL set `collection` to `undefined` in the normalised `WebhookPayload`.
5. WHEN a Strapi webhook arrives with a `uid` value that does not begin with `api::` (e.g. a plugin-managed content type), THE webhook normaliser SHALL log a WARN-level structured JSON entry containing the UID and SHALL set `collection` to `undefined` in the normalised `WebhookPayload`.

### Requirement 6: Configuration-Driven Full Sync

**User Story:** As a system operator, I want the full sync to iterate over the collections listed in the configuration, so that adding a new collection to the config file automatically includes it in the next sync without code changes.

#### Acceptance Criteria

1. WHEN a full sync is triggered, THE handler SHALL derive the list of collections to sync exclusively from `ClientConfig.strapi.collections[*].name`.
2. IF `ClientConfig.strapi.collections` is empty at the time a full sync is triggered, THE handler SHALL return immediately with a `FullSyncResult` where `totalRecords` is `0`, `totalErrors` is `0`, `success` is `true`, and a log entry at INFO level noting that no collections were configured.
3. WHEN a collection in the configured list fails during full sync, THE handler SHALL log a WARN-level entry with the collection name and the per-collection error count and SHALL continue processing all remaining collections.
4. WHEN all configured collections have been processed, THE handler SHALL return a `FullSyncResult` containing: `totalRecords` (sum of records processed across all collections), `totalErrors` (sum of errors across all collections), `lastIngestionJobId` (the job ID from the final Bedrock ingestion call), and `success` set to `true` if `totalErrors` is `0` and `false` otherwise.

### Requirement 7: Configuration Schema Validation

**User Story:** As a developer, I want the configuration to be validated at Lambda cold start, so that misconfigured deployments fail fast with a descriptive error rather than silently ingesting nothing.

#### Acceptance Criteria

1. WHEN the Lambda initialises, THE ConfigLoader SHALL validate `ClientConfig` against the declared schema; IF one or more validation failures are found, THE ConfigLoader SHALL throw an error whose message is a single string listing each failing field's dot-notation path and a human-readable description of the violation.
2. IF validation fails at Lambda initialisation, THE Lambda SHALL not process any incoming events until a cold start with a valid configuration succeeds.
3. IF `ClientConfig.strapi.baseUrl` is not a string starting with `http://` or `https://` followed by a non-empty host segment, THEN THE ConfigLoader SHALL include a validation error for the path `strapi.baseUrl`.
4. IF a `StrapiCollectionConfig.markdownStrategy` value is not one of the literals `content-blocks`, `rich-text`, or `flat-fields`, THEN THE ConfigLoader SHALL include a validation error identifying the collection by its `name` field value, or by its zero-based array index if `name` is absent.
5. IF a `StrapiCollectionConfig` has `markdownStrategy: "rich-text"` but `fieldMappings.richTextField` is absent or an empty string, THEN THE ConfigLoader SHALL include a validation error identifying the collection and stating that `richTextField` is required for the `rich-text` strategy.
6. IF a `StrapiCollectionConfig` has `markdownStrategy: "flat-fields"` but `fieldMappings.flatFields` is absent or an empty array, THEN THE ConfigLoader SHALL include a validation error identifying the collection and stating that `flatFields` must contain at least one entry for the `flat-fields` strategy.
7. THE `ClientConfig` schema SHALL be defined such that any object that satisfies the schema will produce identical validation outcomes when serialised to JSON and deserialised back before re-validation.

### Requirement 8: Backward Compatibility for Existing Client

**User Story:** As the ThinkHQ operator, I want the existing ThinkHQ client deployment to continue working after this change, so that the refactor does not require a re-ingestion or data migration.

#### Acceptance Criteria

1. THE `deployment.json` for the ThinkHQ client SHALL be updated to include a `strapi.collections` array with entries for `intranet-pages`, `intranet-teams`, and `intranet-people`, each carrying the `strapiUid`, `fieldMappings`, `urlPathTemplate`, and `populate` values that replicate the behaviour of the current hard-coded adapter logic for those collections.
2. WHEN the updated `ConfigurableStrapiAdapter` is given the ThinkHQ `ClientConfig` and a raw `intranet-pages` Strapi entry object, THE markdown output SHALL be string-equal to the output produced by the current hard-coded `convertPage` function given the same entry object.
3. WHEN the updated `ConfigurableStrapiAdapter` is given the ThinkHQ `ClientConfig` and a raw `intranet-teams` Strapi entry object, THE markdown output SHALL be string-equal to the output produced by the current hard-coded `convertTeam` function given the same entry object.
4. WHEN the updated `ConfigurableStrapiAdapter` is given the ThinkHQ `ClientConfig` and a raw `intranet-people` Strapi entry object, THE markdown output SHALL be string-equal to the output produced by the current hard-coded `convertPerson` function given the same entry object.
5. THE S3 document key generated by the updated adapter for each ThinkHQ entry SHALL be string-equal to the key generated by the current adapter for the same entry, using the same slug-resolution priority order (slug field value → slugified title → slugified name → record ID) that the current adapter applies.

### Requirement 9: Client Onboarding Template

**User Story:** As a developer onboarding a new client, I want a template configuration file and runbook, so that I can set up a new client's Strapi integration in a predictable, repeatable way.

#### Acceptance Criteria

1. THE `infra/config/deployment.example.json` file SHALL be updated to include a `strapi.collections` array containing at least three example collection entries — one demonstrating the `content-blocks` strategy, one demonstrating the `rich-text` strategy, and one demonstrating the `flat-fields` strategy — each with all required fields populated with clearly labelled placeholder values.
2. THE repository SHALL contain a dedicated `docs/onboarding-new-client.md` file (not embedded in `RUNBOOK.md`) with a numbered procedure covering exactly these steps: (1) copy `deployment.example.json` to `deployment.json` and replace all placeholder values, (2) define `strapi.collections` for the client's content model choosing the appropriate `markdownStrategy` for each collection, (3) set `urlPathTemplate` per collection, (4) store the Strapi API token and other secrets in AWS Secrets Manager using the key names referenced in the config, (5) run `cdk deploy` to provision the client's infrastructure, and (6) trigger a full sync via the admin API to populate the Knowledge Base.
3. WHEN the ConfigLoader is given the example `deployment.example.json` with all placeholder values replaced by structurally valid values (non-empty strings for required string fields, valid URLs for URL fields, valid enum values for strategy fields), THE ConfigLoader SHALL return no validation errors.
