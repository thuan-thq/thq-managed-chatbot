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
  ├── Data Source Adapters (Strapi, Monday.com, Employment Hero)
  │   └── Each source has its own id, endpoint, credentials, and collections[]
  ├── S3 Data Bucket (documents/{collection}/ prefix → KB source)
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
│   │   ├── deployment.example.json   # Copy to deployment.json and fill in
│   │   └── collections.json          # Collection definitions (injected at build time)
│   ├── lambda/
│   │   ├── chat/                 # Chat Lambda source (Node.js 20)
│   │   │   ├── index.ts
│   │   │   ├── chat-handler.ts
│   │   │   ├── session-handler.ts
│   │   │   └── session-validator.ts
│   │   ├── ingestion/            # Ingestion Lambda source (Node.js 20)
│   │   │   ├── handler.ts        # Router (webhooks, ingest, delete, full-sync)
│   │   │   ├── adapter.ts        # DataSourceAdapter interface
│   │   │   ├── config-types.ts   # ClientConfig, DataSourceConfig, StrapiConfig
│   │   │   ├── config-loader.ts  # Validates deployment.json at cold start
│   │   │   ├── configurable-strapi-adapter.ts
│   │   │   ├── monday-adapter.ts
│   │   │   ├── employment-hero-adapter.ts
│   │   │   ├── sync-pipeline.ts  # Full sync with pagination + resume
│   │   │   ├── event-router.ts   # Webhook routing (create/update/delete)
│   │   │   ├── uid-collection-map.ts # Strapi UID → collection name lookup
│   │   │   └── ...               # http-client, s3-client, dynamo-client, etc.
│   │   └── admin/
│   ├── lib/
│   │   ├── constructs/           # CDK constructs
│   │   ├── config/               # DeploymentConfig type + CDK-side loader/validator
│   │   └── managed-chatbot-stack.ts
│   └── test/
└── app/                          # Next.js chat widget
    ├── src/
    │   ├── components/
    │   └── lib/
    └── .env.example
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

1. Open the AWS Console → **Amazon Bedrock** → **Model access** (ap-southeast-2)
2. Enable **Anthropic Claude 3 Haiku** (`anthropic.claude-3-haiku-20240307-v1:0`)
3. Wait for **Access granted** status (usually < 5 minutes)

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

Edit `infra/config/deployment.json`. The top-level key is now `dataSources` — an array so you can connect multiple CMS instances:

```json
{
  "clientId": "my-client",
  "region": "ap-southeast-2",
  "dataSources": [
    {
      "id": "main-strapi",
      "type": "strapi",
      "apiEndpoint": "https://cms.example.com",
      "apiToken": "your-strapi-token",
      "webhookSecret": "any-random-string",
      "frontendBaseUrl": "https://www.example.com",
      "pageSize": 100,
      "collections": []
    }
  ],
  "session": {
    "duration": 30,
    "turnLimit": 50,
    "tokenBudget": 8000
  },
  "rateLimit": { "requestsPerMinute": 30 },
  "apiKeys": {
    "appKey": "wk-placeholder",
    "adminKey": "ak-your-admin-key"
  },
  "monitoring": {
    "budgetAmount": 50,
    "alarmEmail": "you@example.com"
  }
}
```

To add a second data source, append another entry to the `dataSources` array with a distinct `id`.

**`clientId` rules:** lowercase alphanumeric + hyphens, 3–63 characters, must start and end with alphanumeric.

### 3. Define collections

Collections live in `infra/config/collections.json` (or inline in `dataSources[].collections`). The collections file is automatically merged into the first Strapi source at build time:

```json
[
  {
    "name": "articles",
    "strapiUid": "api::article.article",
    "markdownStrategy": "content-blocks",
    "fieldMappings": {
      "titleFields": ["title"],
      "slugField": "slug",
      "summaryField": "summary",
      "contentBlocksField": "content_blocks",
      "lastModifiedField": "updatedAt"
    },
    "urlPathTemplate": "/articles/{slug}"
  }
]
```

See `infra/config/collections.example.json` for examples of all three markdown strategies.

### 4. Bootstrap CDK (first time only per account/region)

```bash
cd infra && npx cdk bootstrap aws://ACCOUNT_ID/ap-southeast-2
```

### 5. Deploy

```bash
cd infra && npx cdk deploy
```

Stack name: `ManagedChatbot-{clientId}`. Deployment takes ~5–10 minutes (mostly the Bedrock KB).

### 6. Configure the widget

```bash
cp app/.env.example app/.env.local
```

Edit `app/.env.local`:

```dotenv
NEXT_PUBLIC_API_ENDPOINT=https://xxxx.execute-api.ap-southeast-2.amazonaws.com
NEXT_PUBLIC_PRIMARY_COLOUR=#2563eb
NEXT_PUBLIC_WIDGET_TITLE=Chat Assistant
NEXT_PUBLIC_WELCOME_MESSAGE=Hi! How can I help you today?
```

### 7. Run the widget locally

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

---

## Configuration Reference

### `deployment.json` top-level fields

| Field                         | Type   | Default  | Notes                                       |
| ----------------------------- | ------ | -------- | ------------------------------------------- |
| `clientId`                    | string | required | 3–63 chars, `[a-z0-9-]`                     |
| `region`                      | string | required | Must be `ap-southeast-2`                    |
| `modelId`                     | string | optional | Bedrock inference profile ID                |
| `confidenceThreshold`         | number | 0.3      | KB retrieval relevance cutoff (0–1)         |
| `dataSources`                 | array  | required | At least one entry required                 |
| `session.duration`            | number | 30       | Minutes, 1–120                              |
| `session.turnLimit`           | number | 50       | 1–500                                       |
| `session.tokenBudget`         | number | 8000     | 1000–100000                                 |
| `session.retentionDays`       | number | 7        | 1–365                                       |
| `rateLimit.requestsPerMinute` | number | 30       | 1–1000                                      |
| `apiKeys.appKey`              | string | optional | Reserved for future auth — not enforced yet |
| `apiKeys.adminKey`            | string | required | Admin endpoints only                        |
| `monitoring.budgetAmount`     | number | required | Monthly USD                                 |
| `monitoring.alarmEmail`       | string | required | Valid email                                 |

