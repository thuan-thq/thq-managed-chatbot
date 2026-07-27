/**
 * Ingestion Lambda handler.
 *
 * Routes API Gateway v2 events to the appropriate sub-handler
 * based on the request path and HTTP method. Also supports direct
 * invocation for triggering full sync operations.
 *
 * Routes:
 * - POST /webhook/{source}          - Webhook receiver for data source events
 * - POST /ingest/record             - Manual record ingestion
 * - DELETE /ingest/record/{recordId} - Delete an ingested record
 *
 * Direct invocation:
 * - { type: "full-sync", sourceType?: string } - Trigger full sync
 */

import { createHash } from "crypto";
import { validateWebhookSecret } from "./webhook-validator";
import { isDuplicate, recordProcessed } from "./dedup-service";
import { FullSyncPipeline, FullSyncResult } from "./sync-pipeline";
import { S3ContentClient } from "./s3-client";
import { SyncStateClient } from "./dynamo-client";
import { BedrockSyncClient } from "./bedrock-client";
import { StrapiAdapter } from "./strapi-adapter";
import { RetryHttpClient } from "./http-client";
import {
  WebhookEventRouter,
  WebhookPayload as RouterPayload,
} from "./event-router";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// ---- API Gateway v2 event type (HTTP API payload format 2.0) ----

interface APIGatewayV2Event {
  routeKey?: string;
  rawPath?: string;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
      sourceIp?: string;
    };
  };
  pathParameters?: Record<string, string>;
  body?: string | null;
  headers?: Record<string, string>;
}

/** Direct invocation event for triggering sync operations. */
interface DirectInvocationEvent {
  type: "full-sync";
  sourceType?: string;
}

/** Union of all possible event shapes. */
type LambdaEvent = APIGatewayV2Event | DirectInvocationEvent;

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ---- Webhook payload type ----

interface WebhookPayload {
  event: "create" | "update" | "delete";
  recordId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  /** Collection derived from Strapi uid (e.g. "intranet-pages" from "api::intranet-page.intranet-page") */
  collection?: string;
}

// ---- Secrets cache ----

const secretsClient = new SecretsManagerClient({});
let cachedWebhookSecret: string | null = null;
let cachedDataSourceSecrets: Record<string, string> | null = null;

/**
 * Retrieves the webhook secret from Secrets Manager.
 * Caches the result for the lifetime of the Lambda execution context.
 */
async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) {
    return cachedWebhookSecret;
  }

  const secrets = await getDataSourceSecrets();
  cachedWebhookSecret = secrets.webhookSecret;

  if (!cachedWebhookSecret) {
    throw new Error("webhookSecret field missing from secret");
  }

  return cachedWebhookSecret;
}

/**
 * Retrieves the full data source secrets object from Secrets Manager.
 * Caches the result for the lifetime of the Lambda execution context.
 * Contains: webhookSecret, baseUrl, apiToken, collection, etc.
 */
async function getDataSourceSecrets(): Promise<Record<string, string>> {
  if (cachedDataSourceSecrets) {
    return cachedDataSourceSecrets;
  }

  const clientId = process.env.CLIENT_ID ?? "";
  const secretId = `/${clientId}/secrets/datasource`;

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!response.SecretString) {
    throw new Error("Data source secret not found in Secrets Manager");
  }

  cachedDataSourceSecrets = JSON.parse(response.SecretString);
  return cachedDataSourceSecrets!;
}

// ---- Main handler ----

/**
 * Main Lambda handler entry point.
 * Accepts API Gateway v2 (HTTP API) payload format or direct invocation events.
 */
