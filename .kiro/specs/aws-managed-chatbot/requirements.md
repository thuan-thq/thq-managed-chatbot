# Requirements Document

## Introduction

This document defines the requirements for an embeddable RAG (Retrieval-Augmented Generation) chatbot platform with a split architecture: a Next.js chat widget hosted on Vercel and an AWS serverless backend deployed per client. The system is delivered in three phases: Phase 1 covers the chat flow (widget + backend conversation handling), Phase 2 adds content ingestion with data source connectors, and Phase 3 layers in security hardening and observability. Each client receives isolated infrastructure deployed from a cloneable CDK template to `ap-southeast-2`.

## Glossary

- **Chat_Widget**: The Next.js-based embeddable UI component rendered inside a Shadow DOM container on a host page, providing the chat interface
- **Chat_Lambda**: The AWS Lambda function (512MB+) responsible for handling chat requests, retrieving context from Bedrock KB, generating responses, and streaming results via SSE
- **Admin_Lambda**: The AWS Lambda function (128MB) responsible for administrative operations including configuration management, sync control, and analytics
- **Ingestion_Lambda**: The AWS Lambda function responsible for content ingestion from external data sources, webhook validation, and routing ingestion operations
- **API_Gateway**: The AWS HTTP API Gateway serving as the single entry point for all backend requests with routing, CORS enforcement, and rate limiting
- **Bedrock_KB**: Amazon Bedrock Knowledge Base with S3 vector store used for RAG retrieval
- **Data_Source_Adapter**: A plugin implementing the common adapter interface for a specific external data source (Strapi, Monday.com, Employment Hero)
- **Configuration_Service**: The centralised configuration access layer that caches values from Parameter Store and Secrets Manager during Lambda execution lifecycle
- **Session**: A time-bounded conversation context tracked in DynamoDB with turn count, token budget, and expiry constraints
- **Content_Record**: The normalised document format produced by adapters and stored in S3 for Bedrock KB ingestion
- **Webhook_Deduplication**: The mechanism ensuring at-most-once processing of webhook events using a DynamoDB dedup table with 24-hour TTL
- **CDK_Stack**: The AWS CDK template defining all infrastructure resources for a single client deployment

## Requirements

### Requirement 1: Chat Widget Embedding and Isolation

**User Story:** As a website owner, I want to embed the chatbot on my website via a single script tag, so that my visitors can interact with the AI assistant without affecting or being affected by my page styles.

#### Acceptance Criteria

1. WHEN the embed script tag loads on a host page, THE Chat_Widget SHALL render inside a Shadow DOM container that prevents host page styles from affecting widget elements and prevents widget styles from affecting host page elements
2. WHEN the embed script tag loads on a host page, THE Chat_Widget SHALL complete initial render within 3 seconds on a 4G connection (download 20 Mbps)
3. THE Chat_Widget SHALL maintain a minimum touch target size of 44x44 pixels for all interactive elements
4. THE Chat_Widget SHALL render without horizontal overflow or content truncation across viewport widths from 320px to 2560px
5. WHEN a user expands or collapses the widget, THE Chat_Widget SHALL complete the animation within 300 milliseconds
6. THE Chat_Widget SHALL apply branding configuration (primary colour, logo URL, widget title, and font family) from build-time environment variables without making runtime API calls to AWS
7. IF the embed script fails to load or encounters an initialization error, THEN THE Chat_Widget SHALL not throw uncaught exceptions on the host page and SHALL not render any visible broken UI elements

### Requirement 2: Chat Conversation Flow

**User Story:** As a website visitor, I want to ask questions and receive AI-generated answers grounded in the knowledge base, so that I get accurate and relevant information.

#### Acceptance Criteria

1. WHEN a user sends a message of 1 to 2000 characters, THE Chat_Lambda SHALL retrieve context from Bedrock_KB, generate a response using only information present in the retrieved context, and stream tokens to the Chat_Widget via SSE
2. WHEN streaming a response, THE Chat_Lambda SHALL deliver the first token within 3 seconds at the 95th percentile
3. WHEN Bedrock_KB returns no results or returns results with all relevance scores below the configured confidence threshold (default 0.5), THE Chat_Lambda SHALL stream a no-answer fallback message following the standard SSE event sequence (token events followed by a done event) indicating that no relevant information was found
4. WHEN streaming a response, THE Chat_Lambda SHALL emit a valid sequence of SSE events: zero or more token events, zero or more interleaved citation events, terminated by exactly one done or error event
5. WHEN a citation is included, THE Chat_Lambda SHALL provide the source record ID, title, and relevance score
6. IF a user sends a message that is empty or exceeds 2000 characters, THEN THE Chat_Lambda SHALL reject the request with a 400 response indicating the message length constraint
7. IF a user sends a new message while a response is actively streaming, THEN THE Chat_Lambda SHALL reject the new message with a 409 response indicating that a response is already in progress