### `dataSources[]` entry fields

| Field             | Type   | Required | Notes                                                                     |
| ----------------- | ------ | -------- | ------------------------------------------------------------------------- |
| `id`              | string | yes      | Unique identifier, e.g. `"main-strapi"`. Used as the secret path segment. |
| `type`            | enum   | yes      | `strapi`, `monday`, `employment-hero`                                     |
| `apiEndpoint`     | string | yes      | Base URL of the data source                                               |
| `apiToken`        | string | yes      | Stored in Secrets Manager at runtime                                      |
| `webhookSecret`   | string | yes      | Stored in Secrets Manager at runtime                                      |
| `frontendBaseUrl` | string | no       | Prepended to `urlPathTemplate` for `sourceUrl`                            |
| `pageSize`        | number | no       | Default 100, max 500                                                      |
| `collections`     | array  | yes      | Can be `[]` if using `collections.json`                                   |

---

## AWS Resources Deployed

| Resource                     | Name / Path pattern                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| CloudFormation stack         | `ManagedChatbot-{clientId}`                                               |
| HTTP API Gateway             | `{clientId}-chatbot-api`                                                  |
| Chat Lambda (512MB)          | `{clientId}-chat`                                                         |
| Ingestion Lambda (512MB)     | `{clientId}-ingestion`                                                    |
| Admin Lambda (128MB)         | `{clientId}-admin`                                                        |
| DynamoDB Sessions table      | auto-named by CDK                                                         |
| DynamoDB Webhook Dedup table | auto-named by CDK                                                         |
| S3 data bucket               | `{clientId}-kb-data`                                                      |
| Bedrock Knowledge Base       | `{clientId}-knowledge-base`                                               |
| Bedrock S3 Data Source       | `{clientId}-s3-data-source`                                               |
| Parameter Store              | `/{clientId}/config/{ratelimits,session,datasource,monitoring}`           |
| Secrets Manager — API keys   | `/{clientId}/secrets/api-keys`                                            |
| Secrets Manager — per source | `/{clientId}/secrets/datasource/{sourceId}` (one per `dataSources` entry) |

All resources have cost allocation tags: `ClientId`, `Project=managed-chatbot`, `ManagedBy=cdk`.

---

## Data Source Adapters

The ingestion pipeline uses a plugin pattern with interchangeable adapters. Configure via `type` in each `dataSources` entry.

| Adapter         | `type`            | Auth             | Change Detection  |
| --------------- | ----------------- | ---------------- | ----------------- |
| Strapi CMS      | `strapi`          | Bearer API token | `updatedAt` field |
| Monday.com      | `monday`          | API token header | `updatedAt` field |
| Employment Hero | `employment-hero` | Bearer API token | `updatedAt` field |

Multiple Strapi instances are supported — add one entry per instance to `dataSources`, each with its own `id`, `apiEndpoint`, credentials, and `collections`.

### Strapi Collections

Each Strapi data source entry declares its own `collections` array. Collections can be defined inline or in `infra/config/collections.json` (which is injected at build time). Each collection picks a `markdownStrategy`:

| Strategy         | When to use                                  | Required `fieldMappings`        |
| ---------------- | -------------------------------------------- | ------------------------------- |
| `content-blocks` | Collection uses a dynamic zone field         | `contentBlocksField`            |
| `rich-text`      | Collection has a single rich-text body field | `richTextField`                 |
| `flat-fields`    | Simple key/value collection (FAQs, glossary) | `flatFields` (array of strings) |

The `strapiUid` field (e.g. `api::article.article`) is used by the webhook handler to route incoming Strapi events to the correct collection without relying on the URL path.

---

## Ingestion Modes

| Mode           | Trigger                              | Scope                             |
| -------------- | ------------------------------------ | --------------------------------- |
| Full sync      | Direct Lambda invocation / admin API | All sources and collections       |
| Webhook (live) | `POST /webhook/{collectionName}`     | Single record, auto-routes by UID |
| Manual upsert  | `POST /ingest/record`                | Single record                     |
| Manual delete  | `DELETE /ingest/record/{id}`         | Single record                     |

Full sync persists progress to DynamoDB per collection and resumes from the last checkpoint on interruption.

### Full Sync Invocation

```bash
aws lambda invoke \
  --function-name "${CLIENT_ID}-ingestion" \
  --region ap-southeast-2 \
  --payload '{"type":"full-sync"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/sync-result.json
cat /tmp/sync-result.json | jq .
```

This syncs all collections across all configured data sources sequentially.

### Webhook Routing

Webhooks arrive at `POST /webhook/{source}`. The `{source}` value can be:

- A collection name (e.g. `intranet-pages`) — the handler resolves the Strapi UID from the payload and routes to the matching source
- A data source `id` (e.g. `main-strapi`) — the handler uses the first matching collection

The webhook secret is validated per data source — each source uses its own secret stored at `/{clientId}/secrets/datasource/{sourceId}`.

---

## Tear Down

```bash
cd infra && npx cdk destroy
```

> The S3 bucket and DynamoDB tables use `RemovalPolicy.DESTROY` and will be deleted with the stack.
