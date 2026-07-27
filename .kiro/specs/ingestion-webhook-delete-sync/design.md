# Ingestion Webhook Delete Sync Bugfix Design

## Overview

When a Strapi `entry.delete` (or `entry.unpublish`) webhook arrives, the ingestion pipeline
fails to remove the correct document from S3 and the Bedrock Knowledge Base. The record is
already gone from Strapi, so `fetchById` returns `null` and the router falls back to
constructing the S3 key from `config.sourceType`. The problem is that `processWebhookEvent`
in `handler.ts` passes `sourceType: source` — the raw URL path parameter (e.g. `"strapi"`) —
rather than the resolved collection name (e.g. `"intranet-pages"`). The resulting key
`documents/strapi/<slug>.json` never exists in S3, so the `DeleteObject` call silently
succeeds, and the Bedrock KB `DeleteKnowledgeBaseDocuments` call targets the wrong URI,
leaving the indexed content intact.

The fix is minimal and surgical: in `processWebhookEvent`, replace `sourceType: source` with
`sourceType: collection` when building `EventRouterConfig`. The `collection` variable is
already resolved on the line above (preferring `payload.collection`, then matching against
`STRAPI_COLLECTIONS`, with `"articles"` as the last-resort fallback), so no additional logic
is needed.

## Glossary

- **Bug_Condition (C)**: A delete webhook event where `fetchById` returns `null` AND
  `config.sourceType` holds the raw URL source param instead of the resolved collection name.
- **Property (P)**: For any input satisfying C, the fixed code SHALL construct
  `documents/<collection>/<slug>.json` and use that path for both the S3 delete and Bedrock
  KB delete operations.
- **Preservation**: All behaviors unrelated to the fallback path key construction (create/update
  upsert flow, explicit-`documentPath` delete flow, auth, dedup, full sync) MUST remain
  unchanged after the fix.
- **`processWebhookEvent`**: The function in `handler.ts` that wires together the adapter,
  S3 client, Bedrock client, and `WebhookEventRouter`, and is the single site where
  `EventRouterConfig.sourceType` is set.
- **`handleDelete`**: The private method in `WebhookEventRouter` (`event-router.ts`) that
  executes the S3 delete and Bedrock KB delete. It reads `this.config.sourceType` as the
  collection folder name when deriving the fallback document path.
- **`collection`**: The resolved Strapi collection name (e.g. `"intranet-pages"`) derived in
  `processWebhookEvent` from `payload.collection` (set by `normalizeStrapiPayload`) or the
  `source` URL param if it matches `STRAPI_COLLECTIONS`.
- **`source`**: The raw URL path parameter from `POST /webhook/{source}`, e.g. `"strapi"`.
  This is NOT a valid collection folder name and MUST NOT be used as `sourceType`.

## Bug Details

### Bug Condition

The bug manifests on every Strapi delete webhook where the record is no longer fetchable —
which is the normal case for `entry.delete` and `entry.unpublish` events, since Strapi
removes the entry before firing the webhook. The `handleDelete` fallback path reads
`this.config.sourceType` as the collection folder, but `processWebhookEvent` populates that
field with `source` (the URL param) instead of `collection` (the resolved collection name).

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input of type { source: string, payload: WebhookPayload }
  OUTPUT: boolean

  IF input.payload.event != "delete"
    RETURN false
  END IF

  // Record is gone from Strapi (normal for delete/unpublish)
  recordExists := adapter.fetchById(input.payload.recordId) != null

  // payload.data contains a slug/title/name for path derivation
  hasDerivedPath := input.payload.data != null
                    AND (input.payload.data.slug != null
                         OR input.payload.data.title != null
                         OR input.payload.data.name != null)

  // The bug: sourceType is the raw URL param, not the collection
  sourceTypeIsRawParam := eventRouterConfig.sourceType == input.source
                          AND input.source NOT IN STRAPI_COLLECTIONS

  RETURN NOT recordExists
         AND hasDerivedPath
         AND sourceTypeIsRawParam