### Requirement 3: Session Management

**User Story:** As a platform operator, I want chat sessions to enforce duration, turn, and token limits, so that I can control resource usage per conversation.

#### Acceptance Criteria

1. WHEN a new session is created, THE Chat_Lambda SHALL assign a session token with at least 128 bits of cryptographic randomness and a configurable duration (default 30 minutes, configurable between 1 and 120 minutes)
2. WHEN a request arrives for a session whose elapsed time since creation exceeds the configured duration, THE Chat_Lambda SHALL transition the session status to expired and reject the request with a 401 response containing a session_expired error code
3. THE Chat_Lambda SHALL enforce a session state machine where active sessions may transition to expired or exhausted, and expired or exhausted sessions are terminal states that reject all further requests with a 401 response containing the corresponding status reason
4. WHEN the cumulative token count (sum of input tokens and output tokens across all turns) in a session exceeds the configured token budget (default 8000, configurable between 1000 and 100000), THE Chat_Lambda SHALL deliver the current response that caused the exceedance, then transition the session to exhausted
5. WHEN the turn count in a session reaches the configured turn limit (default 50, configurable between 1 and 500), THE Chat_Lambda SHALL transition the session to exhausted and reject further messages with a 401 response containing a session_exhausted error code
6. THE Chat_Lambda SHALL persist session state (turn count, cumulative input and output tokens used, last activity timestamp, status) to DynamoDB after each turn
7. WHEN a session reaches expired or exhausted status, THE Chat_Widget SHALL display a read-only conversation history and offer a New Session button

### Requirement 4: Content Ingestion Pipeline

**User Story:** As a content administrator, I want the system to ingest content from my CMS into the knowledge base, so that the chatbot can answer questions using up-to-date information.

#### Acceptance Criteria

1. WHEN the CDK stack is first deployed, THE Ingestion_Lambda SHALL execute a full ingestion of the configured data source within 15 minutes
2. THE Ingestion_Lambda SHALL run a scheduled full-sync every 7 days as a safety net for missed webhook events
3. WHEN paginating source data, THE Ingestion_Lambda SHALL retrieve all records across all pages with no duplicates and no omissions using a configurable page size (default 100)
4. THE Ingestion_Lambda SHALL persist sync progress to DynamoDB for resume capability after interruption
5. WHEN an ingestion operation fails, THE Ingestion_Lambda SHALL retry the failed operation up to 3 times with exponential backoff
6. THE Ingestion_Lambda SHALL log ingestion progress every 100 records processed

### Requirement 5: Data Source Adapter Conformance

**User Story:** As a developer, I want all data source adapters to produce a consistent output format, so that the ingestion pipeline processes records uniformly regardless of source.

#### Acceptance Criteria

1. THE Data_Source_Adapter SHALL transform source-specific records into Content_Record format with non-empty recordId (maximum 256 characters), non-empty contentBody (maximum 1MB), non-empty contentType (MIME type format), valid ISO 8601 lastModified, and a non-null metadata object
2. WHEN detecting changes since a checkpoint, THE Data_Source_Adapter SHALL return a ChangeSet containing created records, updated records, deleted record IDs, and an opaque checkpoint cursor, where an empty ChangeSet contains empty collections and a valid checkpoint cursor
3. WHEN making HTTP calls to the data source and receiving a 5xx response or a connection/read timeout, THE Data_Source_Adapter SHALL retry the request up to 3 times with exponential backoff (1 second base, 10 second maximum) and, if all retries are exhausted, propagate the failure to the caller with the last error details
4. THE Data_Source_Adapter SHALL support pagination via a cursor-based interface with configurable page size (default 100, minimum 1, maximum 500)
5. IF a source record cannot be transformed into a valid Content_Record due to missing or malformed required fields, THEN THE Data_Source_Adapter SHALL skip that record, include its identifier in an errors collection within the result, and continue processing remaining records

