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
9. [Phase 2 - Content Ingestion Tests](#9-phase-2---content-ingestion-tests)
10. [Phase 2 - Admin API Tests](#10-phase-2---admin-api-tests)
11. [Phase 2 - Webhook End-to-End Test](#11-phase-2---webhook-end-to-end-test)
12. [Clean Up / Tear Down](#12-clean-up--tear-down)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Pre-Deployment Checklist

Run through this before touching AWS.

```bash
# Node version must be 20.x
node --version     # v20.x.x

# AWS CLI authenticated
aws sts get-caller-identity

# CDK version
npx cdk --version  # 2.x

# All unit tests green
cd infra && npm test
# Expected: Tests: 268 passed, 268 total
```

**Bedrock model access** — verify in the AWS Console (ap-southeast-2):

- Amazon Bedrock → Model access
- `Anthropic Claude 3 Haiku` → Access granted ✓

---

## 2. Deploy the Stack

```bash
# From the repo root
cd infra

# Validate config before deploying
npx ts-node -e "require('./lib/config').loadConfig('./config/deployment.json'); console.log('Config OK')"

# Synthesise first (dry run, no AWS calls)
npx cdk synth

# Deploy — takes 5–10 min, mostly the Bedrock KB
npx cdk deploy --require-approval never
```

### Capture the outputs

After deploy completes, CDK prints the API endpoint. Save it:

```bash
export API_URL="https://XXXX.execute-api.ap-southeast-2.amazonaws.com"
export WIDGET_KEY="wk-your-widget-key"   # from deployment.json apiKeys.appKey
export CLIENT_ID="my-client"              # from deployment.json clientId
```

You'll use `$API_URL`, `$WIDGET_KEY`, and `$CLIENT_ID` throughout the rest of this runbook.

---

## 3. Post-Deployment Verification

Verify the key resources exist before running API tests.

### 3.1 CloudFormation stack status

```bash
aws cloudformation describe-stacks \
  --stack-name "ManagedChatbot-${CLIENT_ID}" \
  --region ap-southeast-2 \
  --query 'Stacks[0].StackStatus'
# Expected: "CREATE_COMPLETE"
```

### 3.2 Chat Lambda exists and is active

```bash
aws lambda get-function \
  --function-name "${CLIENT_ID}-chat" \
  --region ap-southeast-2 \
  --query 'Configuration.[FunctionName,State,Runtime,MemorySize]'
# Expected: ["my-client-chat", "Active", "nodejs20.x", 512]
```

### 3.3 S3 bucket exists

```bash
aws s3 ls s3://${CLIENT_ID}-kb-data/
# Expected: no error (bucket accessible)
```

### 3.4 DynamoDB table active

```bash
aws dynamodb list-tables --region ap-southeast-2 \
  --query "TableNames[?contains(@, 'Sessions')]"
# Expected: table name containing "Sessions"
```

### 3.5 Bedrock Knowledge Base created

```bash
aws bedrock list-knowledge-bases --region ap-southeast-2 \
  --query "knowledgeBaseSummaries[?name=='${CLIENT_ID}-knowledge-base'].{name:name,status:status}"
# Expected: [{"name": "my-client-knowledge-base", "status": "ACTIVE"}]
```

Save the KB ID for later:

```bash
export KB_ID=$(aws bedrock list-knowledge-bases --region ap-southeast-2 \
  --query "knowledgeBaseSummaries[?name=='${CLIENT_ID}-knowledge-base'].knowledgeBaseId" \
  --output text)
echo "KB ID: $KB_ID"
```

### 3.6 Parameter Store entries exist

```bash
aws ssm get-parameters-by-path \
  --path "/${CLIENT_ID}/config" \
  --region ap-southeast-2 \
  --query "Parameters[].Name"
# Expected: 4 entries — ratelimits, session, datasource, monitoring
```

### 3.7 Secrets Manager secrets exist

```bash
aws secretsmanager list-secrets --region ap-southeast-2 \
  --query "SecretList[?starts_with(Name, '/${CLIENT_ID}/')].Name"
# Expected: ["/{clientId}/secrets/api-keys", "/{clientId}/secrets/datasource"]
```

---

## 4. API Tests (curl)

All tests use `$API_URL` and `$WIDGET_KEY` set in section 2.

### Test 1: Create a session

```bash
curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" | jq .
```

**Expected response (201):**

```json
{
  "sessionId": "<64-char hex string>",
  "token": "<64-char hex string>"
}
```

Save the session ID:

```bash
SESSION_RESPONSE=$(curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}")
SESSION_ID=$(echo $SESSION_RESPONSE | jq -r '.sessionId')
echo "Session ID: $SESSION_ID"
```

### Test 2: Get session status

```bash
curl -s -X GET "${API_URL}/session/${SESSION_ID}" \
  -H "x-api-key: ${WIDGET_KEY}" | jq .
```

**Expected response (200):**

```json
{
  "sessionId": "...",
  "status": "active",
  "turnCount": 0,
  "tokensUsed": 0,
  "createdAt": "2026-...",
  "lastActiveAt": "2026-..."
}
```

### Test 3: Send a chat message (no KB content yet — fallback path)

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"Hello, what can you help me with?\", \"sessionId\": \"${SESSION_ID}\"}"
```

**Expected:** SSE-formatted response body with the no-answer fallback (since KB has no documents yet):

```
data: {"type":"token","data":"I'm "}
data: {"type":"token","data":"sorry, ..."}
...
data: {"type":"done","data":{"sessionId":"...","turnCount":1,"tokensUsed":1}}
```

The `done` event confirms the session persisted (turnCount incremented to 1).

### Test 4: Validate session state updated in DynamoDB

```bash
curl -s -X GET "${API_URL}/session/${SESSION_ID}" \
  -H "x-api-key: ${WIDGET_KEY}" | jq .turnCount
# Expected: 1
```

### Test 5: Message length validation — empty message

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"\", \"sessionId\": \"${SESSION_ID}\"}" | jq .
```

**Expected (400):**

```json
{ "message": "Message must be between 1 and 2000 characters" }
```

### Test 6: Message length validation — over 2000 characters

```bash
LONG_MSG=$(python3 -c "print('x'*2001)")
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"${LONG_MSG}\", \"sessionId\": \"${SESSION_ID}\"}" | jq .
```

**Expected (400):**

```json
{ "message": "Message must be between 1 and 2000 characters" }
```

### Test 7: Invalid session ID

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d '{"message": "test", "sessionId": "nonexistent-session-id"}' | jq .
```

**Expected (401):**

```json
{ "message": "session_expired" }
```

### Test 8: Missing sessionId in chat request

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d '{"message": "test"}' | jq .
```

**Expected (400):**

```json
{ "message": "sessionId is required" }
```

### Test 9: Unknown route

```bash
curl -s -X GET "${API_URL}/not-a-real-route" | jq .
```

**Expected (404):**

```json
{ "message": "Not found" }
```

---

## 5. Widget Smoke Test

### 5.1 Configure

```bash
cp app/.env.example app/.env.local
```

Set `NEXT_PUBLIC_API_ENDPOINT` to your `$API_URL`. All other values can stay as defaults.

### 5.2 Run the widget locally

```bash
cd app && npm run dev
```

Open http://localhost:3000

### 5.3 Visual checks

- [ ] Chat bubble renders bottom-right
- [ ] Bubble meets 44×44px minimum click target
- [ ] No horizontal overflow at narrow viewport (resize to ~375px wide)
- [ ] Expand/collapse animation completes in under 300ms (eyeball it)
- [ ] Shadow DOM isolation — open DevTools → Elements → find `#chatbot-shadow-root`; widget styles should be scoped inside it

### 5.4 Functional checks (no KB content — fallback responses)

1. Click the bubble to expand
2. Type any message and send
3. Verify a fallback message streams in ("I'm sorry, I don't have enough information…")
4. Send another message — verify the previous one stays in the chat history
5. Check the turn counter increments in DynamoDB (run Test 2 from section 4 after each message)

### 5.5 Error state checks

**Rate-limit UI** — temporarily reduce the rate limit, spam messages until you hit 429. Verify a countdown timer appears.

**Session exhausted UI** — create a session with `turnLimit: 1` in the body and send 2 messages. Verify the "session exhausted" message appears with a New Session button.

---

## 6. Session State Machine Tests

These verify the state machine logic using the live API. Create a fresh session for each test.

### Test A: Session expiry

Create a session with a 1-minute duration:

```bash
EXPIRED_SESSION=$(curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d '{"sessionDuration": 1}' | jq -r '.sessionId')
echo "Session: $EXPIRED_SESSION"
```

Wait 65 seconds, then send a chat:

```bash
sleep 65
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"hello\", \"sessionId\": \"${EXPIRED_SESSION}\"}" | jq .
```

**Expected (401):**

```json
{ "errorCode": "session_expired", "message": "Session expired after 1 minutes" }
```

### Test B: Turn limit exhaustion

```bash
TURN_SESSION=$(curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d '{"turnLimit": 2}' | jq -r '.sessionId')

# Send 2 messages (uses up both turns)
for i in 1 2; do
  curl -s -X POST "${API_URL}/chat" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${WIDGET_KEY}" \
    -d "{\"message\": \"turn $i\", \"sessionId\": \"${TURN_SESSION}\"}" > /dev/null
  echo "Turn $i sent"
done

# 3rd message should be rejected
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"turn 3\", \"sessionId\": \"${TURN_SESSION}\"}" | jq .
```

**Expected (401):**

```json
{
  "errorCode": "session_exhausted",
  "message": "Session exhausted: turn limit of 2 reached"
}
```

### Test C: Terminal state is absorbing

After Test B, the session is exhausted. Verify it rejects all further requests:

```bash
curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"still trying\", \"sessionId\": \"${TURN_SESSION}\"}" | jq .
# Expected: same 401 session_exhausted — no state change
```

---

## 7. Knowledge Base Upload & Query Test

This confirms Bedrock retrieval works end-to-end once you have content.

### 7.1 Upload a test document

```bash
# Create a test document
cat > /tmp/test-doc.json << 'EOF'
{
  "recordId": "test-001",
  "contentBody": "The managed chatbot platform supports three data sources: Strapi CMS, Monday.com, and Employment Hero. All content is indexed in Amazon Bedrock Knowledge Base for RAG retrieval.",
  "contentType": "text/plain",
  "sourceType": "strapi",
  "metadata": {
    "clientId": "my-client",
    "title": "Platform Overview",
    "lastModified": "2026-07-20T00:00:00Z"
  }
}
EOF

# Upload to the documents/ prefix
aws s3 cp /tmp/test-doc.json \
  s3://${CLIENT_ID}-kb-data/documents/test-001.json \
  --region ap-southeast-2
```

### 7.2 Trigger a Knowledge Base sync

```bash
# Find the data source ID
DS_ID=$(aws bedrock list-data-sources \
  --knowledge-base-id $KB_ID \
  --region ap-southeast-2 \
  --query 'dataSourceSummaries[0].dataSourceId' \
  --output text)

# Start ingestion job
JOB_ID=$(aws bedrock start-ingestion-job \
  --knowledge-base-id $KB_ID \
  --data-source-id $DS_ID \
  --region ap-southeast-2 \
  --query 'ingestionJob.ingestionJobId' \
  --output text)
echo "Ingestion job: $JOB_ID"
```

### 7.3 Wait for ingestion to complete

```bash
while true; do
  STATUS=$(aws bedrock get-ingestion-job \
    --knowledge-base-id $KB_ID \
    --data-source-id $DS_ID \
    --ingestion-job-id $JOB_ID \
    --region ap-southeast-2 \
    --query 'ingestionJob.status' --output text)
  echo "Status: $STATUS"
  [[ "$STATUS" == "COMPLETE" ]] && break
  [[ "$STATUS" == "FAILED" ]] && echo "FAILED — check ingestion job details" && break
  sleep 10
done
```

### 7.4 Query with KB content

Create a new session and ask about the uploaded content:

```bash
KB_SESSION=$(curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" | jq -r '.sessionId')

curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"What data sources does the platform support?\", \"sessionId\": \"${KB_SESSION}\"}"
```

**Expected:** SSE stream containing:

- `citation` events referencing `test-001` with a relevance score ≥ 0.5
- `token` events with an answer mentioning Strapi, Monday.com, Employment Hero
- Exactly one `done` event at the end

If you get the no-answer fallback, the ingestion hasn't completed yet — wait another minute and retry.

---

## 8. Observability Checks

### 8.1 CloudWatch Logs

```bash
# View recent Chat Lambda log events
aws logs tail "/aws/lambda/${CLIENT_ID}-chat" \
  --region ap-southeast-2 \
  --since 1h \
  --format short
```

Every request should emit a structured JSON log line with at minimum:

```json
{
  "level": "INFO",
  "message": "Chat Lambda invoked",
  "routeKey": "POST /chat",
  "path": "/chat"
}
```

### 8.2 Lambda invocation metrics

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value="${CLIENT_ID}-chat" \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 \
  --statistics Sum \
  --region ap-southeast-2
```

Should reflect the number of API calls you made during testing.

### 8.3 DynamoDB metrics

```bash
# Get table name
TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "ManagedChatbot-${CLIENT_ID}" \
  --region ap-southeast-2 \
  --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" \
  --output text)
echo "Table: $TABLE"

# Scan a few items to confirm session records are there
aws dynamodb scan \
  --table-name $TABLE \
  --region ap-southeast-2 \
  --max-items 5 \
  --query "Items[].{PK:PK.S, status:status.S, turnCount:turnCount.N}"
```

---

## 9. Phase 2 - Content Ingestion Tests

These tests verify the ingestion pipeline, data source adapters, and webhook handling.

### Setup

```bash
# Additional env vars for Phase 2 testing
export ADMIN_KEY="ak-your-admin-key"  # from deployment.json apiKeys.adminKey
```

### 9.1 Verify Ingestion Lambda exists

```bash
aws lambda get-function \
  --function-name "${CLIENT_ID}-ingestion" \
  --region ap-southeast-2 \
  --query 'Configuration.[FunctionName,State,Runtime]'
# Expected: ["my-client-ingestion", "Active", "nodejs20.x"]
```

### 9.2 Verify Webhook Dedup table exists

```bash
aws dynamodb list-tables --region ap-southeast-2 \
  --query "TableNames[?contains(@, 'WebhookDedup')]"
# Expected: table name containing "WebhookDedup"
```

### 9.3 Full sync via direct invocation

Trigger a full sync (syncs all Strapi collections: intranet-pages, intranet-teams, intranet-people):

```bash
aws lambda invoke \
  --function-name "${CLIENT_ID}-ingestion" \
  --region ap-southeast-2 \
  --payload '{"type":"full-sync"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/sync-result.json

cat /tmp/sync-result.json | jq .
```

**Expected response:**

```json
{
  "recordsProcessed": 0,
  "errors": [],
  "success": true,
  "resumed": false
}
```

> If your Strapi instance has published content in any of the collections, `recordsProcessed` will be > 0. Pages/teams/people with only non-text blocks (photo galleries, etc.) may be skipped.

### 9.4 Webhook - valid secret

Send a webhook with the shared secret in the `x-webhook-secret` header:

```bash
WEBHOOK_SECRET="webhook-friedrice-secret"  # from deployment.json dataSource.webhookSecret
PAYLOAD='{"event":"create","recordId":"test-webhook-001","timestamp":"2026-07-22T00:00:00Z","data":{"title":"Test Article","body":"Content for testing webhook ingestion."}}'

curl -s -X POST "${API_URL}/webhook/strapi" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: test-event-001" \
  -d "$PAYLOAD" | jq .
```

**Expected (200):**

```json
{
  "message": "Webhook processed for source: strapi",
  "status": "accepted",
  "eventId": "test-event-001"
}
```

### 9.5 Webhook - duplicate event (idempotence)

Send the same event ID again:

```bash
curl -s -X POST "${API_URL}/webhook/strapi" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: test-event-001" \
  -d "$PAYLOAD" | jq .
```

**Expected (200):**

```json
{
  "message": "Event already processed",
  "status": "duplicate"
}
```

### 9.6 Webhook - invalid secret

```bash
curl -s -X POST "${API_URL}/webhook/strapi" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -H "x-webhook-secret: wrong-secret-value" \
  -H "x-webhook-id: test-event-002" \
  -d '{"event":"create","recordId":"r2","timestamp":"2026-07-22T00:00:00Z"}' | jq .
```

**Expected (401):**

```json
{ "error": "Unauthorized: invalid secret" }
```

### 9.7 Webhook - missing secret header

```bash
curl -s -X POST "${API_URL}/webhook/strapi" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d '{"event":"create","recordId":"r3","timestamp":"2026-07-22T00:00:00Z"}' | jq .
```

**Expected (401):**

```json
{ "error": "Unauthorized: missing secret" }
```

### 9.8 Verify content landed in S3

After a successful webhook create event:

```bash
aws s3 ls s3://${CLIENT_ID}-kb-data/documents/ --region ap-southeast-2
# Should list the document file for the webhook record
```

### 9.8b Webhook - intranet-pages collection

Send a webhook event for an intranet page. The webhook path uses the collection name (`/webhook/intranet-pages`):

```bash
INTRANET_PAYLOAD='{"event":"create","recordId":"intranet-page-001","timestamp":"2026-07-22T01:00:00Z","data":{"name":"Company Benefits","slug":"company-benefits","summary":"Overview of employee benefits and perks."}}'

curl -s -X POST "${API_URL}/webhook/intranet-pages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: intranet-event-001" \
  -d "$INTRANET_PAYLOAD" | jq .
```

**Expected (200):**

```json
{
  "message": "Webhook processed for source: intranet-pages",
  "status": "accepted",
  "eventId": "intranet-event-001"
}
```

Verify the document landed in S3:

```bash
aws s3 ls s3://${CLIENT_ID}-kb-data/documents/intranet-page-001.json --region ap-southeast-2
# Expected: file exists
```

### 9.9 Verify dedup entry in DynamoDB

```bash
DEDUP_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "ManagedChatbot-${CLIENT_ID}" \
  --region ap-southeast-2 \
  --query "StackResources[?LogicalResourceId=='WebhookDedupTableTable1C25C6E0'].PhysicalResourceId" \
  --output text)

aws dynamodb get-item \
  --table-name "$DEDUP_TABLE" \
  --key '{"PK":{"S":"WEBHOOK#strapi#test-event-001"},"SK":{"S":"DEDUP"}}' \
  --region ap-southeast-2 | jq .
```

**Expected:** Item exists with `processedAt` timestamp.

---

## 10. Phase 2 - Admin API Tests

### 10.1 Get current configuration

```bash
curl -s -X GET "${API_URL}/admin/config" \
  -H "x-api-key: ${ADMIN_KEY}" | jq .
```

**Expected (200):** JSON object with current client configuration (rate limits, session, data source, monitoring settings).

### 10.2 Update configuration

```bash
curl -s -X PUT "${API_URL}/admin/config" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ADMIN_KEY}" \
  -d '{"session":{"turnLimit":100}}' | jq .
```

**Expected (200):** Confirmation of the update.

### 10.3 Invalid configuration update

```bash
curl -s -X PUT "${API_URL}/admin/config" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ADMIN_KEY}" \
  -d '{"session":{"turnLimit":-1}}' | jq .
```

**Expected (400):** Validation error identifying the invalid field.

### 10.4 Get sync status

```bash
curl -s -X GET "${API_URL}/admin/sync-status" \
  -H "x-api-key: ${ADMIN_KEY}" | jq .
```

**Expected (200):** Sync state report including last sync time, status, records ingested.

### 10.5 Trigger a sync

```bash
curl -s -X POST "${API_URL}/admin/sync/trigger" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ADMIN_KEY}" \
  -d '{"sourceType":"strapi"}' | jq .
