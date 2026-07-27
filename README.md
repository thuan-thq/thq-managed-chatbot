# AWS Managed Chatbot

An embeddable RAG chatbot platform. Each client gets isolated AWS serverless infrastructure deployed via CDK and a Next.js chat widget hosted on Vercel.

**Phase 1:** Chat flow end-to-end — widget, session management, Bedrock KB retrieval, and SSE streaming.
**Phase 2:** Content ingestion pipeline — data source adapters, webhook-driven sync, full-sync pipeline, and admin API.

---

## Architecture

```
Host Page
  └── Chat Widget (Next.js / Vercel, Shadow DOM)
        └── HTTP API Gateway (ap-southeast-2)
              ├── POST /chat              → Chat Lambda
              ├── POST /session           → Chat Lambda
              ├── GET  /session/{id}      → Chat Lambda
              ├── POST /webhook/{source}  → Ingestion Lambda
              ├── POST /ingest/record     → Ingestion Lambda
              ├── DELETE /ingest/record/{id} → Ingestion Lambda
              ├── GET  /admin/config      → Admin Lambda
              ├── PUT  /admin/config      → Admin Lambda
              ├── GET  /admin/sync-status → Admin Lambda
              ├── POST /admin/sync/trigger→ Admin Lambda
              └── GET  /admin/analytics   → Admin Lambda

Chat Lambda:
  ├── Amazon Bedrock Knowledge Base (S3 vector store)
  ├── Bedrock Runtime (Claude)
  └── DynamoDB Sessions table

Ingestion Lambda:
  ├── Data Source Adapters (Strapi [articles, intranet-pages], Monday.com, Employment Hero)
  ├── S3 Data Bucket (documents/ prefix → KB source)
  ├── Bedrock KB Sync (start-ingestion-job)
  ├── DynamoDB Sync State
  └── DynamoDB Webhook Dedup table

Admin Lambda:
  ├── DynamoDB (sessions, sync state)
  ├── Parameter Store (config CRUD)
  └── Secrets Manager
```

Infrastructure is defined in `infra/` (CDK TypeScript). The widget lives in `app/` (Next.js 15 static export).

---

## Repository Layout

```
aws-managed-chatbot/
├── infra/                        # CDK stack + Lambda handlers
│   ├── bin/infra.ts              # CDK entry point
│   ├── config/
│   │   └── deployment.example.json   # Copy to deployment.json and fill in
│   ├── lambda/
│   │   ├── chat/                 # Chat Lambda source (Node.js 20)
│   │   │   ├── index.ts          # Router (POST /chat, POST /session, GET /session/{id})
│   │   │   ├── chat-handler.ts   # Bedrock retrieval + streaming
│   │   │   ├── session-handler.ts    # Session creation
│   │   │   └── session-validator.ts  # State machine + transitions
│   │   ├── ingestion/            # Ingestion Lambda source (Node.js 20)
│   │   │   ├── handler.ts        # Router (webhooks, ingest, delete, full-sync)
│   │   │   ├── adapter.ts        # DataSourceAdapter interface
│   │   │   ├── types.ts          # ContentRecord, ChangeSet, etc.
│   │   │   ├── strapi-adapter.ts # Strapi CMS adapter
│   │   │   ├── monday-adapter.ts # Monday.com adapter
│   │   │   ├── employment-hero-adapter.ts # Employment Hero adapter
│   │   │   ├── http-client.ts    # RetryHttpClient (exponential backoff)
│   │   │   ├── sync-pipeline.ts  # Full sync with pagination + progress
│   │   │   ├── webhook-validator.ts  # HMAC signature validation
│   │   │   ├── dedup-service.ts  # Webhook deduplication (DynamoDB)
│   │   │   ├── event-router.ts   # Webhook event routing (create/update/delete)
│   │   │   ├── s3-client.ts      # S3 content CRUD
│   │   │   ├── dynamo-client.ts  # Sync state persistence
│   │   │   └── bedrock-client.ts # Bedrock KB sync trigger
│   │   └── admin/                # Admin Lambda source (Node.js 20)
│   │       ├── index.ts          # Router (config CRUD, sync, analytics)
│   │       ├── config-handler.ts # GET/PUT /admin/config
│   │       ├── sync-handler.ts   # POST /admin/sync/trigger, GET /admin/sync-status
│   │       ├── analytics-handler.ts  # GET /admin/analytics
│   │       └── validation.ts     # Config schema validation
│   ├── lib/
│   │   ├── constructs/           # CDK constructs (one per resource group)
│   │   ├── config/               # DeploymentConfig type + loader/validator
│   │   └── managed-chatbot-stack.ts
│   └── test/                     # Jest unit + CDK assertion tests
└── app/                          # Next.js chat widget
    ├── src/
    │   ├── components/           # ChatWidget, ShadowDomContainer, ErrorBoundary
    │   └── lib/                  # session-client, sse-client, branding, types
    └── .env.example              # All required env vars
```

