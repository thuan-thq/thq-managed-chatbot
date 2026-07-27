# Requirements Document

## Introduction

Enhance the existing ingestion Lambda to produce markdown-formatted content optimized for Bedrock Knowledge Base retrieval. The current system stores content as JSON documents with plain-text contentBody extracted by the StrapiAdapter. This feature ports the key markdown conversion logic from the old export service (`lib/export/`) into the Lambda's architecture, producing well-structured markdown with headers, metadata, lists, and content block formatting - without depending on Next.js or Amplify SDK.

## Glossary

- **Ingestion_Lambda**: The Lambda function at `infra/lambda/ingestion/` that handles content ingestion from Strapi into S3 for Bedrock KB indexing.
- **StrapiAdapter**: The data source adapter that fetches and transforms Strapi CMS entries into ContentRecord format.
- **MarkdownConverter**: A module that transforms Strapi content data into well-structured markdown text optimized for retrieval-augmented generation.
- **ContentRecord**: The normalized document format produced by adapters containing recordId, contentBody, contentType, metadata, and lastModified.
- **S3ContentClient**: The client that persists content documents to S3 at `documents/{recordId}.json`.
- **Content_Block**: A Strapi dynamic zone component (e.g., text-block, accordion, photos-block, link-cards) that forms the body of a page.
- **Content_Type_Converter**: A function that handles page-level conversion for a specific Strapi collection (pages, teams, people).
- **Bedrock_KB**: Amazon Bedrock Knowledge Base that indexes S3 content for retrieval-augmented generation.
- **Dynamic_Zone**: A Strapi field type that allows mixing different component types within a single field (e.g., content_blocks).

## Requirements

### Requirement 1: Markdown Conversion Module

**User Story:** As a developer, I want a modular markdown conversion layer within the ingestion Lambda, so that Strapi content is converted into well-structured markdown optimized for Bedrock KB retrieval.

#### Acceptance Criteria

1. THE MarkdownConverter SHALL expose a static method `toMarkdown(data, contentType)` that accepts Strapi entry data and a content type identifier and returns a markdown string.
2. WHEN the MarkdownConverter receives null or undefined data, THE MarkdownConverter SHALL return an empty string.
3. WHEN the MarkdownConverter receives an unknown content type, THE MarkdownConverter SHALL fall back to a generic converter that extracts title, metadata, and common text fields.
4. IF the MarkdownConverter encounters an error during conversion, THEN THE MarkdownConverter SHALL return a minimal fallback markdown containing the title, content type, error message, and raw data as a JSON code block.

### Requirement 2: Content Type Converters

**User Story:** As a developer, I want content-type specific converters for pages, teams, and people, so that each collection produces markdown matching the structure and semantics of the frontend display.

#### Acceptance Criteria

1. WHEN converting an intranet-page entry, THE Page_Converter SHALL produce markdown containing the page title as an H1 heading, metadata section, summary section, and rendered content_blocks.
2. WHEN converting an intranet-team entry, THE Team_Converter SHALL produce markdown containing the team name as an H1 heading, metadata section, summary, team members list, and rendered content_blocks.
3. WHEN converting an intranet-person entry, THE Person_Converter SHALL produce markdown containing the person's display name as an H1 heading, job title, team affiliation, biography, contact information, and rendered content_blocks.
4. WHEN a content type entry has a slug field, THE Content_Type_Converter SHALL include a source URL in the metadata section constructed from the base URL and slug.

### Requirement 3: Content Block Converters

**User Story:** As a developer, I want converters for Strapi dynamic zone content blocks, so that all content within pages is properly represented in the markdown output.

#### Acceptance Criteria

1. WHEN converting a text-block component, THE Block_Converter SHALL output the text content preserving any inline markdown formatting.
2. WHEN converting an accordion component, THE Block_Converter SHALL output each accordion item as a sub-heading with its title followed by the item summary text.
3. WHEN converting a link-block or document-block component, THE Block_Converter SHALL output a titled section with each link or document formatted as a markdown list item.
4. WHEN converting a 50-50-text-n-image component, THE Block_Converter SHALL output both left and right content sections with their text and image references.
5. WHEN converting a table component containing HTML, THE Block_Converter SHALL parse the HTML table into a markdown table with header separators.
6. WHEN converting a photos-block or shuffled-photo component, THE Block_Converter SHALL output image references with alt text and optional captions.
7. WHEN converting a link-cards component, THE Block_Converter SHALL output each card as a sub-heading with title, link, and optional icon reference.
8. WHEN encountering an unknown block component type, THE Block_Converter SHALL extract any text, title, or summary fields and output them as a labeled section.

### Requirement 4: Metadata Formatting

