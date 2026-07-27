# Tasks

- [x] Task 1: Define types and interfaces for the markdown converter {requirements: [1.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 6.5], design: [Data Models, S3ContentDocument modified]}
  - [x] 1.1 Create `infra/lambda/ingestion/markdown-converter/` directory structure
  - [x] 1.2 Define `ContentBlock` interface with `__component` discriminator, text fields, nested items, links, files, photos, cards, and table fields
  - [x] 1.3 Define `StrapiImage` interface with url, alternativeText, caption, name, width, height fields
  - [x] 1.4 Define `StrapiFile` interface with url, name, size, mime, ext fields
  - [x] 1.5 Add optional `documentPath` field to `S3ContentDocument` interface in `types.ts`
  - [x] 1.6 Export all new types from a shared types file within the markdown-converter module

- [x] Task 2: Implement helpers module {requirements: [4.1, 4.2, 4.3, 6.2, 6.3, 9.1, 9.2, 9.3, 9.4], design: [Component 4: Helpers]} [depends on: Task 1]
  - [x] 2.1 Implement `toSlug(value: string): string` - converts title/name to URL-safe slug (lowercase, hyphens, no special chars)
  - [x] 2.2 Implement `parseHTMLTableToMarkdown(html: string): string` - regex-based HTML table to markdown table conversion with code block fallback
  - [x] 2.3 Implement `formatMetadata(data, contentType, sourceUrl?): string` - bold-labeled key-value metadata section with dates, tags, team, office, and source URL
  - [x] 2.4 Implement `formatImage(image: StrapiImage): string` - markdown image with alt text and optional caption
  - [x] 2.5 Implement `formatLink(text, url, targetBlank?): string` - markdown link with optional external indicator
  - [x] 2.6 Implement `formatFile(file: StrapiFile): string` - file/document attachment reference as markdown link
  - [x] 2.7 Implement `cleanMarkdownText(text: string): string` - trim and normalize rich text content
  - [x] 2.8 Implement `normalizeTags(tags: unknown): string[]` - normalize array or comma-separated tags to string array
  - [x] 2.9 Implement `extractTitle(data: Record<string, unknown>): string` - extract best title from various Strapi field patterns

- [x] Task 3: Implement content block converters {requirements: [3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8], design: [Component 3: Content Block Converters]} [depends on: Task 1, Task 2]
  - [x] 3.1 Implement `convertContentBlock(block: ContentBlock): string` router that dispatches on `__component` field
  - [x] 3.2 Implement text-block converter (`dynamic.text-block`, `dynamic.changeling-text-block`) - preserves inline markdown
  - [x] 3.3 Implement accordion converter (`dynamic.accordion`) - sub-headings with title and summary for each item
  - [x] 3.4 Implement 50-50-text-n-image converter (`dynamic.50-50-text-n-image`) - left/right content sections with text and image references
  - [x] 3.5 Implement double-text-block converter (`dynamic.double-text-block`) - left/right column titles and bodies
  - [x] 3.6 Implement links converter (`sidebar.link-block`, `dynamic.columns-link-block`) - titled section with markdown list items
  - [x] 3.7 Implement documents converter (`sidebar.document-block`) - titled section with file list items
  - [x] 3.8 Implement photos converter (`dynamic.photos-block`, `dynamic.shuffled-photo`) - image references with alt text and captions
  - [x] 3.9 Implement table converter (`dynamic.table`) - delegates to `parseHTMLTableToMarkdown` helper
  - [x] 3.10 Implement link-cards converter (`intranet-blocks.link-cards`) - sub-headings with title, link, and optional icon
  - [x] 3.11 Implement unknown block fallback - extracts text, title, or summary fields as a labeled section

- [x] Task 4: Implement content type converters {requirements: [2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3], design: [Component 2: Content Type Converters]} [depends on: Task 2, Task 3]
  - [x] 4.1 Implement `convertPage(data): string` - H1 title, metadata section, summary, source URL from slug, and rendered content_blocks
  - [x] 4.2 Implement `convertTeam(data): string` - H1 team name, metadata section, summary, team members list, and rendered content_blocks
  - [x] 4.3 Implement `convertPerson(data): string` - H1 display name, job title, team affiliation, biography, contact info, and rendered content_blocks

