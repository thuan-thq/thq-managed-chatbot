# Implementation Plan: AWS Managed Chatbot

## Overview

This plan implements an embeddable RAG chatbot platform with a Next.js chat widget on Vercel and an AWS serverless backend deployed per client via CDK TypeScript. The implementation follows three phases: Phase 1 (Chat Flow), Phase 2 (Content Ingestion), and Phase 3 (Security & Monitoring). Each task builds incrementally, ensuring no orphaned code.

## Tasks

- [x] 1. Phase 1 — Chat Flow: Project Structure and Core Infrastructure
  - [x] 1.1 Initialize CDK project and define base stack structure
    - Create CDK TypeScript project with `cdk init`
    - Define `DeploymentConfig` interface and config loader
    - Create base stack class accepting deployment config
    - Set up shared constructs directory structure
    - _Requirements: 13.1, 13.2_

  - [x] 1.2 Deploy DynamoDB Sessions table with provisioned capacity and auto-scaling
    - Create Sessions table with `PK` (String) and `SK` (String) keys
    - Configure provisioned capacity (1 RCU/1 WCU base, 50 RCU/25 WCU max)
    - Enable auto-scaling policies for read and write
    - Set TTL attribute for automatic session cleanup
    - Apply cost allocation tags
    - _Requirements: 12.2, 13.1, 13.3_

  - [x] 1.3 Deploy S3 data bucket with lifecycle rules and prefix structure
    - Create single S3 bucket per client with prefix-based organisation (documents/, metadata/, sync/progress/)
    - Configure lifecycle rules: IA transition after 30 days, delete after 90 days
    - Apply cost allocation tags
    - _Requirements: 12.3, 13.4, 13.3_

  - [x] 1.4 Deploy HTTP API Gateway with route definitions
    - Create HTTP API Gateway (not REST API)
    - Define route structure for Phase 1 endpoints: `POST /chat`, `POST /session`, `GET /session/{sessionId}`
    - Configure request ID generation
    - Apply cost allocation tags
    - _Requirements: 12.4, 13.1, 13.3_

  - [x] 1.5 Deploy Parameter Store and Secrets Manager resources
    - Create Parameter Store entries for client config (rate limits, session, data source, monitoring)
    - Create Secrets Manager secrets for API keys and data source credentials
    - Apply cost allocation tags
    - _Requirements: 10.1, 13.1, 13.3_

  - [x] 1.6 Deploy Bedrock Managed Knowledge Base with S3 vector store
    - Create Bedrock KB linked to S3 data bucket
    - Configure S3 as the data source for KB
    - Apply cost allocation tags
    - _Requirements: 13.1, 13.3_

  - [x] 1.7 Deploy Chat Lambda (512MB+) with IAM permissions
    - Create Chat Lambda function (Node.js 20.x, 512MB memory)
    - Configure IAM role with access to Bedrock KB, Bedrock Runtime, DynamoDB, Parameter Store, Secrets Manager
    - Wire to API Gateway routes: `POST /chat`, `POST /session`, `GET /session/{sessionId}`
    - Apply cost allocation tags
    - _Requirements: 13.1, 13.5, 13.3_

  - [ ]\* 1.8 Write property test for Configuration Validation (Property 12)
    - **Property 12: Configuration Validation**
    - Test that validation rejects invalid clientId format, missing fields, and out-of-range values while accepting well-formed configs
    - **Validates: Requirements 10.4, 10.5**