**User Story:** As a developer, I want consistent metadata sections in the markdown output, so that Bedrock KB has rich context for retrieval and attribution.

#### Acceptance Criteria

1. THE Metadata_Formatter SHALL output metadata as a series of bold-labeled key-value lines including content type, ID, slug, creation date, update date, and publish date when available.
2. WHEN a content entry has team, office, or tag associations, THE Metadata_Formatter SHALL include those relationships in the metadata section.
3. WHEN a source URL is provided or constructable from the slug, THE Metadata_Formatter SHALL include it as a "View online" link in the metadata section.

### Requirement 5: Integration with StrapiAdapter

**User Story:** As a developer, I want the StrapiAdapter to use the MarkdownConverter for content body extraction, so that stored documents contain markdown instead of plain text concatenation.

#### Acceptance Criteria

1. WHEN the StrapiAdapter transforms a Strapi entry, THE StrapiAdapter SHALL invoke the MarkdownConverter to produce the contentBody field instead of plain text extraction.
2. WHEN the MarkdownConverter produces a non-empty result, THE StrapiAdapter SHALL set the contentType field to "text/markdown" on the resulting ContentRecord.
3. IF the MarkdownConverter returns an empty string for valid entry data, THEN THE StrapiAdapter SHALL fall back to the existing plain text extraction method and set contentType to "text/plain".
4. THE StrapiAdapter SHALL pass the full Strapi entry attributes (including content_blocks dynamic zone data) to the MarkdownConverter.

### Requirement 6: S3 Storage Format and File Naming

**User Story:** As a developer, I want the ingested documents stored with human-readable file names and a format optimized for Bedrock KB, so that content is easily identifiable in S3 and well-formatted for retrieval.

#### Acceptance Criteria

1. THE S3ContentClient SHALL store documents using a descriptive file name derived from the content's slug, title, or name field, formatted as `documents/{collection}/{slug-or-name}.json` (e.g., `documents/intranet-pages/about-us.json`).
2. WHEN a content entry has a slug field, THE S3ContentClient SHALL use the slug as the file name component.
3. WHEN a content entry has no slug but has a title or name field, THE S3ContentClient SHALL convert the title/name to a URL-safe slug (lowercase, spaces replaced with hyphens, special characters removed) and use it as the file name component.
4. WHEN neither slug, title, nor name is available, THE S3ContentClient SHALL fall back to using the recordId as the file name component.
5. WHEN storing a markdown document, THE S3ContentDocument SHALL contain the markdown string in the contentBody field and "text/markdown" in the contentType field.
6. THE S3ContentDocument metadata SHALL continue to include clientId, title, lastModified, and sourceUrl fields for Bedrock KB metadata filtering.

### Requirement 7: Pipeline Compatibility

**User Story:** As a developer, I want the markdown conversion to work seamlessly with both the FullSyncPipeline and WebhookEventRouter, so that all ingestion paths produce markdown content.

#### Acceptance Criteria

1. WHEN the FullSyncPipeline processes records, THE pipeline SHALL receive markdown-formatted ContentRecords from the StrapiAdapter without any pipeline code changes.
2. WHEN the WebhookEventRouter handles a create or update event, THE router SHALL receive markdown-formatted content from the StrapiAdapter's fetchById method without any router code changes.
3. THE markdown conversion SHALL complete within the existing Lambda timeout constraints (no more than 500ms additional processing time per record).

### Requirement 8: No External Dependencies

**User Story:** As a developer, I want the markdown converter to operate without Next.js or Amplify SDK dependencies, so that it runs cleanly in the Lambda runtime.

#### Acceptance Criteria

1. THE MarkdownConverter SHALL operate without importing any Next.js modules, Amplify SDK packages, or browser-specific APIs.
2. THE MarkdownConverter SHALL operate without making external HTTP calls for conversion (all data needed for conversion is passed in as parameters).
3. THE MarkdownConverter SHALL be compatible with Node.js 20.x Lambda runtime without additional native dependencies.

### Requirement 9: HTML Table Parsing

**User Story:** As a developer, I want HTML tables in Strapi content to be converted to markdown tables, so that tabular data is preserved in the knowledge base.

#### Acceptance Criteria

1. WHEN an HTML table contains `<th>` elements, THE HTML_Table_Parser SHALL use those cells as the markdown table header row.
2. WHEN an HTML table has `<td>` elements without `<th>`, THE HTML_Table_Parser SHALL use the first row as the header.
3. THE HTML_Table_Parser SHALL produce a valid markdown table with pipe separators and a header separator line.
4. IF the HTML table cannot be parsed, THEN THE HTML_Table_Parser SHALL wrap the raw HTML in a code block as a fallback.
