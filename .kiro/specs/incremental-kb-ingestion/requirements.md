# Requirements Document

## Introduction

This feature replaces the full data source scan (StartIngestionJob) in the webhook event path with targeted document-level ingestion and deletion APIs. When a single document is created, updated, or deleted via a webhook, the system uses IngestKnowledgeBaseDocuments or DeleteKnowledgeBaseDocuments to index only that specific document, avoiding a full S3 scan. The FullSyncPipeline continues to use StartIngestionJob for bulk operations.

## Glossary

- **BedrockSyncClient**: Service wrapper that provides methods for interacting with Bedrock Knowledge Base ingestion APIs, including full scan and targeted document operations.
- **WebhookEventRouter**: Component that routes incoming webhook events (create, update, delete) to the appropriate handler for processing.
- **FullSyncPipeline**: Existing pipeline that performs bulk document synchronization using StartIngestionJob to scan all S3 documents.
- **S3_URI**: A resource identifier in the format `s3://{bucketName}/{documentKey}` pointing to a document in an S3 bucket.
- **IngestDocumentResult**: Response object containing the URI, status, and optional status reason for a targeted document ingestion operation.
- **DeleteDocumentResult**: Response object containing the URI, status, and optional status reason for a targeted document deletion operation.
- **Knowledge_Base**: The Amazon Bedrock Knowledge Base that stores vector embeddings of ingested documents for retrieval.
- **Data_Source**: The S3 data source configured within the Knowledge Base that maps to the content bucket.

## Requirements

### Requirement 1: Targeted Document Ingestion

**User Story:** As a system operator, I want webhook-triggered document creates and updates to index only the affected document, so that ingestion is fast and does not re-scan the entire data source.

#### Acceptance Criteria