export async function handler(
  event: LambdaEvent,
): Promise<LambdaResponse | FullSyncResult> {
  // Handle direct invocation for full sync
  if (isDirectInvocation(event)) {
    return await handleFullSync(event);
  }

  const apiEvent = event as APIGatewayV2Event;
  const method = apiEvent.requestContext?.http?.method ?? "";
  const path = apiEvent.requestContext?.http?.path ?? "";

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Ingestion Lambda invoked",
      routeKey: apiEvent.routeKey,
      path,
      method,
    }),
  );

  try {
    // POST /webhook/{source}
    if (method === "POST" && path.startsWith("/webhook/")) {
      const source = apiEvent.pathParameters?.source;
      if (!source) {
        return jsonResponse(400, { error: "Missing source parameter" });
      }
      return await handleWebhook(apiEvent, source);
    }

    // POST /ingest/record
    if (method === "POST" && path === "/ingest/record") {
      return await handleIngestRecord(apiEvent);
    }

    // DELETE /ingest/record/{recordId}
    if (method === "DELETE" && path.startsWith("/ingest/record/")) {
      const recordId = apiEvent.pathParameters?.recordId;
      if (!recordId) {
        return jsonResponse(400, { error: "Missing recordId parameter" });
      }
      return await handleDeleteRecord(apiEvent, recordId);
    }

    return jsonResponse(404, { error: "Not found" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Unhandled error:", message);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

// ---- Direct invocation helpers ----

/**
 * Type guard for direct invocation events.
 */
function isDirectInvocation(
  event: LambdaEvent,
): event is DirectInvocationEvent {
  return (
    "type" in event && (event as DirectInvocationEvent).type === "full-sync"
  );
}

/**
 * Strapi collections to ingest. Managed in code - add new collections here.
 */
const STRAPI_COLLECTIONS = [
  "intranet-pages",
  "intranet-teams",
  "intranet-people",
];

/**
 * Maps Strapi content-type uid prefixes to the actual REST API collection name.
 * Strapi uid format: "api::intranet-person.intranet-person"
 * Naive pluralization (appending "s") doesn't work for irregular plurals.
 */
const STRAPI_UID_TO_COLLECTION: Record<string, string> = {
  "intranet-page": "intranet-pages",
  "intranet-team": "intranet-teams",
  "intranet-person": "intranet-people",
};

/**
 * Handle a full sync direct invocation.
 *
 * For Strapi sources, iterates over all configured collections
 * (articles, intranet-pages) and syncs each one. A specific collection
 * can be targeted via the `collection` field in the event payload.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
async function handleFullSync(
  event: DirectInvocationEvent,
): Promise<FullSyncResult> {
  const sourceType = event.sourceType ?? "strapi";
  const clientId = process.env.CLIENT_ID ?? "";
  const bucketName = process.env.DATA_BUCKET_NAME ?? "";
  const tableName = process.env.SESSIONS_TABLE_NAME ?? "";
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID ?? "";
  const dataSourceId = process.env.DATA_SOURCE_ID ?? "";

  // Retrieve data source credentials from Secrets Manager
  const secretId = `/${clientId}/secrets/datasource`;
  const secretResponse = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!secretResponse.SecretString) {
    throw new Error("Data source secret not found in Secrets Manager");
  }

  const secrets = JSON.parse(secretResponse.SecretString);

  // Always sync all Strapi collections
  const collections = STRAPI_COLLECTIONS;

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Full sync triggered",
      sourceType,
      collections,
      clientId,
    }),
  );

  // Run sync for each collection, aggregating results
  let totalRecordsProcessed = 0;
  const allErrors: string[] = [];
  let lastIngestionJobId: string | undefined;
  let anyResumed = false;

  for (const collection of collections) {
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Starting sync for collection",
        sourceType,
        collection,
        clientId,
      }),
    );

    // Create adapter for this collection
    const adapter = createAdapter(sourceType, collection, secrets);

    // Create pipeline dependencies
    const s3Client = new S3ContentClient({ bucketName });
    const syncStateClient = new SyncStateClient({ tableName, clientId });
    const bedrockClient = new BedrockSyncClient({
      knowledgeBaseId,
      dataSourceId,
    });

    // Build and execute pipeline (use collection as the sync state key)
    const pipeline = new FullSyncPipeline(
      adapter,
      s3Client,
      syncStateClient,
      bedrockClient,
      { sourceType: collection, clientId },
    );

    const result = await pipeline.execute();
    totalRecordsProcessed += result.recordsProcessed;
    allErrors.push(...result.errors);
    if (result.ingestionJobId) {
      lastIngestionJobId = result.ingestionJobId;
    }
    if (result.resumed) {
      anyResumed = true;
    }

    if (!result.success) {
      console.log(
        JSON.stringify({
          level: "WARN",
          message: "Sync failed for collection - continuing with remaining",
          collection,
          errors: result.errors.length,
        }),
      );
    }
  }

  return {
    recordsProcessed: totalRecordsProcessed,
    errors: allErrors,
    success: allErrors.length === 0,
    ingestionJobId: lastIngestionJobId,
    resumed: anyResumed,
  };
}

/**
 * Factory to create a Strapi adapter for a given collection.
 *
 * Collections are managed in code via STRAPI_COLLECTIONS.
 */
function createAdapter(
  sourceType: string,
  collection: string,
  secrets: Record<string, string>,
): StrapiAdapter {
  if (sourceType !== "strapi") {
    throw new Error(`Unsupported source type: ${sourceType}`);
  }

  return new StrapiAdapter(
    {
      baseUrl:
        secrets.apiEndpoint ?? secrets.baseUrl ?? secrets.strapiUrl ?? "",
      apiToken: secrets.apiToken ?? secrets.strapiToken ?? "",
      collection,
      frontendBaseUrl: secrets.frontendBaseUrl ?? process.env.FRONTEND_BASE_URL,
    },
    new RetryHttpClient(),
  );
}

// ---- Route handlers ----

/**
 * Handle incoming webhook events from a data source.
 *
 * Flow:
 * 1. Validate HMAC signature (return 401 on mismatch)
 * 2. Check dedup table (return 200 if already processed)
 * 3. Process the webhook event
 * 4. On success: record in dedup table, return 200
 * 5. On failure: return 500, do NOT record in dedup table
 *
 * Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 6.8
 */
async function handleWebhook(
  event: APIGatewayV2Event,
  source: string,
): Promise<LambdaResponse> {
  const sourceIp = event.requestContext?.http?.sourceIp ?? "unknown";
  const rawBody = event.body ?? "";
  const headers = event.headers ?? {};

  // Step 1: Validate webhook secret key
  const providedSecret = headers["x-webhook-secret"] ?? "";
  if (!providedSecret) {
    console.log(
      JSON.stringify({
        level: "WARN",
        event: "WEBHOOK_SECRET_MISSING",
        source,
        sourceIp,
        timestamp: new Date().toISOString(),
        reason: "Missing x-webhook-secret header",
      }),
    );
    return jsonResponse(401, { error: "Unauthorized: missing secret" });
  }

  let webhookSecret: string;
  try {
    webhookSecret = await getWebhookSecret();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to retrieve webhook secret:", message);
    return jsonResponse(500, { error: "Internal server error" });
  }

  if (!validateWebhookSecret(providedSecret, webhookSecret)) {
    console.log(
      JSON.stringify({
        level: "WARN",
        event: "WEBHOOK_SECRET_INVALID",
        source,
        sourceIp,
        timestamp: new Date().toISOString(),
        reason: "Secret mismatch",
      }),
    );
    return jsonResponse(401, { error: "Unauthorized: invalid secret" });
  }

  // Step 2: Extract event ID and check dedup
  const eventId = headers["x-webhook-id"] ?? extractEventId(rawBody);

  if (!eventId) {
    return jsonResponse(400, { error: "Missing event identifier" });
  }

  try {
    const duplicate = await isDuplicate(source, eventId);
    if (duplicate) {
      console.log(
        JSON.stringify({
          level: "INFO",
          message: "Duplicate webhook event skipped",
          source,
          eventId,
        }),
      );
      return jsonResponse(200, {
        message: "Event already processed",
        status: "duplicate",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Dedup check failed:", message);
    return jsonResponse(500, { error: "Internal server error" });
  }

  // Step 3: Parse and normalize the webhook payload
  let payload: WebhookPayload;
  try {
    const raw = JSON.parse(rawBody);
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Webhook raw payload",
        source,
        raw,
      }),
    );
    payload = normalizeStrapiPayload(raw);
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Webhook normalized payload",
        source,
        payload,
      }),
    );
  } catch {
    return jsonResponse(400, { error: "Invalid JSON payload" });
  }

  try {
    // Route the webhook event to the appropriate processor
    await processWebhookEvent(source, eventId, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Webhook processing failed:", message);
    // Do NOT record in dedup table on failure - allows retry
    return jsonResponse(500, { error: "Processing failed" });
  }

  // Step 4: Record successful processing in dedup table
  try {
    await recordProcessed(source, eventId);
  } catch (err) {
    // Log but don't fail - the event was processed successfully.
    // Worst case: the event might be reprocessed on retry (idempotent).
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to record dedup entry:", message);
  }

  return jsonResponse(200, {
    message: `Webhook processed for source: ${source}`,
    status: "accepted",
    eventId,
  });
}

/**
 * Normalizes a Strapi webhook payload to the internal WebhookPayload format.
 *
 * Strapi sends: { event: "entry.create", model: "article", entry: { id, ...fields } }
 * We normalize to: { event: "create", recordId: "article-42", timestamp: "...", data: { ...fields } }
 */
function normalizeStrapiPayload(raw: Record<string, unknown>): WebhookPayload {
  // If already in our format (has recordId), pass through
  if (
    raw.recordId &&
    (raw.event === "create" || raw.event === "update" || raw.event === "delete")
  ) {
    return raw as unknown as WebhookPayload;
  }

  // Map Strapi event names to our internal types
  const eventStr = String(raw.event ?? "");
  let event: "create" | "update" | "delete";
  if (eventStr.includes("create") || eventStr.includes("publish")) {
    event = "create";
  } else if (eventStr.includes("update")) {
    event = "update";
  } else if (eventStr.includes("delete") || eventStr.includes("unpublish")) {
    event = "delete";
  } else {
    // Pass through as-is and let the router log the unknown type
    event = eventStr as "create" | "update" | "delete";
  }

  // Extract record ID from entry - use just the entry ID since Strapi IDs
  // are globally unique within an instance, and the adapter expects a plain ID
  // for API calls like /api/intranet-pages/77
  const entry = raw.entry as Record<string, unknown> | undefined;
  const entryId = String(entry?.id ?? entry?.documentId ?? "unknown");
  const recordId = entryId;

  // Derive collection from uid (e.g. "api::intranet-page.intranet-page" -> "intranet-pages")
  const uid = String(raw.uid ?? "");
  let collection: string | undefined;
  if (uid.startsWith("api::")) {
    // "api::intranet-page.intranet-page" -> "intranet-page"
    const contentType = uid.split("::")[1]?.split(".")[0] ?? "";
    // Use explicit mapping for irregular plurals, fall back to appending "s"
    collection = contentType
      ? (STRAPI_UID_TO_COLLECTION[contentType] ?? `${contentType}s`)
      : undefined;
  }

  // Use entry's updatedAt/createdAt or current time
  const timestamp = String(
    entry?.updatedAt ?? entry?.createdAt ?? new Date().toISOString(),
  );

  return {
    event,
    recordId,
    timestamp,
    data: entry as Record<string, unknown>,
    collection,
  };
}

/**
 * Process a webhook event by routing it through the WebhookEventRouter.
 *
 * Creates the appropriate adapter based on source type, builds the router
 * with S3 and Bedrock clients, and routes the event for processing.
 *
 * The `source` path parameter doubles as the collection identifier for Strapi
 * (e.g. POST /webhook/articles, POST /webhook/intranet-pages).
 * Falls back to "articles" if source is just "strapi".
 *
 * Requirements: 6.4, 6.5
 */
async function processWebhookEvent(
  source: string,
  eventId: string,
  payload: WebhookPayload,
): Promise<void> {
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Processing webhook event",
      source,
      eventId,
      event: payload.event,
      recordId: payload.recordId,
    }),
  );

  const clientId = process.env.CLIENT_ID ?? "";
  const bucketName = process.env.DATA_BUCKET_NAME ?? "";
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID ?? "";
  const dataSourceId = process.env.DATA_SOURCE_ID ?? "";

  // Retrieve data source secrets (cached)
  const secrets = await getDataSourceSecrets();

  // Resolve collection: prefer payload.collection (from Strapi uid), then source path, fallback to "articles"
  const collection =
    payload.collection ??
    (STRAPI_COLLECTIONS.includes(source) ? source : "articles");

  // Create adapter for the resolved collection
  const adapter = createAdapter("strapi", collection, secrets);

  // Create infrastructure clients
  const s3Client = new S3ContentClient({ bucketName });
  const bedrockClient = new BedrockSyncClient({
    knowledgeBaseId,
    dataSourceId,
  });

  // Build and invoke the event router
  const router = new WebhookEventRouter(adapter, s3Client, bedrockClient, {
    clientId,
    sourceType: collection,
    bucketName,
  });

  await router.route(payload as RouterPayload);
}