---

## Prerequisites

| Requirement | Version / Notes                                      |
| ----------- | ---------------------------------------------------- |
| Node.js     | 20.x (Lambda runtime parity)                         |
| AWS CLI     | v2, configured with credentials for `ap-southeast-2` |
| AWS CDK CLI | `npm i -g aws-cdk` (v2)                              |
| AWS account | Bedrock model access enabled (see below)             |

### Enable Bedrock Model Access

Before deploying, request access to Claude in your AWS account:

1. Open the AWS Console → **Amazon Bedrock** → **Model access** (ap-southeast-2)
2. Enable **Anthropic Claude 3 Haiku** (`anthropic.claude-3-haiku-20240307-v1:0`)
3. Wait for status to show **Access granted** (usually < 5 minutes)

---

## Quick Start

### 1. Install dependencies

```bash
cd infra && npm install
cd ../app && npm install
```

### 2. Create your deployment config

```bash
cp infra/config/deployment.example.json infra/config/deployment.json
```

Edit `infra/config/deployment.json`:

```json
{
  "clientId": "my-client",
  "region": "ap-southeast-2",
  "dataSource": {
    "type": "strapi",
    "apiEndpoint": "https://cms.example.com",
    "apiToken": "your-strapi-token",
    "webhookSecret": "any-random-string-for-phase1"
  },
  "session": {
    "duration": 30,
    "turnLimit": 50,
    "tokenBudget": 8000
  },
  "rateLimit": { "requestsPerMinute": 30 },
  "apiKeys": {
    "appKey": "wk-your-widget-key",
    "adminKey": "ak-your-admin-key"
  },
  "monitoring": {
    "budgetAmount": 50,
    "alarmEmail": "you@example.com"
  }
}
```

**`clientId` rules:** lowercase alphanumeric + hyphens, 3–63 characters, must start and end with alphanumeric.

### 3. Bootstrap CDK (first time only per account/region)

```bash
cd infra && npx cdk bootstrap aws://ACCOUNT_ID/ap-southeast-2
```

### 4. Deploy

```bash
cd infra && npx cdk deploy
```

The stack name will be `ManagedChatbot-{clientId}`. Deployment takes ~5–10 minutes, mostly for the Bedrock Knowledge Base.

### 5. Configure the widget

```bash
cp app/.env.example app/.env.local
```

Edit `app/.env.local` — the critical field is the API endpoint from the CDK output:

```dotenv
NEXT_PUBLIC_API_ENDPOINT=https://xxxx.execute-api.ap-southeast-2.amazonaws.com
NEXT_PUBLIC_PRIMARY_COLOUR=#2563eb
NEXT_PUBLIC_WIDGET_TITLE=Chat Assistant
NEXT_PUBLIC_WELCOME_MESSAGE=Hi! How can I help you today?
```

### 6. Run the widget locally

```bash
cd app && npm run dev
```

Open http://localhost:3000 — the chat bubble appears bottom-right.

---

## Running Tests

```bash
# CDK + Lambda unit tests (Jest)
cd infra && npm test

# Widget component + lib tests (Vitest)
cd app && npm test
```

All 268 infra tests pass. No integration tests hit live AWS — those are covered in the runbook.

---

## Configuration Reference

All fields in `deployment.json`:

| Field                         | Type   | Default  | Range / Notes                         |
| ----------------------------- | ------ | -------- | ------------------------------------- |
| `clientId`                    | string | required | 3–63 chars, `[a-z0-9-]`               |
| `region`                      | string | required | Must be `ap-southeast-2`              |
| `dataSource.type`             | enum   | required | `strapi`, `monday`, `employment-hero` |
| `dataSource.apiEndpoint`      | string | required | Base URL of your CMS                  |
| `dataSource.apiToken`         | string | required | Stored in Secrets Manager             |
| `dataSource.webhookSecret`    | string | required | Stored in Secrets Manager             |
| `dataSource.pageSize`         | number | 100      | 1–500                                 |
| `session.duration`            | number | 30       | Minutes, 1–120                        |
| `session.turnLimit`           | number | 50       | 1–500                                 |
| `session.tokenBudget`         | number | 8000     | 1000–100000                           |
| `session.retentionDays`       | number | 7        | 1–365                                 |
| `rateLimit.requestsPerMinute` | number | 30       | 1–1000                                |
| `apiKeys.appKey`              | string | required | Used in `x-api-key` header            |
| `apiKeys.adminKey`            | string | required | Admin endpoints only                  |
| `monitoring.budgetAmount`     | number | required | Monthly USD                           |
| `monitoring.alarmEmail`       | string | required | Valid email                           |