1. WHEN a webhook create or update event is received and the document has been persisted to S3, THE WebhookEventRouter SHALL call BedrockSyncClient.ingestDocuments with a single-element array containing the S3 URI of the persisted document (formatted as s3://{bucketName}/{documentKey}) instead of calling startIngestionJob
2. WHEN BedrockSyncClient.ingestDocuments is called with an array of 1 to 10 S3 URIs, THE BedrockSyncClient SHALL invoke the IngestKnowledgeBaseDocuments API with the configured knowledgeBaseId, configured dataSourceId, and one document source object per URI with dataSourceType S3 and the corresponding URI
3. WHEN BedrockSyncClient.ingestDocuments completes successfully, THE BedrockSyncClient SHALL return an array of IngestDocumentResult objects equal in length to the input array, where each result contains the original URI and a status value of INDEXED, PARTIALLY_INDEXED, PENDING, FAILED, METADATA_PARTIALLY_INDEXED, or IGNORED
4. IF BedrockSyncClient.ingestDocuments is called with an empty array or an array exceeding 10 URIs, THEN THE BedrockSyncClient SHALL throw a validation error without invoking the Bedrock API
5. IF the IngestKnowledgeBaseDocuments API call fails with a service or network error, THEN THE BedrockSyncClient SHALL propagate the error to the caller

### Requirement 2: Targeted Document Deletion

**User Story:** As a system operator, I want webhook-triggered document deletions to remove only the affected document from the Knowledge Base index, so that stale entries are cleaned up without a full re-scan.

#### Acceptance Criteria

1. WHEN a webhook delete event is received, THE WebhookEventRouter SHALL resolve the document S3 URI by attempting fetchById for the recordId and falling back to the path `documents/{recordId}.json` if the record is not found, then call BedrockSyncClient.deleteDocuments with the constructed S3 URI instead of triggering a full ingestion job
2. WHEN BedrockSyncClient.deleteDocuments is called with an array of S3 URIs, THE BedrockSyncClient SHALL invoke the DeleteKnowledgeBaseDocuments API with the configured knowledgeBaseId, dataSourceId, and one document identifier per URI where each identifier has dataSourceType "S3" and the corresponding S3 URI
3. WHEN the DeleteKnowledgeBaseDocuments API returns without throwing an exception, THE BedrockSyncClient SHALL return one DeleteDocumentResult per input URI containing the original URI and a status of either DELETED or FAILED with an optional statusReason
4. WHEN the WebhookEventRouter handles a delete event, THE WebhookEventRouter SHALL delete the document from S3 via S3ContentClient before invoking BedrockSyncClient.deleteDocuments

### Requirement 3: S3 URI Construction

**User Story:** As a developer, I want S3 URIs to be constructed consistently from bucket name and document key, so that document references are correct and predictable across the system.

#### Acceptance Criteria

1. WHEN constructing an S3 URI, THE buildS3Uri function SHALL produce a string in the format `s3://{bucketName}/{documentKey}` by concatenating the scheme `s3://`, the configured bucket name from the DATA_BUCKET_NAME environment variable, a single forward slash, and the document key provided by the S3ContentClient
2. THE buildS3Uri function SHALL produce S3 URIs that contain exactly one slash between bucket name and document key, with no trailing slash after the document key, even if the provided documentKey begins or ends with a slash
3. WHEN a valid S3 URI produced by buildS3Uri is parsed by splitting on the first slash after `s3://`, THE system SHALL recover the original bucket name as the substring before that slash and the original document key as the remaining substring after that slash
4. IF bucketName or documentKey is empty, null, or undefined, THEN THE buildS3Uri function SHALL throw a validation error indicating which parameter is invalid
5. IF documentKey contains a leading slash, THEN THE buildS3Uri function SHALL strip the leading slash before constructing the URI to prevent a double slash between bucket name and document key

### Requirement 4: Input Validation

**User Story:** As a developer, I want input validation on the targeted APIs, so that invalid requests are rejected early before reaching the AWS API.

#### Acceptance Criteria

1. IF the s3Uris array passed to ingestDocuments contains more than 10 items, THEN THE BedrockSyncClient SHALL throw a validation error indicating the array exceeds the maximum allowed size of 10, without calling the Bedrock API
2. IF the s3Uris array passed to deleteDocuments contains more than 10 items, THEN THE BedrockSyncClient SHALL throw a validation error indicating the array exceeds the maximum allowed size of 10, without calling the Bedrock API
3. IF the s3Uris array passed to ingestDocuments or deleteDocuments is empty, THEN THE BedrockSyncClient SHALL throw a validation error indicating the array must contain at least 1 item, without calling the Bedrock API
4. IF the s3Uris argument passed to ingestDocuments or deleteDocuments is null or undefined, THEN THE BedrockSyncClient SHALL throw a validation error indicating the argument is required, without calling the Bedrock API

### Requirement 5: Result Count Preservation

**User Story:** As a developer, I want the result array to always match the input array in length, so that I can correlate each result to its corresponding input document.

#### Acceptance Criteria

1. WHEN BedrockSyncClient.ingestDocuments is called with N valid S3 URIs (where 1 <= N <= 10), THE BedrockSyncClient SHALL return exactly N IngestDocumentResult objects in the same order as the input URIs, where each result at index i contains the URI from input index i
2. WHEN BedrockSyncClient.deleteDocuments is called with N valid S3 URIs (where 1 <= N <= 10), THE BedrockSyncClient SHALL return exactly N DeleteDocumentResult objects in the same order as the input URIs, where each result at index i contains the URI from input index i
3. IF the Bedrock API response contains fewer document status entries than the number of input S3 URIs, THEN THE BedrockSyncClient SHALL synthesize a result for each missing URI with a status of "FAILED" and a statusReason indicating the document was absent from the API response

### Requirement 6: Error Handling and Recovery

**User Story:** As a system operator, I want clear error handling for ingestion failures, so that transient issues do not silently lose data and can be recovered by subsequent full syncs.

#### Acceptance Criteria

1. IF the IngestKnowledgeBaseDocuments API call throws an error, THEN THE BedrockSyncClient SHALL log a structured JSON entry at ERROR level containing the knowledgeBaseId, dataSourceId, the array of S3 URIs submitted, and the error message, and then re-throw the original exception to the caller
2. IF the DeleteKnowledgeBaseDocuments API call throws an error, THEN THE BedrockSyncClient SHALL log a structured JSON entry at ERROR level containing the knowledgeBaseId, dataSourceId, the array of S3 URIs submitted, and the error message, and then re-throw the original exception to the caller
3. IF the IngestKnowledgeBaseDocuments API returns a FAILED status for an individual document, THEN THE BedrockSyncClient SHALL log a structured JSON entry at WARN level containing the document URI and statusReason, and SHALL still return the result without throwing an exception
4. WHEN a targeted ingestDocuments or deleteDocuments call fails with a re-thrown exception, THE WebhookEventRouter SHALL NOT delete or modify the document in S3, so that the next FullSyncPipeline run reconciles the document into the Knowledge Base via StartIngestionJob
5. THE WebhookEventRouter SHALL persist the document to S3 before calling IngestKnowledgeBaseDocuments or DeleteKnowledgeBaseDocuments, so that the document state is persisted regardless of API call outcome

### Requirement 7: Full Sync Pipeline Unchanged

**User Story:** As a system operator, I want the full sync pipeline to continue using StartIngestionJob, so that bulk operations still benefit from a complete data source scan.

#### Acceptance Criteria

1. WHEN the FullSyncPipeline is triggered, THE FullSyncPipeline SHALL call BedrockSyncClient.startIngestionJob to initiate a full data source scan after all records have been persisted to S3
2. THE FullSyncPipeline SHALL NOT call BedrockSyncClient.ingestDocuments or BedrockSyncClient.deleteDocuments at any point during its execution

### Requirement 8: IAM Permissions

**User Story:** As a cloud engineer, I want the Lambda execution role to have the necessary Bedrock permissions, so that the targeted ingestion and deletion APIs can be called successfully.

#### Acceptance Criteria

1. THE CDK construct SHALL grant the ingestion Lambda execution role the `bedrock:IngestKnowledgeBaseDocuments` IAM permission with the resource field set to the Knowledge Base ARN (`arn:aws:bedrock:{region}:{account}:knowledge-base/{kb-id}`)
2. THE CDK construct SHALL grant the ingestion Lambda execution role the `bedrock:DeleteKnowledgeBaseDocuments` IAM permission with the resource field set to the Knowledge Base ARN (`arn:aws:bedrock:{region}:{account}:knowledge-base/{kb-id}`)
3. THE CDK construct SHALL retain the existing `bedrock:StartIngestionJob` IAM permission scoped to the Knowledge Base ARN on the ingestion Lambda execution role
4. THE CDK construct SHALL scope all Bedrock IAM permissions exclusively to the specific Knowledge Base ARN and SHALL NOT use wildcard resource values