- [x] 2. Phase 1 — Chat Flow: Configuration Service and Session Management
  - [x] 2.1 Implement Configuration Service with caching and TTL
    - Create `ConfigurationService` class reading from Parameter Store and Secrets Manager
    - Implement in-memory cache with 5-minute TTL
    - Provide typed access methods: `getConfig()`, `getDataSourceConfig()`, `getSecrets()`
    - Handle cold-start refresh logic
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ]\* 2.2 Write property test for Cache Coherence (Property 11)
    - **Property 11: Cache Coherence**
    - Test that reads within TTL return cached value and reads after TTL return updated store value
    - **Validates: Requirements 10.2, 10.3**

  - [x] 2.3 Implement session creation with cryptographic token generation
    - Create session handler for `POST /session`
    - Generate session tokens with at least 128 bits of cryptographic randomness
    - Persist initial session state to DynamoDB (status: active, turnCount: 0, tokensUsed: 0)
    - Apply configurable duration (default 30 min, range 1–120 min)
    - _Requirements: 3.1, 3.6_

  - [ ]\* 2.4 Write property test for Session Token Entropy (Property 20)
    - **Property 20: Session Token Entropy**
    - Test that all generated tokens have at least 128 bits of randomness and duration is within valid range
    - **Validates: Requirement 3.1**

  - [x] 2.5 Implement session state machine (active → expired/exhausted transitions)
    - Create session validation middleware checking expiry, turn limit, and token budget
    - Implement state transitions: active → expired (duration timeout), active → exhausted (turn/token limit)
    - Enforce terminal states (expired/exhausted reject all requests with 401)
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [ ]\* 2.6 Write property test for Session State Machine (Property 1)
    - **Property 1: Session State Machine Valid Transitions**
    - Test that only valid transitions occur and terminal states are absorbing
    - **Validates: Requirements 3.2, 3.3, 3.5**

  - [ ]\* 2.7 Write property test for Token Budget Enforcement (Property 2)
    - **Property 2: Token Budget Enforcement**
    - Test that cumulative token count is tracked and session transitions to exhausted on exceedance
    - **Validates: Requirement 3.4**

  - [ ]\* 2.8 Write property test for Turn Limit Enforcement (Property 3)
    - **Property 3: Turn Limit Enforcement**
    - Test that turn count never exceeds limit and sessions transition to exhausted
    - **Validates: Requirement 3.5**

- [x] 3. Phase 1 — Chat Flow: Chat Handler and Streaming
  - [x] 3.1 Implement Chat Lambda handler with Bedrock KB retrieval and response streaming
    - Create chat handler for `POST /chat`
    - Validate session state before processing
    - Validate message length (1–2000 characters)
    - Retrieve context from Bedrock KB with metadata filters
    - Apply confidence threshold (default 0.5) for no-answer fallback
    - Generate response using Bedrock Runtime (Claude) constrained to retrieved context
    - Stream tokens via SSE (token, citation, done, error events)
    - Update session state (turnCount, tokensUsed, lastActiveAt) in DynamoDB after each turn
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.4, 3.5, 3.6_

  - [ ]\* 3.2 Write property test for Streaming Correctness (Property 4)
    - **Property 4: Streaming Correctness**
    - Test that SSE event sequences follow valid grammar: (token | citation)\* (done | error)
    - **Validates: Requirements 2.4, 2.5**

  - [ ]\* 3.3 Write property test for Confidence Threshold Fallback (Property 13)
    - **Property 13: Confidence Threshold Fallback**
    - Test that below-threshold results trigger no-answer fallback following standard SSE sequence
    - **Validates: Requirement 2.3**

  - [ ]\* 3.4 Write property test for Message Length Validation (Property 16)
    - **Property 16: Message Length Validation**
    - Test that messages 1–2000 chars are accepted, empty/over-limit messages get 400
    - **Validates: Requirements 2.1, 2.6**

  - [ ]\* 3.5 Write property test for Concurrent Message Rejection (Property 17)
    - **Property 17: Concurrent Message Rejection**
    - Test that new messages during active streaming are rejected with 409
    - **Validates: Requirement 2.7**

- [x] 4. Phase 1 — Chat Flow: Widget and Error Handling
  - [x] 4.1 Implement Chat Widget with Shadow DOM isolation and branding
    - Create Next.js project for the widget
    - Implement Shadow DOM container preventing style leakage in/out
    - Apply branding from build-time env vars (primary colour, logo, title, font)
    - Enforce 44x44px minimum touch targets
    - Support responsive layout (320px–2560px)
    - Implement expand/collapse animation (< 300ms)
    - Handle initialization errors gracefully (no uncaught exceptions, no broken UI)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 4.2 Implement streaming chat UI with Vercel AI SDK (SSE)
    - Integrate Vercel AI SDK for SSE streaming
    - Display tokens as they arrive
    - Render citations with source title and relevance score
    - Handle error events and display error states
    - Implement retry UX on errors
    - _Requirements: 2.1, 2.4, 2.5, 14.1_

  - [x] 4.3 Implement widget error states (rate limit countdown, session exhausted, new session)
    - Display countdown timer when rate limited (429 + Retry-After)
    - Display session exhausted message with New Session button
    - Display read-only conversation history on expired/exhausted sessions
    - Handle 503 errors from Bedrock unavailability
    - _Requirements: 3.7, 14.2, 14.3_