---

## AWS Resources Deployed

| Resource                     | Name pattern                                                    |
| ---------------------------- | --------------------------------------------------------------- |
| CloudFormation stack         | `ManagedChatbot-{clientId}`                                     |
| HTTP API Gateway             | `{clientId}-chatbot-api`                                        |
| Chat Lambda (512MB)          | `{clientId}-chat`                                               |
| Ingestion Lambda             | `{clientId}-ingestion`                                          |
| Admin Lambda (128MB)         | `{clientId}-admin`                                              |
| DynamoDB Sessions table      | auto-named by CDK                                               |
| DynamoDB Webhook Dedup table | auto-named by CDK                                               |
| S3 data bucket               | `{clientId}-kb-data`                                            |
| Bedrock Knowledge Base       | `{clientId}-knowledge-base`                                     |
| Bedrock S3 Data Source       | `{clientId}-s3-data-source`                                     |
| Parameter Store paths        | `/{clientId}/config/{ratelimits,session,datasource,monitoring}` |
| Secrets Manager paths        | `/{clientId}/secrets/{api-keys,datasource}`                     |

All resources have cost allocation tags: `ClientId`, `Project=managed-chatbot`, `ManagedBy=cdk`.

---

## Data Source Adapters

The ingestion pipeline uses a plugin pattern with interchangeable adapters. Configure via `dataSource.type` in `deployment.json`.

| Adapter         | `dataSource.type` | Auth Mechanism   | Change Detection        |
| --------------- | ----------------- | ---------------- | ----------------------- |
| Strapi CMS      | `strapi`          | Bearer API token | `updated_at` field      |
| Monday.com      | `monday`          | API token header | `updated_at` comparison |
| Employment Hero | `employment-hero` | Bearer API token | `updated_at` comparison |

All adapters:

- Produce `ContentRecord` format (recordId, contentBody, contentType, metadata, lastModified)
- Support cursor-based pagination (configurable page size, default 100)
- Retry HTTP failures 3x with exponential backoff (1s base, 10s max)
- Skip invalid records and collect errors without halting

### Strapi Collections

The Strapi adapter syncs multiple collections from a single Strapi instance. Collections are managed in code (`STRAPI_COLLECTIONS` in `handler.ts`):

| Collection        | Content Extraction                                                         |
| ----------------- | -------------------------------------------------------------------------- |
| `intranet-pages`  | Dynamic zone `content_blocks` - text extracted recursively from components |
| `intranet-teams`  | Dynamic zone `content_blocks` - text extracted recursively from components |
| `intranet-people` | Dynamic zone `content_blocks` - text extracted recursively from components |

For collections with dynamic zones, the adapter:

- Populates `content_blocks` via Strapi REST API `populate` params
- Recursively extracts text from components: `DynamicTextBlockComponent`, `DynamicAccordionComponent`, `DynamicChangelingTextBlockComponent`, `Dynamic5050TextNImageComponent`, `DynamicDoubleTextBlockComponent`, and others
- Composes the final content body from name/title, summary, and extracted block text

A full sync always syncs all collections sequentially.

---

## Ingestion Modes

| Mode           | Trigger                          | Scope                        |
| -------------- | -------------------------------- | ---------------------------- |
| Full Sync      | Direct Lambda invocation / admin | All collections sequentially |
| Webhook (live) | `POST /webhook/{collection}`     | Single record                |
| Manual upsert  | `POST /ingest/record`            | Single record                |
| Manual delete  | `DELETE /ingest/record/{id}`     | Single record                |

Full sync persists progress to DynamoDB and resumes from the last checkpoint on interruption.

### Full Sync Invocation

```bash
# Syncs all Strapi collections (intranet-pages, intranet-teams, intranet-people)
aws lambda invoke --function-name "${CLIENT_ID}-ingestion" \
  --payload '{"type":"full-sync"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/sync-result.json
```

### Webhook Collection Routing

Webhooks use the `{source}` path parameter to identify the collection:

```bash
POST /webhook/intranet-pages   # webhook for intranet-pages collection
POST /webhook/intranet-teams   # webhook for intranet-teams collection
POST /webhook/intranet-people  # webhook for intranet-people collection
```

---

## Tear Down

```bash
cd infra && npx cdk destroy
```

> **Note:** The S3 bucket uses `RemovalPolicy.DESTROY` so it will be deleted with the stack. DynamoDB tables also use destroy policy. If you've changed these to RETAIN, you'll need to delete them manually after stack deletion.