/**
 * Extract event ID from the request body.
 *
 * The event ID must be unique per delivery so that legitimate updates
 * to the same record are NOT deduplicated away.
 *
 * Checks for (in order):
 * 1. Explicit `id` field (string) - assumed globally unique per delivery
 * 2. Composite `recordId` + `timestamp` (unique per update)
 * 3. Strapi-style `model` + `entry.id` + `updatedAt` timestamp
 * 4. SHA-256 hash of the raw body as ultimate fallback
 */
function extractEventId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody);

    // Check for explicit id field
    if (parsed.id && typeof parsed.id === "string") {
      return parsed.id;
    }

    // Composite key from recordId + timestamp
    if (parsed.recordId && parsed.timestamp) {
      return `${parsed.recordId}-${parsed.timestamp}`;
    }

    // Strapi native payload: include event type + updatedAt so each action on
    // the same entry is unique. Without the event type, a delete on record 151
    // produces the same ID as the earlier create (same updatedAt timestamp),
    // causing the delete to be skipped as a duplicate.
    if (parsed.entry?.id != null) {
      const model = parsed.model ?? "unknown";
      const eventType = String(parsed.event ?? "unknown");
      const entryId = parsed.entry.id;
      const updatedAt = parsed.entry.updatedAt ?? parsed.entry.updated_at ?? "";
      return updatedAt
        ? `${eventType}-${model}-${entryId}-${updatedAt}`
        : `${eventType}-${model}-${entryId}`;
    }

    // Ultimate fallback: hash the body for dedup
    return createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * Handle manual record ingestion request.
 */
async function handleIngestRecord(
  _event: APIGatewayV2Event,
): Promise<LambdaResponse> {
  // TODO: Implement single record ingestion
  return jsonResponse(200, {
    message: "Record ingestion accepted",
    status: "accepted",
  });
}

/**
 * Handle record deletion request.
 */
async function handleDeleteRecord(
  _event: APIGatewayV2Event,
  recordId: string,
): Promise<LambdaResponse> {
  // TODO: Implement record deletion from S3 and trigger KB re-sync
  return jsonResponse(200, {
    message: `Record ${recordId} deletion accepted`,
    status: "accepted",
  });
}

// ---- Helpers ----

/**
 * Build a JSON API Gateway response.
 */
function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): LambdaResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