- [x] 5. Checkpoint — Phase 1 Complete
  - Ensure all Phase 1 tests pass, ask the user if questions arise.

- [x] 6. Phase 2 — Content Ingestion: Adapter Pattern and Base Infrastructure
  - [x] 6.1 Define Data Source Adapter interface and Content Record types
    - Create `DataSourceAdapter` interface with `listContent`, `fetchById`, `detectChanges` methods
    - Define `ContentRecord`, `ChangeSet`, `PaginationParams`, `PagedResult` types
    - Create S3 content document format types
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 6.2 Implement adapter HTTP retry logic with exponential backoff
    - Create shared HTTP client wrapper with retry logic (3 retries, 1s base, 10s max backoff)
    - Handle 5xx responses and connection/read timeouts
    - Propagate failure with last error details after retries exhausted
    - _Requirements: 5.3_

  - [ ]\* 6.3 Write property test for Adapter Retry with Exponential Backoff (Property 19)
    - **Property 19: Adapter Retry with Exponential Backoff**
    - Test that 5xx/timeout triggers up to 3 retries with backoff, failure propagated after exhaustion
    - **Validates: Requirement 5.3**

  - [x] 6.4 Implement Strapi CMS adapter
    - Implement `DataSourceAdapter` interface for Strapi
    - Handle Strapi-specific authentication
    - Transform Strapi content entries to `ContentRecord` format
    - Support cursor-based pagination
    - Implement change detection via Strapi's updated_at field
    - Skip invalid records and collect errors
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]\* 6.5 Write property test for Adapter Output Conformance (Property 5)
    - **Property 5: Adapter Output Conformance**
    - Test that all adapter outputs conform to ContentRecord interface with valid fields
    - **Validates: Requirements 5.1, 5.2**

  - [ ]\* 6.6 Write property test for Adapter Graceful Degradation (Property 18)
    - **Property 18: Adapter Graceful Degradation**
    - Test that invalid records are skipped with errors collected, valid records continue processing
    - **Validates: Requirement 5.5**

- [x] 7. Phase 2 — Content Ingestion: Ingestion Lambda and Sync Pipeline
  - [x] 7.1 Deploy Ingestion Lambda with IAM permissions and API Gateway routes
    - Create Ingestion Lambda function (Node.js 20.x)
    - Configure IAM role with access to S3, DynamoDB, Bedrock KB
    - Add API Gateway routes: `POST /webhook/{source}`, `POST /ingest/record`, `DELETE /ingest/record/{recordId}`
    - Apply cost allocation tags
    - _Requirements: 13.1, 13.3_

  - [x] 7.2 Implement full sync pipeline with pagination and progress tracking
    - Create full sync handler processing all records with configurable page size
    - Persist sync progress to DynamoDB (Sync State table) for resume capability
    - Log progress every 100 records
    - Implement resume from last checkpoint on interruption
    - Target completion within 15 minutes
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]\* 7.3 Write property test for Pagination Completeness (Property 6)
    - **Property 6: Pagination Completeness**
    - Test that iterating all pages yields exactly total records with no duplicates/omissions
    - **Validates: Requirements 4.3, 5.4**

  - [ ]\* 7.4 Write property test for Sync Resume from Checkpoint (Property 15)
    - **Property 15: Sync Resume from Checkpoint**
    - Test that interrupted sync resumes from last persisted checkpoint
    - **Validates: Requirements 4.4, 14.4**

  - [x] 7.5 Implement webhook validation and deduplication
    - Validate HMAC signature using configured shared secret
    - Return 401 on signature mismatch with structured security event log
    - Check DynamoDB dedup table before processing; skip duplicates with 200 response
    - Record event ID in dedup table only after successful processing
    - Process webhook events within 60 seconds
    - Return 500 and leave event ID absent from dedup table on failure
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 6.8_

  - [ ]\* 7.6 Write property test for Deduplication Idempotence (Property 7)
    - **Property 7: Deduplication Idempotence**
    - Test that processing same event ID multiple times produces same state as once
    - **Validates: Requirements 6.3, 6.6, 6.7, 6.8**

  - [ ]\* 7.7 Write property test for Webhook Signature Validation (Property 14)
    - **Property 14: Webhook Signature Validation**
    - Test that HMAC mismatch returns 401, logs security event, discards payload
    - **Validates: Requirements 6.1, 6.2**

  - [x] 7.8 Implement webhook event routing (create, update, delete operations)
    - Route validated webhook events to appropriate handler (upsert/delete)
    - For create/update: invoke adapter, persist Content_Record to S3, trigger KB sync
    - For delete: remove Content_Record from S3, trigger KB sync
    - Complete processing within 60 seconds
    - _Requirements: 6.4, 6.5_

  - [x] 7.9 Deploy DynamoDB Webhook Deduplication table
    - Create dedup table with `PK` and `SK` keys
    - Configure 24-hour TTL for automatic cleanup
    - Apply cost allocation tags
    - _Requirements: 6.3, 13.3_