- [x] Task 5: Implement MarkdownConverter main class {requirements: [1.1, 1.2, 1.3, 1.4, 8.1, 8.2, 8.3], design: [Component 1: MarkdownConverter]} [depends on: Task 4]
  - [x] 5.1 Create `infra/lambda/ingestion/markdown-converter/index.ts` with `MarkdownConverter` class
  - [x] 5.2 Implement static `toMarkdown(data, contentType): string` that routes to `convertPage`, `convertTeam`, or `convertPerson`
  - [x] 5.3 Implement null/undefined guard returning empty string
  - [x] 5.4 Implement generic fallback converter for unknown content types (extracts title, metadata, common text fields)
  - [x] 5.5 Implement error fallback returning markdown with title, content type, error message, and raw data as JSON code block
  - [x] 5.6 Verify no Next.js, Amplify, or browser-specific imports; no external HTTP calls; Node.js 20.x compatible

- [x] Task 6: Modify S3ContentClient to support documentPath {requirements: [6.1, 6.2, 6.3, 6.4, 6.5], design: [Component 5: S3ContentClient Modified]} [depends on: Task 1]
  - [x] 6.1 Modify `putDocument()` to use `document.documentPath` when provided, falling back to `documents/{recordId}.json`
  - [x] 6.2 Modify `deleteDocument()` to accept optional `documentPath` parameter, falling back to `documents/{recordId}.json`
  - [x] 6.3 Ensure backwards compatibility - existing records without documentPath continue to work at old paths

- [x] Task 7: Integrate MarkdownConverter into StrapiAdapter {requirements: [5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3], design: [Component 6: StrapiAdapter Modified]} [depends on: Task 5, Task 6]
  - [x] 7.1 Import MarkdownConverter and `toSlug` into `strapi-adapter.ts`
  - [x] 7.2 Modify `transformEntry()` to call `MarkdownConverter.toMarkdown(attrs, collection)` for contentBody
  - [x] 7.3 Set `contentType` to `"text/markdown"` when converter returns non-empty, fall back to existing extraction with `"text/plain"`
  - [x] 7.4 Implement `deriveDocumentPath(attrs, recordId): string` - uses slug, title-to-slug, or recordId fallback
  - [x] 7.5 Include `documentPath` in the ContentRecord metadata so pipelines pass it through to S3ContentClient
  - [x] 7.6 Ensure full Strapi entry attributes (including content_blocks) are passed to MarkdownConverter

- [x] Task 8: Unit tests for helpers and converters {requirements: [1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3, 9.1, 9.2, 9.3, 9.4], design: [Testing Strategy]} [depends on: Task 5]
  - [x] 8.1 Write unit tests for `toSlug` with edge cases (special chars, unicode, empty strings, already-slugified input)
  - [x] 8.2 Write unit tests for `parseHTMLTableToMarkdown` with th headers, td-only tables, malformed HTML, and empty tables
  - [x] 8.3 Write unit tests for `formatMetadata`, `formatImage`, `formatLink`, `formatFile` helpers
  - [x] 8.4 Write unit tests for each content block converter with representative Strapi fixtures
  - [x] 8.5 Write unit tests for content type converters (page, team, person) with fixture data
  - [x] 8.6 Write unit tests for MarkdownConverter (null input, unknown type, error fallback, routing)

- [x] Task 9: Integration tests for full pipeline {requirements: [5.1, 5.2, 5.3, 5.4, 6.1, 6.5, 7.1, 7.2, 7.3], design: [Testing Strategy]} [depends on: Task 7]
  - [x] 9.1 Create Strapi API response fixtures for intranet-pages, intranet-teams, and intranet-people with content_blocks
  - [x] 9.2 Write integration test: StrapiAdapter transforms fixture entry into ContentRecord with markdown contentBody and "text/markdown" contentType
  - [x] 9.3 Write integration test: verify documentPath is correctly derived (slug-based, title-based, recordId fallback)
  - [x] 9.4 Write integration test: FullSyncPipeline processes markdown ContentRecords without code changes (mock S3)
  - [x] 9.5 Write integration test: WebhookEventRouter handles markdown ContentRecords without code changes (mock S3)
  - [x] 9.6 Write integration test: verify markdown conversion completes within 500ms per record for typical content