END FUNCTION
```

### Examples

- **Bug manifests**: `POST /webhook/strapi` receives `{ "event": "entry.delete", "uid":
"api::intranet-page.intranet-page", "entry": { "id": 77, "slug": "about-us" } }`.
  `fetchById("77")` returns `null`. Fallback uses `sourceType = "strapi"` → key becomes
  `documents/strapi/about-us.json`. Actual document lives at
  `documents/intranet-pages/about-us.json`. S3 delete silently succeeds on wrong key;
  KB delete also targets wrong URI. Content remains indexed.

- **Bug manifests**: `POST /webhook/strapi` receives an unpublish event for a team member
  with `name = "Jane Smith"`. Same path: `documents/strapi/jane-smith.json` targeted
  instead of `documents/intranet-teams/jane-smith.json`.

- **Bug does NOT manifest** (adapter path): `POST /webhook/intranet-pages` with record
  still briefly fetchable — `fetchById` returns the record with `documentPath` in metadata,
  so the fallback is never reached.

- **Bug does NOT manifest** (correct source): `POST /webhook/intranet-pages` — `source =
"intranet-pages"` is in `STRAPI_COLLECTIONS`, so `collection` resolves to `"intranet-pages"`.
  But today `sourceType` is still set to `source`, which happens to equal the collection, so
  the key is accidentally correct. The fix makes this explicit rather than coincidental.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Create and update webhook events: `handleUpsert` fetches via adapter, writes to S3 at the
  correct key, and triggers targeted Bedrock KB ingestion — unaffected by this fix.
- Delete with explicit `documentPath`: when `fetchById` returns a record whose metadata
  contains `documentPath`, `handleDelete` uses that path directly — the fallback code is not
  reached; this behavior is unchanged.
- Auth validation: invalid or missing `x-webhook-secret` continues to return 401.
- Dedup: duplicate `x-webhook-id` values continue to return `200 / "duplicate"` without
  reprocessing.
- Full sync: `handleFullSync` passes `sourceType: collection` already (uses the loop variable)
  — it is not changed by this fix.
- Bedrock KB delete error handling: if `deleteDocuments` throws after S3 deletion has
  committed, the error is logged and not rolled back (Requirement 3.7).

**Scope:**

All inputs that do NOT satisfy `isBugCondition` (create, update, delete-with-adapter-path,
auth failures, dedup hits) MUST be completely unaffected. Only the one-liner
`sourceType: source` → `sourceType: collection` changes.

## Hypothesized Root Cause

The root cause is a single incorrect field assignment at the call site in `processWebhookEvent`:

```typescript
// BEFORE (buggy) — line ~390 in handler.ts
const router = new WebhookEventRouter(adapter, s3Client, bedrockClient, {
  clientId,
  sourceType: source, // <-- raw URL param, not the collection
  bucketName,
});
```

`collection` is already correctly resolved two lines earlier:

```typescript
const collection =
  payload.collection ??
  (STRAPI_COLLECTIONS.includes(source) ? source : "articles");
```

The variable was introduced to select the right adapter, but was never threaded through to
`EventRouterConfig`. This is the entire bug. No logic in `WebhookEventRouter` or anywhere
else needs to change.

Secondary factors that made the bug hard to notice:

1. **Silent S3 success**: `DeleteObject` returns 204 for non-existent keys, so there is no
   error signal.
2. **Silent KB success**: `DeleteKnowledgeBaseDocuments` also does not throw when the URI
   doesn't exist.
3. **Coincidental correctness for collection-named routes**: when `source` equals the
   collection (e.g. `POST /webhook/intranet-pages`), `source` and `collection` are the same
   value, masking the bug.

## Correctness Properties

Property 1: Bug Condition - Delete Uses Resolved Collection Name

_For any_ delete webhook event where `fetchById` returns `null` and `payload.data` contains
a slug, title, or name (i.e. `isBugCondition` returns true), the fixed `handleDelete` SHALL
construct the document key as `documents/<resolvedCollection>/<slug>.json` — where
`<resolvedCollection>` equals `payload.collection ?? (source IN STRAPI_COLLECTIONS ? source :
"articles")` — and use that key for both the S3 `DeleteObject` call and the Bedrock KB
`deleteDocuments` URI.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation - Non-Buggy Event Paths Are Unaffected

_For any_ input where `isBugCondition` returns false (create/update events, delete events
where the adapter returns a record with `documentPath`, auth failures, duplicate events), the
fixed code SHALL produce exactly the same observable behaviour as the original code —
identical S3 keys written or deleted, identical Bedrock KB URIs targeted, identical HTTP
response codes and bodies.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

## Fix Implementation

### Changes Required

**File**: `infra/lambda/ingestion/handler.ts`

**Function**: `processWebhookEvent`

**Specific Change** (one line):

```typescript
// BEFORE
const router = new WebhookEventRouter(adapter, s3Client, bedrockClient, {
  clientId,
  sourceType: source, // raw URL param — WRONG
  bucketName,
});

// AFTER
const router = new WebhookEventRouter(adapter, s3Client, bedrockClient, {
  clientId,
  sourceType: collection, // resolved collection name — CORRECT
  bucketName,
});
```

`collection` is already in scope and already used to create the adapter. No other files need
to change. The `WebhookEventRouter` and `handleDelete` logic are correct as written — they
just need to receive the right value.

**No other changes are needed.** The fix is a single token replacement: `source` → `collection`.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach:

1. **Exploratory (pre-fix)**: Run tests against the current unfixed code to surface the bug
   and confirm the root cause.
2. **Fix + Preservation checking (post-fix)**: Verify the fix resolves Property 1 and that
   all non-bug paths still satisfy Property 2.

### Exploratory Bug Condition Checking

**Goal**: Surface a counterexample demonstrating the bug on unfixed code. Confirm that
`handleDelete` is called with `config.sourceType = "strapi"` and produces
`documents/strapi/<slug>.json` as the S3 key.

**Test Plan**: Construct a `WebhookEventRouter` with `config.sourceType = "strapi"` (the
current buggy value), call `router.route(deletePayload)` with a delete payload whose
`fetchById` returns `null` and whose `data` contains a slug. Assert that `s3Client.deleteDocument`
was called with `documentPath = "documents/intranet-pages/about-us.json"`. On unfixed code
this assertion FAILS (actual call uses `"documents/strapi/about-us.json"`), confirming the bug.

**Test Cases**:

1. **Wrong collection in S3 key**: Router with `sourceType = "strapi"`, delete payload for
   slug `"about-us"`, adapter returns `null`. Assert `deleteDocument` called with
   `documents/intranet-pages/about-us.json`. Will FAIL on unfixed code (gets
   `documents/strapi/about-us.json`).

2. **Wrong URI to Bedrock KB**: Same setup. Assert `bedrockClient.deleteDocuments` called
   with `s3://bucket/documents/intranet-pages/about-us.json`. Will FAIL on unfixed code.