- [x] 8. Phase 2 — Content Ingestion: Admin Lambda and Additional Adapters
  - [x] 8.1 Deploy Admin Lambda (128MB) with IAM permissions and API Gateway routes
    - Create Admin Lambda function (Node.js 20.x, 128MB memory)
    - Configure IAM role with access to DynamoDB, Parameter Store, Secrets Manager
    - Add API Gateway routes: `GET /admin/config`, `PUT /admin/config`, `GET /admin/sync-status`, `POST /admin/sync/trigger`, `GET /admin/analytics`
    - Apply cost allocation tags
    - _Requirements: 13.1, 13.5, 13.3_

  - [x] 8.2 Implement Admin Lambda handlers (config CRUD, sync trigger, analytics)
    - Implement `GET/PUT /admin/config` for runtime configuration management
    - Implement `POST /admin/sync/trigger` returning async operation status with polling URL
    - Implement `GET /admin/sync-status` returning sync state report
    - Implement `GET /admin/analytics` for chat usage analytics
    - Validate configuration updates against schema
    - _Requirements: 10.4, 10.5_

  - [x] 8.3 Implement Monday.com adapter
    - Implement `DataSourceAdapter` interface for Monday.com
    - Handle Monday.com API authentication
    - Transform Monday.com items to `ContentRecord` format
    - Support pagination and change detection
    - Skip invalid records with error collection
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 8.4 Implement Employment Hero adapter
    - Implement `DataSourceAdapter` interface for Employment Hero
    - Handle Employment Hero API authentication
    - Transform Employment Hero records to `ContentRecord` format
    - Support pagination and change detection
    - Skip invalid records with error collection
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 9. Checkpoint — Phase 2 Complete
  - Ensure all Phase 2 tests pass, ask the user if questions arise.

- [ ] 10. Phase 3 — Security & Monitoring: Authentication and CORS
  - [ ] 10.1 Implement API key authentication (widget key vs admin key)
    - Add API key validation middleware reading from cached Secrets Manager values
    - Distinguish between widget keys and admin keys
    - Return 401 for missing/invalid keys with no data payload
    - Return 403 for widget keys on admin endpoints with no data payload
    - Accept admin keys on widget endpoints
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 10.2 Implement session token validation
    - Validate session token on chat requests
    - Return 401 with session_expired for expired, malformed, or non-existent tokens
    - _Requirements: 7.5_

  - [ ]\* 10.3 Write property test for Authentication Enforcement (Property 8)
    - **Property 8: Authentication Enforcement**
    - Test that invalid/missing keys get 401, widget keys on admin get 403, admin keys on widget succeed
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

  - [ ] 10.4 Implement CORS enforcement (configured origins only, no wildcards)
    - Configure allowed origins list (max 10 entries) from client config
    - Include CORS headers only for allowed origins
    - Omit all CORS headers for non-allowed origins
    - Never use wildcard values
    - Handle preflight OPTIONS requests correctly
    - Omit CORS headers when no Origin header present
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]\* 10.5 Write property test for CORS Origin Enforcement (Property 10)
    - **Property 10: CORS Origin Enforcement**
    - Test that non-allowed origins get no CORS headers, allowed origins get correct headers
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**

