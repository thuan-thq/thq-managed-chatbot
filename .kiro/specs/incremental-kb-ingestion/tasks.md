# Implementation Plan: Incremental KB Document Ingestion

## Overview

Replace the full data source scan (`StartIngestionJob`) in the webhook event path with targeted document-level ingestion and deletion using `IngestKnowledgeBaseDocuments` and `DeleteKnowledgeBaseDocuments` APIs. The implementation extends `BedrockSyncClient` with two new methods, updates `WebhookEventRouter` to call them, adds a `buildS3Uri` utility, updates IAM permissions in the CDK construct, and adds comprehensive tests.

## Tasks

- [x] 1. Extend BedrockSyncClient with targeted ingestion and deletion methods
  - [x] 1.1 Add result type interfaces and `buildS3Uri` utility function
    - Add `IngestDocumentResult` and `DeleteDocumentResult` interfaces to `infra/lambda/ingestion/bedrock-client.ts`
    - Create a `buildS3Uri(bucketName: string, documentKey: string): string` function that constructs `s3://{bucketName}/{documentKey}`, strips leading slashes from documentKey, validates non-empty inputs, and ensures no double slashes
    - Export the new types and utility from the module
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 1.2 Implement `ingestDocuments` method on BedrockSyncClient
    - Import `IngestKnowledgeBaseDocumentsCommand` from `@aws-sdk/client-bedrock-agent`
    - Add input validation: throw if `s3Uris` is null/undefined, empty, or exceeds 10 items
    - Build the SDK command with configured `knowledgeBaseId`, `dataSourceId`, and one document source object per URI with `dataSourceType: "S3"`
    - Map API response `documentStatusList` to `IngestDocumentResult[]`, synthesizing FAILED results for any missing entries
    - Log errors at ERROR level (structured JSON) and re-throw; log individual FAILED statuses at WARN level
    - _Requirements: 1.2, 1.3, 1.4, 4.1, 4.3, 4.4, 5.1, 5.3, 6.1, 6.3_

  - [x] 1.3 Implement `deleteDocuments` method on BedrockSyncClient
    - Import `DeleteKnowledgeBaseDocumentsCommand` from `@aws-sdk/client-bedrock-agent`
    - Add input validation: throw if `s3Uris` is null/undefined, empty, or exceeds 10 items
    - Build the SDK command with configured `knowledgeBaseId`, `dataSourceId`, and one `documentIdentifier` per URI with `dataSourceType: "S3"`
    - Map API response to `DeleteDocumentResult[]`, synthesizing FAILED results for any missing entries
    - Log errors at ERROR level (structured JSON) and re-throw
    - _Requirements: 2.2, 2.3, 4.2, 4.3, 4.4, 5.2, 5.3, 6.2_

  - [ ]\* 1.4 Write unit tests for `buildS3Uri`
    - Test valid bucket name and key produce correct URI format
    - Test leading slash on documentKey is stripped
    - Test empty/null/undefined inputs throw validation errors
    - Test no double slash or trailing slash in output
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]\* 1.5 Write property tests for `buildS3Uri` (install fast-check)
    - Add `fast-check` as a dev dependency in `infra/package.json`
    - **Property 1: S3 URI round-trip construction** - For any valid bucket name and document key, constructing an S3 URI and parsing it back recovers the original values
    - **Validates: Requirements 3.1, 3.3**
    - **Property 2: S3 URI format invariant** - For any non-empty bucket name and non-empty document key, the URI starts with `s3://` and contains no double slashes or trailing slashes beyond the protocol prefix
    - **Validates: Requirements 3.2**

  - [ ]\* 1.6 Write unit tests for `ingestDocuments` and `deleteDocuments`
    - Mock `BedrockAgentClient.send()` to verify correct command construction
    - Test validation rejects empty, null, and > 10 item arrays
    - Test successful response mapping to result arrays
    - Test result count matches input count when API response has fewer entries
    - Test error logging and re-throw behavior
    - Test individual FAILED status logs warning but does not throw
    - _Requirements: 1.2, 1.3, 1.4, 2.2, 2.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3_

  - [ ]\* 1.7 Write property tests for `ingestDocuments` and `deleteDocuments`
    - **Property 3: Result count preservation** - For any valid array of S3 URIs (length 1-10), both methods return a result array with the same length as the input, with each result containing the corresponding input URI
    - **Validates: Requirements 1.3, 2.3, 5.1, 5.2**
    - **Property 4: Batch size validation** - For any array of S3 URIs with length > 10 or length 0, both methods throw a validation error without making an API call
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - **Property 5: Correct API payload construction** - For any valid array of S3 URIs (length 1-10), the SDK command is constructed with the configured knowledgeBaseId, dataSourceId, and one document source object per URI with dataSourceType "S3"
    - **Validates: Requirements 1.2, 2.2**

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Update WebhookEventRouter to use targeted APIs
  - [x] 3.1 Modify `handleUpsert` to call `ingestDocuments` instead of `startIngestionJob`
    - After `s3Client.putDocument(document)`, construct the S3 URI using `buildS3Uri(bucketName, documentKey)` where `bucketName` comes from `DATA_BUCKET_NAME` env var and `documentKey` is the resolved document path
    - Replace `this.bedrockClient.startIngestionJob()` with `this.bedrockClient.ingestDocuments([s3Uri])`
    - Add the bucket name to `EventRouterConfig` interface
    - Ensure S3 persistence happens before the `ingestDocuments` call (for error recovery)
    - Log the ingestion result status
    - _Requirements: 1.1, 6.4, 6.5_

  - [x] 3.2 Modify `handleDelete` to call `deleteDocuments` instead of `startIngestionJob`
    - Resolve the document S3 URI: attempt `fetchById` for the path, fall back to `documents/{recordId}.json`
    - Construct the full S3 URI using `buildS3Uri(bucketName, documentKey)`
    - Ensure S3 deletion happens before calling `deleteDocuments` (requirement 2.4)
    - Replace `this.bedrockClient.startIngestionJob()` with `this.bedrockClient.deleteDocuments([s3Uri])`
    - If `deleteDocuments` throws, do NOT roll back the S3 deletion (document already removed; next full sync reconciles)
    - Log the deletion result status
    - _Requirements: 2.1, 2.4, 6.4, 6.5_

  - [ ]\* 3.3 Write unit tests for updated WebhookEventRouter
    - Test `handleUpsert` calls `ingestDocuments` with correct S3 URI (not `startIngestionJob`)
    - Test `handleDelete` calls `deleteDocuments` with correct S3 URI (not `startIngestionJob`)
    - Test S3 URI is correctly constructed from bucket name and document path
    - Test S3 persist/delete happens before Bedrock API calls
    - Test that when `ingestDocuments` throws, S3 document is NOT deleted/modified
    - Test delete fallback path resolution when `fetchById` returns null
    - _Requirements: 1.1, 2.1, 2.4, 6.4, 6.5_

