# Onboarding a New Client

This runbook walks through the end-to-end process of connecting a new client's Strapi CMS to the managed chatbot. Follow the steps in order. Each step has a clear outcome — if something fails, the ConfigLoader will tell you exactly which field is wrong before anything is deployed.

---

## Prerequisites

- AWS CLI configured with credentials for the target account
- CDK bootstrapped in the target region (`cdk bootstrap`)
- The client's Strapi CMS is live and accessible over HTTPS
- You have a Strapi API token with read access to all collections you intend to ingest

---

## Step 1 — Copy the example config and fill in the client's values

Copy the example deployment config to create the client's actual config file:

```bash
cp infra/config/deployment.example.json infra/config/deployment.json
```

Then open `infra/config/deployment.json` and replace every placeholder with the client's real values:

| Field                    | Description                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId`               | A short, lowercase, hyphen-separated identifier for the client (e.g. `acme-corp`)                                                        |
| `region`                 | AWS region for all resources (e.g. `ap-southeast-2`)                                                                                     |
| `strapi.baseUrl`         | The root URL of the client's Strapi instance (e.g. `https://cms.acme.com`)                                                               |
| `strapi.frontendBaseUrl` | The root URL of the client's public-facing website — used to construct `sourceUrl` links in the Knowledge Base                           |
| `strapi.apiToken`        | **Do not store the real token here** — see Step 4. Use a placeholder name that matches the secret key you will create in Secrets Manager |
| `strapi.webhookSecret`   | Same as above — reference the secret key name only                                                                                       |
| `apiKeys.appKey`         | Widget API key (must start with `wk-`)                                                                                                   |
| `apiKeys.adminKey`       | Admin API key (must start with `ak-`)                                                                                                    |

> The ConfigLoader validates `deployment.json` at Lambda cold start and will throw a descriptive error listing every invalid field if anything is misconfigured. Fix the error, redeploy, and the Lambda will retry on the next cold start.

---

## Step 2 — Define `strapi.collections` for the client's content model

Each Strapi collection you want to ingest needs an entry in the `strapi.collections` array. The most important choice per collection is `markdownStrategy` — pick the one that matches how the content is structured in Strapi:

| Strategy         | When to use                                                                                                           | Required `fieldMappings` |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `content-blocks` | The collection uses a dynamic zone (e.g. a `content_blocks` field with multiple component types)                      | `contentBlocksField`     |
| `rich-text`      | The collection stores its body as a single rich-text (Lexical/Slate) field                                            | `richTextField`          |
| `flat-fields`    | The collection is simple — question/answer, FAQ, glossary term — where you just want to concatenate plain text fields | `flatFields` (array)     |

**Example — one collection per strategy:**

```json
"collections": [
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
    "urlPathTemplate": "/articles/{slug}",
    "populate": {
      "fields": [
        {
          "key": "populate[content_blocks][on][dynamic.text-block][populate]",
          "value": "*"
        }
      ]
    }
  },
  {
    "name": "blog-posts",
    "strapiUid": "api::blog-post.blog-post",
    "markdownStrategy": "rich-text",
    "fieldMappings": {
      "titleFields": ["title"],
      "slugField": "slug",
      "richTextField": "body",
      "lastModifiedField": "updatedAt"
    },
    "urlPathTemplate": "/blog/{slug}"
  },
  {
    "name": "faqs",
    "strapiUid": "api::faq.faq",
    "markdownStrategy": "flat-fields",
    "fieldMappings": {
      "titleFields": ["question"],
      "flatFields": ["question", "answer"],
      "lastModifiedField": "updatedAt"
    }
  }
]
```

The `strapiUid` must match the full Strapi content-type UID (visible in Strapi's Content-Type Builder, e.g. `api::article.article`). This is used by the webhook handler to route incoming events to the correct collection.

---

## Step 3 — Set `urlPathTemplate` per collection

For each collection where you want the Knowledge Base documents to carry a clickable source link, set `urlPathTemplate` to the path pattern on the client's website:

```json
"urlPathTemplate": "/articles/{slug}"
```

The `{slug}` placeholder is replaced at ingest time with the entry's resolved slug value. The full `sourceUrl` is constructed as `frontendBaseUrl` + `urlPathTemplate`.

- Use `{slug}` exactly — no other placeholder tokens are supported.
- If a collection has no meaningful public URL (e.g. an internal-only FAQ), omit `urlPathTemplate` entirely and `sourceUrl` will be omitted from those documents.
- If the entry's slug cannot be resolved, the adapter logs a warning and omits `sourceUrl` rather than writing a broken URL.

---

## Step 4 — Store secrets in AWS Secrets Manager

Never commit real tokens to `deployment.json`. Store the Strapi API token and webhook secret in AWS Secrets Manager under key names that match what the Lambda expects.

Create the secret for the client:

```bash
aws secretsmanager create-secret \
  --name "/<client-id>/strapi/api-token" \
  --secret-string "the-actual-strapi-token"

aws secretsmanager create-secret \
  --name "/<client-id>/strapi/webhook-secret" \
  --secret-string "the-actual-webhook-secret"
```

Then reference those secret names (not the values) in the CDK stack or environment config so the Lambda can resolve them at runtime using `{{resolve:secretsmanager:secret-id:SecretString:json-key}}`.

Also create secrets for the API keys if they are not already set:

```bash
aws secretsmanager create-secret \
  --name "/<client-id>/api/app-key" \
  --secret-string "wk-your-widget-key"

aws secretsmanager create-secret \
  --name "/<client-id>/api/admin-key" \
  --secret-string "ak-your-admin-key"
```

---

## Step 5 — Run `cdk deploy` to provision the client's infrastructure

From the `infra/` directory:

```bash
npm run build
npx cdk deploy --all
```

CDK will synthesise the stack using `deployment.json` and provision all AWS resources — the ingestion Lambda, the Knowledge Base, the S3 bucket, the DynamoDB table, the API Gateway, and any CloudWatch alarms.

If the ConfigLoader rejects `deployment.json` during Lambda initialisation (e.g. a missing required field or an invalid `markdownStrategy`), the Lambda will fail cold start and log a detailed validation error. Fix the config and redeploy.

> Tip: run `npx cdk diff` before `cdk deploy` to preview the changes without applying them.

---

## Step 6 — Trigger a full sync to populate the Knowledge Base

Once the infrastructure is up, run a full sync to ingest all content from the configured collections:

```bash
curl -X POST https://<api-gateway-url>/admin/sync \
  -H "x-admin-key: <your-admin-key>" \
  -H "Content-Type: application/json"
```

The sync handler iterates over every collection in `strapi.collections`, fetches all entries from Strapi, converts each one to markdown, uploads it to S3, and triggers a Bedrock ingestion job to update the Knowledge Base embeddings.

The response body includes `totalRecords`, `totalErrors`, and `success`. A `success: false` response means some records failed — check the Lambda logs for per-collection error details. Individual collection failures do not abort the sync; all other collections are still processed.

Once `success: true` is returned, the Knowledge Base is ready to answer queries for the new client.