```

**Expected (202):** Async operation status with an `operationId` and `statusUrl` for polling. This syncs all Strapi collections (intranet-pages, intranet-teams, intranet-people).

### 10.6 Get analytics

```bash
curl -s -X GET "${API_URL}/admin/analytics" \
  -H "x-api-key: ${ADMIN_KEY}" | jq .
```

**Expected (200):** Analytics summary (chat sessions, message counts, token usage).

### 10.7 Verify Admin Lambda exists

```bash
aws lambda get-function \
  --function-name "${CLIENT_ID}-admin" \
  --region ap-southeast-2 \
  --query 'Configuration.[FunctionName,State,Runtime,MemorySize]'
# Expected: ["my-client-admin", "Active", "nodejs20.x", 128]
```

---

## 11. Phase 2 - Webhook End-to-End Test

This is the full roundtrip: webhook event → ingestion → KB sync → chat query returns new content.

### 11.1 Send a webhook create event with real content

```bash
E2E_PAYLOAD='{"event":"create","recordId":"e2e-test-001","timestamp":"2026-07-22T12:00:00Z","data":{"title":"Company Vacation Policy","body":"Employees are entitled to 20 days of annual leave. Leave must be approved by the direct manager at least 2 weeks in advance. Unused leave carries over up to a maximum of 5 days."}}'