- [x] 4. Verify FullSyncPipeline remains unchanged
  - [x] 4.1 Add assertion test for FullSyncPipeline
    - Write a test that verifies `FullSyncPipeline.execute()` calls `startIngestionJob` and does NOT call `ingestDocuments` or `deleteDocuments`
    - _Requirements: 7.1, 7.2_

- [x] 5. Update CDK construct with new IAM permissions
  - [x] 5.1 Add Bedrock targeted ingestion and deletion IAM permissions
    - In `infra/lib/constructs/ingestion-lambda.ts`, update the existing `BedrockKBIngestion` policy statement to include `bedrock:IngestKnowledgeBaseDocuments` and `bedrock:DeleteKnowledgeBaseDocuments` alongside the existing `bedrock:StartIngestionJob`
    - Ensure all three actions are scoped to `props.knowledgeBaseArn` (no wildcard resources)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]\* 5.2 Write CDK assertion tests for IAM permissions
    - Use CDK assertion (`Template.fromStack`) to verify the IAM policy includes all three Bedrock actions
    - Verify no wildcard resource is used in the Bedrock policy statement
    - Verify the resource is scoped to the Knowledge Base ARN
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using fast-check
- Unit tests validate specific examples and edge cases using Jest
- The `FullSyncPipeline` is intentionally left untouched - only a verification test is added
- `fast-check` needs to be installed as a dev dependency before property tests can run

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "1.5", "1.6", "1.7"] },
    { "id": 3, "tasks": ["3.1", "3.2", "5.1"] },
    { "id": 4, "tasks": ["3.3", "4.1", "5.2"] }
  ]
}
```
