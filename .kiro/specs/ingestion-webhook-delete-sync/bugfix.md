# Bugfix Requirements Document

## Introduction

When a webhook event signals content deletion (e.g. `entry.delete` or `entry.unpublish` from Strapi), the ingestion pipeline fails to remove the corresponding document from S3 and the Bedrock Knowledge Base. As a result, deleted content remains indexed and can still be surfaced in chatbot responses — a data-integrity and compliance problem.

The root cause is in the `handleDelete` path of the `WebhookEventRouter`. When a native Strapi delete webhook arrives:

1. `fetchById` returns `null` (the record is already gone from Strapi), so the adapter lookup path is skipped.
2. The fallback tries to derive the S3 document path from `payload.data` using `this.config.sourceType` as the collection folder name.
3. `config.sourceType` is set to the raw URL path parameter (`source`, e.g. `"strapi"`) rather than the resolved collection name (e.g. `"intranet-pages"`), so the constructed key is `documents/strapi/<slug>.json` instead of `documents/intranet-pages/<slug>.json`.
4. The S3 `DeleteObject` call targets the wrong key, silently succeeds (S3 returns 204 on a non-existent key), and the actual document is never deleted.
5. Because the S3 file is not deleted, the Bedrock KB `DeleteKnowledgeBaseDocuments` call also targets the wrong URI, leaving the indexed content intact.

Additionally, for Strapi native payloads the normalized `collection` field (derived from the Strapi `uid`) is available on `payload.collection`, but `processWebhookEvent` passes `sourceType: source` (the URL param) instead of the resolved collection to the `EventRouterConfig`, so the router's fallback path always uses the wrong value.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a Strapi delete webhook event is received and the record is no longer fetchable via the adapter THEN the system constructs the S3 document key using the URL path parameter (e.g. `"strapi"`) as the collection folder, producing an incorrect key such as `documents/strapi/<slug>.json`

1.2 WHEN the S3 delete is issued against the incorrectly derived key THEN the system issues a `DeleteObject` call that silently succeeds on a non-existent object, leaving the actual document at `documents/<collection>/<slug>.json` untouched

1.3 WHEN the Bedrock KB delete is issued with the incorrect S3 URI (derived from the wrong key) THEN the system does not remove the indexed content from the Knowledge Base, so the deleted content remains retrievable by the chatbot

1.4 WHEN `processWebhookEvent` builds the `EventRouterConfig` THEN the system sets `sourceType` to the raw URL `source` path parameter instead of the resolved collection name, so the `WebhookEventRouter` cannot correctly derive the S3 path for any collection whose URL path param differs from its storage collection name (e.g. `source = "strapi"` vs. collection `= "intranet-pages"`)

### Expected Behavior (Correct)

2.1 WHEN a Strapi delete webhook event is received and the record is no longer fetchable via the adapter THEN the system SHALL derive the S3 document key using the resolved collection name (e.g. `"intranet-pages"`) as the collection folder, producing the correct key `documents/<collection>/<slug>.json`

2.2 WHEN the S3 delete is issued against the correctly derived key THEN the system SHALL remove the document from S3, so the object no longer exists at `documents/<collection>/<slug>.json`

2.3 WHEN the Bedrock KB delete is issued with the correct S3 URI THEN the system SHALL remove the indexed content from the Knowledge Base, so the deleted content is no longer retrievable by the chatbot

2.4 WHEN `processWebhookEvent` builds the `EventRouterConfig` THEN the system SHALL set `sourceType` to the resolved collection name (preferring `payload.collection` when present, then falling back to `source` if it matches a known collection) so the `WebhookEventRouter` always uses the correct collection folder when constructing S3 keys

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a webhook create or update event is received THEN the system SHALL CONTINUE TO fetch the record via the adapter, persist the document to S3, and trigger a targeted Bedrock KB ingestion for the correct S3 URI

3.2 WHEN a webhook delete event is received and `fetchById` returns a record with a `documentPath` in its metadata THEN the system SHALL CONTINUE TO use that explicit `documentPath` for both the S3 delete and KB delete operations

3.3 WHEN a webhook event is received with an invalid or missing secret THEN the system SHALL CONTINUE TO return 401 and not process the event

3.4 WHEN a duplicate webhook event ID is received THEN the system SHALL CONTINUE TO return 200 with `"status": "duplicate"` and skip reprocessing

3.5 WHEN a webhook create or update event is successfully processed THEN the system SHALL CONTINUE TO record the event ID in the dedup table and return 200 with `"status": "accepted"`

3.6 WHEN a webhook delete event is successfully processed (S3 document removed) THEN the system SHALL CONTINUE TO record the event ID in the dedup table and return 200 with `"status": "accepted"`

3.7 WHEN the Bedrock KB delete call fails after the S3 document has already been deleted THEN the system SHALL CONTINUE TO log the error without rolling back the S3 deletion, and allow the next full sync to reconcile the KB

3.8 WHEN a full sync is triggered THEN the system SHALL CONTINUE TO sync all configured Strapi collections sequentially without being affected by the webhook delete path fix