curl -s -X POST "${API_URL}/webhook/strapi" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: e2e-test-event-001" \
  -d "$E2E_PAYLOAD" | jq .
```

### 11.2 Wait for KB to index the new document

The webhook handler triggers a Bedrock KB sync. Wait for it to complete:

```bash
# Check ingestion job status (may take 30-60 seconds)
DS_ID=$(aws bedrock list-data-sources \
  --knowledge-base-id $KB_ID \
  --region ap-southeast-2 \
  --query 'dataSourceSummaries[0].dataSourceId' --output text)

sleep 60  # Allow time for the ingestion job to complete

aws bedrock list-ingestion-jobs \
  --knowledge-base-id $KB_ID \
  --data-source-id $DS_ID \
  --region ap-southeast-2 \
  --query 'ingestionJobSummaries[0].{status:status,startedAt:startedAt}' | jq .
```

### 11.3 Query the chatbot about the new content

```bash
E2E_SESSION=$(curl -s -X POST "${API_URL}/session" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" | jq -r '.sessionId')

curl -s -X POST "${API_URL}/chat" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -d "{\"message\": \"How many days of annual leave do employees get?\", \"sessionId\": \"${E2E_SESSION}\"}"
```

**Expected:** SSE stream containing:

- `token` events with an answer mentioning "20 days of annual leave"
- `citation` events referencing the vacation policy document
- A `done` event

If you get the no-answer fallback, the KB hasn't finished indexing yet. Wait another minute and retry.

### 11.4 Verify webhook delete removes content

```bash
DELETE_PAYLOAD='{"event":"delete","recordId":"e2e-test-001","timestamp":"2026-07-22T12:30:00Z"}'

curl -s -X POST "${API_URL}/webhook/strapi" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${WIDGET_KEY}" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -H "x-webhook-id: e2e-test-event-002" \
  -d "$DELETE_PAYLOAD" | jq .
```

**Expected (200):** `"status": "accepted"`

Verify the document is gone from S3:

```bash
aws s3 ls s3://${CLIENT_ID}-kb-data/documents/e2e-test-001.json --region ap-southeast-2
# Expected: no output (file deleted)
```

---

## 12. Clean Up / Tear Down

> Only do this if you're fully done with testing.

```bash
cd infra && npx cdk destroy ManagedChatbot-${CLIENT_ID}
```

The stack uses `RemovalPolicy.DESTROY` for S3 and DynamoDB, so all resources will be cleaned up with the stack. If you've changed removal policies to RETAIN, delete remaining resources manually:

```bash
# Empty then delete the bucket (only if RETAIN)
aws s3 rm s3://${CLIENT_ID}-kb-data --recursive
aws s3 rb s3://${CLIENT_ID}-kb-data

# Delete DynamoDB tables (only if RETAIN)
aws dynamodb delete-table --table-name $SESSIONS_TABLE --region ap-southeast-2
aws dynamodb delete-table --table-name $DEDUP_TABLE --region ap-southeast-2
```

---

## 13. Troubleshooting

### `cdk deploy` fails: "Resource handler returned message: Stabilization failed"

Usually the Bedrock Knowledge Base. Wait a few minutes and retry — Bedrock KB creation can take longer than CloudFormation's default wait.

### `403 Forbidden` on API calls

The HTTP API Gateway doesn't have API key enforcement wired in Phase 1 (that's task 10.1 in Phase 3). If you're seeing 403, check that the Lambda integration was deployed correctly:

```bash
aws apigatewayv2 get-routes \
  --api-id $(aws apigatewayv2 get-apis --region ap-southeast-2 \
    --query "Items[?Name=='${CLIENT_ID}-chatbot-api'].ApiId" --output text) \
  --region ap-southeast-2 \
  --query "Items[].{Route:RouteKey,Target:Target}"
```

Should list 11 routes: `POST /chat`, `POST /session`, `GET /session/{sessionId}`, `POST /webhook/{source}`, `POST /ingest/record`, `DELETE /ingest/record/{recordId}`, `GET /admin/config`, `PUT /admin/config`, `GET /admin/sync-status`, `POST /admin/sync/trigger`, `GET /admin/analytics`.

### Chat returns no-answer fallback even after uploading a document

1. Check the ingestion job completed: `COMPLETE` status (section 7.3)
2. Verify the document is under `documents/` prefix (not the bucket root)
3. Allow 1–2 minutes after `COMPLETE` for the index to be queryable
4. Check the relevance score — if your question doesn't match the content semantically, it will fall below the 0.5 threshold

### `session_expired` immediately after creating a session

Check your system clock. The session validator uses `new Date()` on the Lambda side. If there's significant clock skew between your machine and AWS, it's cosmetic — the Lambda clock is correct.

### Lambda cold start > 3 seconds

Expected on first invocation after deploy. Warm invocations should serve the first token within 3 seconds. If warm invocations are slow:

- Check the Lambda memory is 512MB (section 3.2)
- Check Bedrock KB status is `ACTIVE` (section 3.5)

### CloudWatch logs show `SESSIONS_TABLE_NAME environment variable is not set`

The Lambda environment variable isn't wired. Re-run `cdk deploy` — this shouldn't happen with a clean deploy.

### App: `API endpoint is not configured`

Check `app/.env.local` has `NEXT_PUBLIC_API_ENDPOINT` set (no trailing slash) and restart the dev server (`Ctrl+C`, `npm run dev`).

### Webhook returns 401 but signature looks correct

Common causes:

1. **Trailing newline** in the payload — `echo` adds a newline by default. Use `echo -n` or `printf` when generating the HMAC.
2. **Wrong secret** — the webhook secret is read from Secrets Manager at `/{clientId}/secrets/datasource` (the `webhookSecret` field). Verify it matches what you're using locally:
   ```bash
   aws secretsmanager get-secret-value \
     --secret-id "/${CLIENT_ID}/secrets/datasource" \
     --region ap-southeast-2 \
     --query 'SecretString' --output text | jq .webhookSecret
   ```
3. **Content-Type mismatch** — ensure you're sending `application/json` and the body is valid JSON.

### Full sync times out or returns incomplete results

The Ingestion Lambda has a 15-minute timeout for full syncs. If your data source has thousands of records:

- Check sync progress in DynamoDB (look for `SYNC#strapi` partition key)
- The pipeline resumes from the last checkpoint on the next invocation
- Increase `dataSource.pageSize` (up to 500) to reduce API round-trips

### Webhook event processed but content not in KB

The webhook handler triggers a Bedrock KB sync after persisting to S3. The sync takes 30-60 seconds:

1. Verify the document landed in S3: `aws s3 ls s3://${CLIENT_ID}-kb-data/documents/`
2. Check the latest ingestion job status (section 11.2)
3. If the ingestion job shows `FAILED`, check the job details for specifics

### Admin endpoints return 404

Verify the Admin Lambda is wired correctly:

```bash
aws lambda get-function \
  --function-name "${CLIENT_ID}-admin" \
  --region ap-southeast-2 \
  --query 'Configuration.State'
# Expected: "Active"
```

If the Lambda exists but routes return 404, check API Gateway route integrations point to the correct Lambda ARN.

### Dedup table not recording entries

The dedup entry is only written after successful processing (Requirement 6.7). If the webhook returns 200 but no dedup entry appears:

1. Check CloudWatch logs for the Ingestion Lambda for errors during `recordProcessed`
2. Verify the DynamoDB table has the correct schema (PK: String, SK: String, TTL configured)

### Data source adapter returns empty results

- Verify the data source credentials in Secrets Manager are correct
- Check the `baseUrl` is accessible from the Lambda (no VPC restrictions)
- For Strapi: ensure the collection name is correct and has published content
- For Monday.com/Employment Hero: verify the API token has read permissions

### Intranet-pages sync returns 0 records or skips pages

The intranet-pages adapter extracts text from `content_blocks` dynamic zones. Pages are skipped when no extractable text is found:

1. **No text content in blocks** - pages with only photo galleries, video blocks, or voting blocks have no text to extract. These are intentionally skipped.
2. **Strapi API not returning content_blocks** - verify the API token has permission to read the `intranet-pages` collection with relations populated. Test manually:
   ```bash
   curl -s "https://your-cms.com/api/intranet-pages?populate[content_blocks][populate]=*" \
     -H "Authorization: Bearer YOUR_TOKEN" | jq '.data[0].attributes.content_blocks'
   ```
3. **Content too large** - individual records with content exceeding 1MB are skipped. Check CloudWatch logs for "Failed to persist record" errors.
4. **Missing updatedAt** - pages without `updatedAt` or `createdAt` timestamps are skipped (validation requirement).