### Requirement 6: Webhook-Driven Incremental Sync

**User Story:** As a content administrator, I want real-time content updates to flow into the knowledge base when I publish changes in my CMS, so that the chatbot answers reflect the latest content.

#### Acceptance Criteria

1. WHEN a webhook event is received, THE Ingestion_Lambda SHALL validate the HMAC signature using the configured shared secret before processing
2. IF a webhook signature validation fails, THEN THE Ingestion_Lambda SHALL return a 401 response, log a structured security event including the source IP and timestamp, and discard the payload without processing
3. WHEN a valid webhook event is received with an event ID already present in the DynamoDB deduplication table, THE Ingestion_Lambda SHALL skip processing and return a 200 response
4. WHEN a valid webhook event of type create or update is received, THE Ingestion_Lambda SHALL invoke the Data_Source_Adapter to produce a Content_Record and persist it to the S3 knowledge base prefix within 60 seconds
5. WHEN a valid webhook event of type delete is received, THE Ingestion_Lambda SHALL remove the corresponding Content_Record from S3 and trigger a Bedrock_KB sync within 60 seconds
6. IF webhook processing fails or exceeds 60 seconds, THEN THE Ingestion_Lambda SHALL return a 500 response, log the error with the event ID, and leave the event ID absent from the deduplication table to allow redelivery
7. THE Webhook_Deduplication mechanism SHALL record the event ID in the DynamoDB deduplication table only after successful processing, ensuring that reprocessing the same event ID produces the same final state as processing it exactly once
8. WHEN webhook processing completes successfully, THE Ingestion_Lambda SHALL return a 200 response and record the event ID in the DynamoDB deduplication table

### Requirement 7: API Authentication

**User Story:** As a platform operator, I want all API requests to be authenticated, so that only authorised clients and administrators can access the system.

#### Acceptance Criteria

1. WHEN a request arrives at API_Gateway with a missing or invalid API key in the x-api-key header, THE API_Gateway SHALL return a 401 response with no data payload
2. THE API_Gateway SHALL validate API keys against cached values from Secrets Manager, distinguishing between widget keys and admin keys, where a key is invalid if it is absent from the cached set of active keys
3. WHEN a request targets an admin endpoint with a widget API key, THE API_Gateway SHALL reject the request with a 403 response and no data payload
4. WHEN a request targets a widget endpoint with a valid admin API key, THE API_Gateway SHALL accept the request as authorised
5. WHEN a request includes a session token that is expired, malformed, or does not match an existing session, THE Chat_Lambda SHALL reject the request with a 401 response containing a session_expired error code

### Requirement 8: CORS Enforcement

**User Story:** As a platform operator, I want cross-origin requests restricted to explicitly configured origins, so that only authorised websites can access the API.

#### Acceptance Criteria

1. THE API_Gateway SHALL include Access-Control-Allow-Origin headers only for origins present in the configured allowed-origins list (maximum 10 entries)
2. WHEN a request arrives from a non-allowed origin, THE API_Gateway SHALL omit all CORS headers (Access-Control-Allow-Origin, Access-Control-Allow-Methods, Access-Control-Allow-Headers, Access-Control-Allow-Credentials) from the response
3. THE API_Gateway SHALL not use wildcard (\*) values for Access-Control-Allow-Origin, Access-Control-Allow-Methods, or Access-Control-Allow-Headers
4. WHEN a preflight OPTIONS request arrives from an allowed origin, THE API_Gateway SHALL respond with Access-Control-Allow-Origin set to the requesting origin, Access-Control-Allow-Methods listing the permitted HTTP methods, and Access-Control-Allow-Headers listing the permitted request headers
5. IF a request contains no Origin header, THEN THE API_Gateway SHALL process the request without including any CORS headers in the response

### Requirement 9: Rate Limiting

**User Story:** As a platform operator, I want per-session rate limiting, so that no single session can overwhelm the system or consume excessive resources.

#### Acceptance Criteria

1. THE API_Gateway SHALL enforce a configurable rate limit per session (default 30 requests per minute)
2. WHEN a session exceeds the configured rate limit within a time window, THE API_Gateway SHALL return a 429 response with a valid Retry-After header
3. WHEN the rate limit is not exceeded, THE API_Gateway SHALL accept and forward the request to the appropriate Lambda function