3. **Title-based slug derivation**: Delete payload with `data.title = "About Us"` (no slug),
   `sourceType = "strapi"`. Assert key is `documents/intranet-pages/about-us.json`. Will FAIL
   on unfixed code.

4. **Name-based slug derivation**: Delete payload with `data.name = "Engineering Team"`,
   `sourceType = "strapi"`. Assert key is `documents/intranet-teams/engineering-team.json`.
   Will FAIL on unfixed code.

**Expected Counterexamples**:

- `deleteDocument` is called with `"documents/strapi/<slug>.json"` instead of
  `"documents/<collection>/<slug>.json"`.
- `deleteDocuments` is called with `"s3://<bucket>/documents/strapi/<slug>.json"` instead of
  the correct URI.

### Fix Checking

**Goal**: Verify that for all inputs where `isBugCondition` holds, the fixed router produces
the correct S3 key and Bedrock URI.

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  router = new WebhookEventRouter(adapter, s3, bedrock, {
    sourceType: collection  // fixed value
  })
  result := router.route(input.payload)
  ASSERT s3.deleteDocument.calledWith(
    payload.recordId,
    `documents/${collection}/${slug}.json`
  )
  ASSERT bedrock.deleteDocuments.calledWith([
    `s3://${bucket}/documents/${collection}/${slug}.json`
  ])
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where `isBugCondition` does NOT hold, the fixed code
behaves identically to the original.

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  original_result := unfixedRouter.route(input.payload)
  fixed_result    := fixedRouter.route(input.payload)
  ASSERT deepEqual(s3_calls(original_result), s3_calls(fixed_result))
  ASSERT deepEqual(bedrock_calls(original_result), bedrock_calls(fixed_result))
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:

- It generates many combinations of event types, collection names, record IDs, and data
  shapes automatically.
- It catches edge cases like empty slug fields, missing `data`, or records that ARE returned
  by the adapter.
- It provides strong guarantees that the one-line change has no side effects.

**Test Cases**:

1. **Create event preservation**: Property test generating random create payloads. Fixed
   router's `s3.putDocument` call matches unfixed router's call for every generated input.

2. **Update event preservation**: Same as above for update payloads.

3. **Delete with adapter-provided `documentPath`**: When `fetchById` returns a record with
   `metadata.documentPath`, the fixed router uses that path — identical to unfixed behaviour.

4. **Explicit-documentPath takes precedence**: Property test varying `documentPath` values;
   the fallback construction code is never reached, so `sourceType` value is irrelevant.

5. **Auth / dedup paths**: 401 and duplicate-200 responses are not affected — confirmed by
   integration tests.

### Unit Tests

- `handleDelete` with `sourceType = collection` routes S3 delete to
  `documents/<collection>/<slug>.json` (slug from `data.slug`).
- `handleDelete` derives slug from `data.title` via `toSlug` when `data.slug` is absent.
- `handleDelete` derives slug from `data.name` when both `slug` and `title` are absent.
- `handleDelete` falls back to `documents/<recordId>.json` when `payload.data` is absent.
- `handleDelete` uses adapter-provided `documentPath` when `fetchById` returns a record —
  `sourceType` is irrelevant in this path.
- `processWebhookEvent` (integration-level unit test): `sourceType` passed to router equals
  `payload.collection` when present, and equals the `source` path param when it is a known
  collection.

### Property-Based Tests

- Generate random `(source, payload.collection, payload.data)` triples for delete events
  where `fetchById` returns `null`. Verify the S3 key prefix equals the resolved collection,
  never `source` when `source` is not a collection name.
- Generate random create/update payloads and verify `putDocument` key is always derived from
  `documentPath` in adapter metadata, not from `sourceType`.
- Generate random non-bug-condition inputs and verify fixed router produces identical S3 and
  Bedrock call sequences as the unfixed router.

### Integration Tests

- End-to-end delete flow: simulate a Strapi `entry.delete` HTTP request to the Lambda handler
  with `source = "strapi"`, verify S3 and KB operations target `documents/intranet-pages/<slug>.json`.
- Confirm dedup table entry is recorded after a successful delete.
- Confirm no regression on a create webhook: document is written at the correct key and KB
  ingestion is triggered.