- [ ] 11. Phase 3 — Security & Monitoring: Rate Limiting and Observability
  - [ ] 11.1 Implement per-session rate limiting
    - Create rate limiter with configurable requests per minute (default 30)
    - Return 429 with valid Retry-After header when limit exceeded
    - Forward requests within limit to appropriate Lambda
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ]\* 11.2 Write property test for Rate Limiting Correctness (Property 9)
    - **Property 9: Rate Limiting Correctness**
    - Test that accepted requests never exceed limit, excess gets 429 with Retry-After
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [ ] 11.3 Configure structured JSON logging for all Lambda functions
    - Implement structured log format with request ID, session ID, latency, error details
    - Ensure all Chat Lambda requests emit structured logs
    - Log ingestion progress every 100 records
    - _Requirements: 11.1, 4.6_

  - [ ] 11.4 Configure X-Ray tracing (5% sampling) and CloudWatch log retention (14 days)
    - Enable X-Ray tracing on API Gateway and all Lambda functions
    - Set sampling rate to 5% for production
    - Set CloudWatch log retention to 14 days for all Lambda log groups
    - _Requirements: 11.2, 11.3_

  - [ ] 11.5 Configure CloudWatch alarms and SNS notifications
    - Create alarm for 5xx error rate > 5% over 5-minute window
    - Create alarm for ingestion failure after all retries
    - Configure SNS topic and email subscription for alarm notifications
    - _Requirements: 11.4, 11.5, 14.1_

- [ ] 12. Phase 3 — Security & Monitoring: Cost Governance and Final Wiring
  - [ ] 12.1 Configure AWS Budget with SNS alerts
    - Create AWS Budget with configured monthly USD threshold
    - Send alerts via SNS when spending approaches or exceeds threshold
    - _Requirements: 12.1_

  - [ ] 12.2 Apply cost allocation tags to all resources
    - Ensure all stack resources have client-specific cost allocation tags
    - Validate tags are applied consistently across all constructs
    - _Requirements: 13.3_

  - [ ] 12.3 Wire all components together and validate CDK synth
    - Ensure all Lambda functions reference correct environment variables and permissions
    - Validate complete stack synthesizes without errors
    - Test deployment config loading and validation end-to-end
    - Verify single deployment config drives entire stack
    - _Requirements: 13.1, 13.2_

  - [ ]\* 12.4 Write integration tests for full stack deployment
    - Test CDK synth produces valid CloudFormation
    - Verify resource counts and configuration match expectations
    - Test deployment config variations
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

- [ ] 13. Final Checkpoint — All Phases Complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between phases
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All code is TypeScript (CDK infrastructure + Lambda handlers + Next.js widget)
- Lambda runtime: Node.js 20.x
- Property test library: fast-check

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6"] },
    { "id": 2, "tasks": ["1.7", "1.8"] },
    { "id": 3, "tasks": ["2.1", "2.3"] },
    { "id": 4, "tasks": ["2.2", "2.4", "2.5"] },
    { "id": 5, "tasks": ["2.6", "2.7", "2.8"] },
    { "id": 6, "tasks": ["3.1", "4.1"] },
    { "id": 7, "tasks": ["3.2", "3.3", "3.4", "3.5", "4.2"] },
    { "id": 8, "tasks": ["4.3"] },
    { "id": 9, "tasks": ["6.1", "6.2"] },
    { "id": 10, "tasks": ["6.3", "6.4"] },
    { "id": 11, "tasks": ["6.5", "6.6", "7.1", "7.9"] },
    { "id": 12, "tasks": ["7.2", "7.5"] },
    { "id": 13, "tasks": ["7.3", "7.4", "7.6", "7.7", "7.8"] },
    { "id": 14, "tasks": ["8.1"] },
    { "id": 15, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 16, "tasks": ["10.1", "10.2", "10.4"] },
    { "id": 17, "tasks": ["10.3", "10.5", "11.1"] },
    { "id": 18, "tasks": ["11.2", "11.3", "11.4"] },
    { "id": 19, "tasks": ["11.5", "12.1", "12.2"] },
    { "id": 20, "tasks": ["12.3"] },
    { "id": 21, "tasks": ["12.4"] }
  ]
}
```
