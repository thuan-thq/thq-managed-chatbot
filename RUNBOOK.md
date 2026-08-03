# Deployment & Testing Runbook

Step-by-step guide to deploy the stack and verify every endpoint and behaviour.

---

## Table of Contents

1. [Pre-Deployment Checklist](#1-pre-deployment-checklist)
2. [Deploy the Stack](#2-deploy-the-stack)
3. [Post-Deployment Verification](#3-post-deployment-verification)
4. [API Tests (curl)](#4-api-tests-curl)
5. [Widget Smoke Test](#5-widget-smoke-test)
6. [Session State Machine Tests](#6-session-state-machine-tests)
7. [Knowledge Base Upload & Query Test](#7-knowledge-base-upload--query-test)
8. [Observability Checks](#8-observability-checks)
9. [Content Ingestion Tests](#9-content-ingestion-tests)
10. [Admin API Tests](#10-admin-api-tests)
11. [Webhook End-to-End Test](#11-webhook-end-to-end-test)
12. [Clean Up / Tear Down](#12-clean-up--tear-down)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Pre-Deployment Checklist

```bash
# Node version must be 20.x
node --version     # v20.x.x

# AWS CLI authenticated
aws sts get-caller-identity

# CDK version
npx cdk --version  # 2.x

# All unit tests green
cd infra && npm test
```

**Bedrock model access** — verify in AWS Console (ap-southeast-2):

- Amazon Bedrock → Model access → `Anthropic Claude 3 Haiku` → Access granted ✓

---

## 2. Deploy the Stack

```bash
cd infra

# Validate config before deploying
npx ts-node -e "require('./lib/config').loadConfig('./config/deployment.json'); console.log('Config OK')"

# Dry run
npx cdk synth

# Deploy (~5-10 min, mostly the Bedrock KB)
npx cdk deploy --require-approval never
```

### Capture outputs

```bash
export API_URL="https://XXXX.execute-api.ap-southeast-2.amazonaws.com"
export ADMIN_KEY="ak-your-admin-key"      # from deployment.json apiKeys.adminKey
export CLIENT_ID="my-client"             # from deployment.json clientId
export SOURCE_ID="main-strapi"           # from deployment.json dataSources[0].id
```

---

## 3. Post-Deployment Verification

### 3.1 Stack status

```bash
aws cloudformation describe-stacks \
  --stack-name "ManagedChatbot-${CLIENT_ID}" \
  --region ap-southeast-2 \
  --query 'Stacks[0].StackStatus'
# Expected: "CREATE_COMPLETE"
```

### 3.2 Lambda functions active

```bash
for fn in chat ingestion admin; do
  aws lambda get-function \
    --function-name "${CLIENT_ID}-${fn}" \
    --region ap-southeast-2 \
    --query 'Configuration.[FunctionName,State,Runtime]'
done
# Expected: each shows "Active", "nodejs20.x"
```

### 3.3 S3 bucket exists

```bash
aws s3 ls s3://${CLIENT_ID}-kb-data/
```

### 3.4 Bedrock Knowledge Base active

```bash
aws bedrock list-knowledge-bases --region ap-southeast-2 \
  --query "knowledgeBaseSummaries[?name=='${CLIENT_ID}-knowledge-base'].{name:name,status:status}"
# Expected: status "ACTIVE"

export KB_ID=$(aws bedrock list-knowledge-bases --region ap-southeast-2 \
  --query "knowledgeBaseSummaries[?name=='${CLIENT_ID}-knowledge-base'].knowledgeBaseId" \
  --output text)
```

### 3.5 Parameter Store entries

```bash
aws ssm get-parameters-by-path \
  --path "/${CLIENT_ID}/config" \
  --region ap-southeast-2 \
  --query "Parameters[].Name"
# Expected: 4 entries — ratelimits, session, datasource, monitoring
```

### 3.6 Secrets Manager secrets

```bash
aws secretsmanager list-secrets --region ap-southeast-2 \
  --query "SecretList[?starts_with(Name, '/${CLIENT_ID}/')].Name"
```

**Expected paths:**

- `/{clientId}/secrets/api-keys`
- `/{clientId}/secrets/datasource/{sourceId}` — one per entry in `dataSources`

For example, if `dataSources[0].id = "main-strapi"`:

```
/my-client/secrets/api-keys
/my-client/secrets/datasource/main-strapi
```

If you have two data sources with ids `main-strapi` and `secondary-cms`, you'll see:

```
/my-client/secrets/datasource/main-strapi
/my-client/secrets/datasource/secondary-cms
```

---

## 4. API Tests (curl)

### Test 1: Create a session

```bash
SESSION_RESPONSE=$(curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json")
SESSION_ID=$(echo $SESSION_RESPONSE | jq -r '.sessionId')
echo "Session: $SESSION_ID"
```

**Expected (201):**

```json
{ "sessionId": "<64-char hex>", "token": "<64-char hex>" }
```

### Test 2: Get session status

```bash
curl -s "${API_URL}/session/${SESSION_ID}" | jq .
```

**Expected (200):** `status: "active"`, `turnCount: 0`

### Test 3: Send a chat message

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Hello, what can you help me with?\", \"sessionId\": \"${SESSION_ID}\"}"
```

**Expected:** SSE stream of `data: {"type":"token",...}` events ending with a `done` event. The `done` event confirms `turnCount` incremented to 1.

### Test 4: Validation — empty message

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"\", \"sessionId\": \"${SESSION_ID}\"}" | jq .
# Expected (400): "Message must be between 1 and 2000 characters"
```

### Test 5: Invalid session ID

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "test", "sessionId": "nonexistent"}' | jq .
# Expected (401): "session_expired"
```

---

## 5. Widget Smoke Test

```bash
cp app/.env.example app/.env.local
# Set NEXT_PUBLIC_API_ENDPOINT to $API_URL
cd app && npm run dev
```

Open http://localhost:3000 and verify:

- [ ] Chat bubble renders bottom-right
- [ ] Expand/collapse works
- [ ] Sending a message returns a streamed response
- [ ] Shadow DOM isolation — check DevTools → Elements for `#chatbot-shadow-root`

---

## 6. Session State Machine Tests

### Test A: Session expiry

```bash
EXPIRED=$(curl -s -X POST "${API_URL}/session" | jq -r '.sessionId')
sleep 65  # with session.duration: 1 in config
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"hello\", \"sessionId\": \"${EXPIRED}\"}" | jq .
# Expected (401): errorCode "session_expired"
```

### Test B: Turn limit exhaustion

```bash
TURN_SESSION=$(curl -s -X POST "${API_URL}/session" | jq -r '.sessionId')

# Send 2 messages when turnLimit is 2
for i in 1 2; do
  curl -s -X POST "${API_URL}/chat" \
    -H "Content-Type: application/json" \
    -d "{\"message\": \"turn $i\", \"sessionId\": \"${TURN_SESSION}\"}" > /dev/null
done

# 3rd must be rejected
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"turn 3\", \"sessionId\": \"${TURN_SESSION}\"}" | jq .
# Expected (401): errorCode "session_exhausted"
```

---

## 7. Knowledge Base Upload & Query Test

### 7.1 Upload a test document

```bash
cat > /tmp/test-doc.json << 'EOF'
{
  "recordId": "test-001",
  "contentBody": "The managed chatbot supports Strapi, Monday.com, and Employment Hero data sources.",
  "contentType": "text/plain",
  "sourceType": "strapi",
  "metadata": {
    "clientId": "my-client",
    "title": "Platform Overview",
    "lastModified": "2026-07-20T00:00:00Z"
  }
}
EOF

aws s3 cp /tmp/test-doc.json \
  s3://${CLIENT_ID}-kb-data/documents/test-001.json \
  --region ap-southeast-2
```

### 7.2 Trigger KB sync and wait

```bash
DS_ID=$(aws bedrock list-data-sources \
  --knowledge-base-id $KB_ID \
  --region ap-southeast-2 \
  --query 'dataSourceSummaries[0].dataSourceId' --output text)

JOB_ID=$(aws bedrock start-ingestion-job \
  --knowledge-base-id $KB_ID \
  --data-source-id $DS_ID \
  --region ap-southeast-2 \
  --query 'ingestionJob.ingestionJobId' --output text)

while true; do
  STATUS=$(aws bedrock get-ingestion-job \
    --knowledge-base-id $KB_ID --data-source-id $DS_ID \
    --ingestion-job-id $JOB_ID --region ap-southeast-2 \
    --query 'ingestionJob.status' --output text)
  echo "Status: $STATUS"
  [[ "$STATUS" == "COMPLETE" || "$STATUS" == "FAILED" ]] && break
  sleep 10
done
```

### 7.3 Query with KB content

```bash
KB_SESSION=$(curl -s -X POST "${API_URL}/session" | jq -r '.sessionId')

curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"What data sources does the platform support?\", \"sessionId\": \"${KB_SESSION}\"}"
# Expected: SSE stream mentioning Strapi, Monday.com, Employment Hero with citation events
```

---

## 8. Observability Checks

### 8.1 CloudWatch Logs

```bash
aws logs tail "/aws/lambda/${CLIENT_ID}-chat" \
  --region ap-southeast-2 --since 1h --format short
```

### 8.2 Lambda invocation metrics

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value="${CLIENT_ID}-chat" \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 --statistics Sum --region ap-southeast-2
```

---

## 9. Content Ingestion Tests

### 9.1 Full sync via direct invocation

Syncs all collections across all configured data sources:

```bash
aws lambda invoke \
  --function-name "${CLIENT_ID}-ingestion" \
  --region ap-southeast-2 \
  --payload '{"type":"full-sync"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/sync-result.json

cat /tmp/sync-result.json | jq .
```

**Expected:**

```json
{
  "recordsProcessed": 0,
  "errors": [],
  "success": true,
  "resumed": false
}
```

`recordsProcessed` will be > 0 if your data source has published content.

### 9.2 Retrieve the webhook secret for testing

Each data source has its own webhook secret stored at `/{clientId}/secrets/datasource/{sourceId}`:

```bash
WEBHOOK_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "/${CLIENT_ID}/secrets/datasource/${SOURCE_ID}" \
  --region ap-southeast-2 \
  --query 'SecretString' --output text | jq -r '.webhookSecret')
echo "Webhook secret retrieved"
```

### 9.3 Webhook — valid secret

The `{source}` path parameter is the collection name or data source `id`:

```bash
PAYLOAD='{"event":"create","recordId":"test-wh-001","timestamp":"2026-07-22T00:00:00Z","data":{"title":"Test Article","body":"Test content."}}'

curl -s -X POST "${API_URL}/webhook/articles" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: test-event-001" \
  -d "$PAYLOAD" | jq .
```

**Expected (200):**

```json
{
  "message": "Webhook processed for source: articles",
  "status": "accepted",
  "eventId": "test-event-001"
}
```

### 9.4 Webhook — Strapi native payload (UID-based routing)

Strapi sends its own payload format including a `uid` field. The handler maps it to the correct collection automatically via the UID map:

```bash
STRAPI_PAYLOAD='{
  "event": "entry.create",
  "uid": "api::article.article",
  "entry": {
    "id": 42,
    "title": "New Article",
    "slug": "new-article",
    "updatedAt": "2026-07-22T01:00:00Z"
  }
}'

curl -s -X POST "${API_URL}/webhook/articles" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -d "$STRAPI_PAYLOAD" | jq .
# Expected (200): status "accepted"
```

### 9.5 Webhook — duplicate event (idempotence)

```bash
curl -s -X POST "${API_URL}/webhook/articles" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: test-event-001" \
  -d "$PAYLOAD" | jq .
# Expected (200): status "duplicate"
```

### 9.6 Webhook — invalid secret

```bash
curl -s -X POST "${API_URL}/webhook/articles" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: wrong-secret" \
  -d "$PAYLOAD" | jq .
# Expected (401): "Unauthorized: invalid secret"
```

### 9.7 Verify content landed in S3

```bash
aws s3 ls s3://${CLIENT_ID}-kb-data/documents/ --recursive --region ap-southeast-2
```

---

## 10. Admin API Tests

### 10.1 Get current configuration

```bash
curl -s "${API_URL}/admin/config" \
  -H "x-api-key: ${ADMIN_KEY}" | jq .
# Expected (200): current config including dataSources metadata (non-sensitive)
```

### 10.2 Get sync status

```bash
curl -s "${API_URL}/admin/sync-status" \
  -H "x-api-key: ${ADMIN_KEY}" | jq .
# Expected (200): per-collection sync state (status, lastFullSync, recordsIngested)
```

### 10.3 Trigger a sync via admin API

```bash
curl -s -X POST "${API_URL}/admin/sync/trigger" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ADMIN_KEY}" \
  -d '{"sourceType":"strapi"}' | jq .
# Expected (202): operationId and statusUrl
```

### 10.4 Get analytics

```bash
curl -s "${API_URL}/admin/analytics" \
  -H "x-api-key: ${ADMIN_KEY}" | jq .
# Expected (200): session counts, message totals, token usage
```

---

## 11. Webhook End-to-End Test

Full roundtrip: webhook → S3 → KB sync → chat returns new content.

### 11.1 Send a create event

```bash
E2E_PAYLOAD='{"event":"create","recordId":"e2e-001","timestamp":"2026-07-22T12:00:00Z","data":{"title":"Company Vacation Policy","body":"Employees get 20 days annual leave. Approval required 2 weeks in advance."}}'

curl -s -X POST "${API_URL}/webhook/articles" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: e2e-event-001" \
  -d "$E2E_PAYLOAD" | jq .
```

### 11.2 Wait for KB ingestion

```bash
sleep 60
aws bedrock list-ingestion-jobs \
  --knowledge-base-id $KB_ID \
  --data-source-id $DS_ID \
  --region ap-southeast-2 \
  --query 'ingestionJobSummaries[0].{status:status,startedAt:startedAt}' | jq .
```

### 11.3 Query the chatbot

```bash
E2E_SESSION=$(curl -s -X POST "${API_URL}/session" | jq -r '.sessionId')

curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"How many days of annual leave do employees get?\", \"sessionId\": \"${E2E_SESSION}\"}"
# Expected: SSE stream mentioning "20 days" with a citation event
```

### 11.4 Send a delete event

```bash
curl -s -X POST "${API_URL}/webhook/articles" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: e2e-event-002" \
  -d '{"event":"delete","recordId":"e2e-001","timestamp":"2026-07-22T12:30:00Z"}' | jq .

# Verify removed from S3
aws s3 ls s3://${CLIENT_ID}-kb-data/documents/e2e-001.json --region ap-southeast-2
# Expected: no output
```

---

## 12. Clean Up / Tear Down

```bash
cd infra && npx cdk destroy ManagedChatbot-${CLIENT_ID}
```

S3 and DynamoDB use `RemovalPolicy.DESTROY` and are cleaned up with the stack.

---

## 13. Troubleshooting

### `cdk deploy` fails: `Configuration validation failed: dataSources must be a non-empty array`

`deployment.json` still uses the old `dataSource` (singular) or `strapi` key. Migrate to the new format:

```json
{
  "dataSources": [
    {
      "id": "main-strapi",
      "type": "strapi",
      "apiEndpoint": "https://cms.example.com",
      "apiToken": "...",
      "webhookSecret": "...",
      "collections": []
    }
  ]
}
```

### Secrets Manager secret not found during Lambda invocation

The Lambda now looks up secrets at `/{clientId}/secrets/datasource/{sourceId}`. If you deployed before this change, your old secret lives at `/{clientId}/secrets/datasource`. Create a new secret at the correct path:

```bash
# Copy old secret value to new per-source path
OLD=$(aws secretsmanager get-secret-value \
  --secret-id "/${CLIENT_ID}/secrets/datasource" \
  --region ap-southeast-2 \
  --query 'SecretString' --output text)

aws secretsmanager create-secret \
  --name "/${CLIENT_ID}/secrets/datasource/${SOURCE_ID}" \
  --secret-string "$OLD" \
  --region ap-southeast-2
```

### Webhook returns 401 but secret looks correct

1. Confirm which source the webhook is hitting — check the `source` path param maps to a collection in `dataSources[].collections` or matches a `dataSources[].id`
2. The handler validates against the resolved source's secret. Verify the correct secret:
   ```bash
   aws secretsmanager get-secret-value \
     --secret-id "/${CLIENT_ID}/secrets/datasource/${SOURCE_ID}" \
     --region ap-southeast-2 \
     --query 'SecretString' --output text | jq .webhookSecret
   ```
3. Check for trailing newlines — use `printf` not `echo` when constructing test payloads.

### Webhook processed but wrong collection fetched (404 from Strapi)

The webhook handler now uses the Strapi `uid` field from the payload to resolve the collection name. Ensure:

- The payload contains a `uid` field matching the `strapiUid` in your collections config (e.g. `api::article.article`)
- Alternatively, use the collection name directly in the `{source}` path: `/webhook/articles`

### Full sync returns 0 records for some collections

The pipeline calls `adapter.listContent(pagination, collectionName)` — each collection is fetched separately. Verify:

- The `collections[].name` matches the actual Strapi API path (e.g. `articles` → `/api/articles`)
- The Strapi API token has read access to all collections
- Published items exist (`status: published` in Strapi)

### Full sync records have wrong `sourceType`

This was a prior bug (fixed). If you see `sourceType` mismatch in S3 documents, re-run a full sync — the pipeline now correctly passes `collectionName` to the adapter on each iteration.

### `cdk deploy` fails: `dataSource.apiEndpoint must be a non-empty string`

This error comes from the CDK-side config loader (`lib/config/config-loader.ts`), which is separate from the Lambda config loader. The CDK loader also expects `dataSources[]` — make sure you're running the latest CDK code. Pull the latest changes and rebuild:

```bash
cd infra && npm run build && npx cdk synth
```

### Chat returns no-answer fallback after uploading documents

1. Confirm the ingestion job completed: `COMPLETE` status (section 7.2)
2. Check the document is under `documents/` prefix, not the bucket root
3. Allow 1–2 minutes after `COMPLETE` for the index to be queryable
4. Relevance threshold is 0.3 by default (`confidenceThreshold` in `deployment.json`) — lower it if needed

### Lambda cold start > 3 seconds

Expected on first invocation. If warm invocations are also slow:

- Confirm Lambda memory is 512MB (section 3.2)
- Confirm Bedrock KB status is `ACTIVE` (section 3.4)

### CloudWatch logs show `Configuration validation failed` at cold start

The Lambda validates `deployment.json` on every cold start. Read the full error message in the logs — it lists every invalid field with a dot-path (e.g. `dataSources[0].apiEndpoint: must be a string starting with http://...`). Fix `deployment.json` and redeploy.