### Requirement 10: Configuration Management

**User Story:** As a platform operator, I want centralised configuration with caching and validation, so that I can manage client settings efficiently without performance penalties.

#### Acceptance Criteria

1. THE Configuration_Service SHALL read non-sensitive configuration from Parameter Store and credentials from Secrets Manager
2. THE Configuration_Service SHALL cache configuration values during the Lambda execution environment lifecycle with a 5-minute TTL
3. WHEN the cache TTL expires, THE Configuration_Service SHALL refresh configuration from the backing stores on the next read
4. WHEN a deployment configuration is submitted, THE Configuration_Service SHALL validate that clientId matches the pattern lowercase alphanumeric plus hyphens with length 3 to 63 characters, and that all numeric values fall within defined ranges
5. IF a deployment configuration fails validation, THEN THE Configuration_Service SHALL reject the configuration with descriptive error messages identifying each invalid field

### Requirement 11: Observability and Monitoring

**User Story:** As a platform operator, I want structured logging, distributed tracing, and alarms, so that I can monitor system health and troubleshoot issues.

#### Acceptance Criteria

1. THE Chat_Lambda SHALL emit structured JSON logs with request ID, session ID, latency tracking, and error details for every request
2. THE CDK_Stack SHALL configure X-Ray tracing at 5% sampling rate for production traffic
3. THE CDK_Stack SHALL set CloudWatch log retention to 14 days for all Lambda functions
4. WHEN the 5xx error rate exceeds 5% over a 5-minute window, THE CloudWatch alarm SHALL trigger an SNS notification
5. WHEN an ingestion operation fails after all retries, THE Ingestion_Lambda SHALL trigger a CloudWatch alarm

### Requirement 12: Cost Governance

**User Story:** As a platform operator, I want budget alerts and cost-optimised infrastructure defaults, so that I can control monthly spending per client.

#### Acceptance Criteria

1. THE CDK_Stack SHALL create an AWS Budget with a configured monthly USD threshold and send alerts via SNS when spending approaches or exceeds the threshold
2. THE CDK_Stack SHALL deploy DynamoDB tables with provisioned capacity and auto-scaling (base 1 RCU/1 WCU, maximum 50 RCU/25 WCU)
3. THE CDK_Stack SHALL configure S3 lifecycle rules to transition infrequently accessed documents to IA storage after 30 days and delete after 90 days
4. THE CDK_Stack SHALL deploy HTTP API Gateway (not REST API Gateway) for cost efficiency

### Requirement 13: Infrastructure Deployment

**User Story:** As a developer, I want a cloneable CDK template that deploys all resources for a single client, so that I can provision new clients quickly with complete data isolation.

#### Acceptance Criteria

1. THE CDK_Stack SHALL deploy all resources (API Gateway, 3 Lambda functions, DynamoDB tables, S3 bucket, Bedrock KB, Parameter Store, Secrets Manager, CloudWatch alarms, Budget) from a single deployment configuration file
2. THE CDK_Stack SHALL deploy all resources to the ap-southeast-2 region
3. THE CDK_Stack SHALL apply cost allocation tags to all resources for per-client cost tracking
4. THE CDK_Stack SHALL use a single S3 bucket per client with prefix-based organisation (documents/, metadata/, sync/progress/)
5. THE CDK_Stack SHALL configure Chat_Lambda with 512MB or higher memory and Admin_Lambda with 128MB memory

### Requirement 14: Error Handling and Resilience

**User Story:** As a website visitor, I want the chatbot to handle errors gracefully, so that I receive clear feedback and can continue using the system.

#### Acceptance Criteria

1. WHEN Bedrock_KB or Bedrock Runtime returns a 5xx error or timeout, THE Chat_Lambda SHALL return a 503 response and increment the 5xx alarm counter
2. WHEN a rate limit is exceeded, THE Chat_Widget SHALL display a countdown timer indicating when the user can send the next message
3. WHEN a session is exhausted, THE Chat_Widget SHALL display a message explaining the limit reached and offer a New Session button
4. WHEN an ingestion source is unavailable after 3 retries, THE Ingestion_Lambda SHALL mark the sync state as failed with error details and resume from the last checkpoint on the next attempt
