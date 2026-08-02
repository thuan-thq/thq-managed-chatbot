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
import { RetryHttpClient } from "./http-client";
import {
  WebhookEventRouter,
  WebhookPayload as RouterPayload,
} from "./event-router";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { ConfigLoader } from "./config-loader";
import { ClientConfig } from "./config-types";
import { buildUidCollectionMap, lookupCollection } from "./uid-collection-map";
import {
  ConfigurableStrapiAdapter,
  ConfigurableStrapiAdapterConfig,
} from "./configurable-strapi-adapter";

// ---- Config-driven cold start ----
//
// Load and validate deployment config at module init so the Lambda fails fast
// at cold start (rather than silently ingesting nothing) when the config is
// misconfigured.  Requirements: 7.1, 7.2
//
// Collections can optionally live in a separate collections.json file to keep
// deployment.json lean. When collections.json exists it overrides the inline
// strapi.collections array in deployment.json.
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const deploymentConfig: unknown = require("../../config/deployment.json");

let collectionsOverride: unknown;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  collectionsOverride = require("../../config/collections.json");
} catch {
  // collections.json is optional — absence is not an error
  collectionsOverride = undefined;
}

const config: ClientConfig = ConfigLoader.loadWithCollections(
  deploymentConfig,
  collectionsOverride,
);

// Build a per-source map: sourceId -> { adapter config, uidMap }
// This supports multiple data sources declared in dataSources[].
const sourceAdapterConfigs = new Map<
  string,
  {
    ds: (typeof config.dataSources)[number];
    uidMap: ReturnType<typeof buildUidCollectionMap>;
  }
>();
for (const ds of config.dataSources) {
  sourceAdapterConfigs.set(ds.id, {
    ds,
    uidMap: buildUidCollectionMap(ds.collections),
  });
}

// Flattened UID map across all sources (for webhook routing without a source ID).
// When two sources share a UID, the last one wins — document this as a known limitation.
const globalUidMap = buildUidCollectionMap(
  config.dataSources.flatMap((ds) => ds.collections),
);

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
  /** Collection derived from Strapi uid via UidCollectionMap. Requirements: 5.1, 5.3 */
  collection?: string;
}

// ---- Secrets cache ----

const secretsClient = new SecretsManagerClient({});
const cachedDataSourceSecrets = new Map<string, Record<string, string>>();

/**
 * Retrieves the webhook secret for a given data source from Secrets Manager.
 * Falls back to the first data source when sourceId is not provided.
 * Caches the result for the lifetime of the Lambda execution context.
 */
async function getWebhookSecret(sourceId?: string): Promise<string> {
  const id = sourceId ?? config.dataSources[0]?.id ?? "default";

  // Check cache first
  const cached = cachedDataSourceSecrets.get(id);
  if (cached?.webhookSecret) {
    return cached.webhookSecret;
  }

  const secrets = await getDataSourceSecrets(id);
  if (!secrets.webhookSecret) {
    throw new Error(
      `webhookSecret field missing from secret for source: ${id}`,
    );
  }

  return secrets.webhookSecret;
}

/**
 * Retrieves the secrets object for a given data source from Secrets Manager.
 * Results are cached per source ID for the lifetime of the Lambda execution context.
 * Contains: webhookSecret, apiToken, frontendBaseUrl, etc.
 */
async function getDataSourceSecrets(
  sourceId: string,
): Promise<Record<string, string>> {
  const cached = cachedDataSourceSecrets.get(sourceId);
  if (cached) {
    return cached;
  }

  const clientId = process.env.CLIENT_ID ?? "";
  const secretId = `/${clientId}/secrets/datasource/${sourceId}`;

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );

  if (!response.SecretString) {
    throw new Error(
      `Data source secret not found in Secrets Manager: ${secretId}`,
    );
  }

  const parsed = JSON.parse(response.SecretString) as Record<string, string>;
  cachedDataSourceSecrets.set(sourceId, parsed);
  return parsed;
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
 * Handle a full sync direct invocation.
 *
 * Derives the list of collections exclusively from config.dataSources[].collections
 * (Req 6.1). Returns a zero FullSyncResult immediately when no collections
 * are configured (Req 6.2).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
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

  // Derive all collections across all configured data sources (Req 6.1)
  const allCollections = config.dataSources.flatMap((ds) =>
    ds.collections.map((c) => ({ sourceId: ds.id, collectionName: c.name })),
  );

  // Req 6.2: empty collections — return immediately with zero result
  if (allCollections.length === 0) {
    console.log(
      JSON.stringify({
        level: "INFO",
        message: "No collections configured - full sync skipped",
      }),
    );
    return {
      recordsProcessed: 0,
      errors: [],
      success: true,
      ingestionJobId: undefined,
      resumed: false,
    };
  }

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Full sync triggered",
      sourceType,
      sources: config.dataSources.map((ds) => ds.id),
      clientId,
    }),
  );

  let totalRecordsProcessed = 0;
  const allErrors: string[] = [];
  let lastIngestionJobId: string | undefined;
  let anyResumed = false;

  // Run sync per data source, then per collection within each source
  for (const ds of config.dataSources) {
    // Retrieve per-source secrets from Secrets Manager
    const secretId = `/${clientId}/secrets/datasource/${ds.id}`;
    const secretResponse = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );

    if (!secretResponse.SecretString) {
      throw new Error(
        `Data source secret not found in Secrets Manager: ${secretId}`,
      );
    }

    const secrets = JSON.parse(secretResponse.SecretString) as Record<
      string,
      string
    >;

    const adapterConfig: ConfigurableStrapiAdapterConfig = {
      baseUrl: ds.apiEndpoint,
      apiToken: secrets.apiToken ?? secrets.strapiToken ?? ds.apiToken ?? "",
      frontendBaseUrl:
        ds.frontendBaseUrl ??
        secrets.frontendBaseUrl ??
        process.env.FRONTEND_BASE_URL,
      collections: ds.collections,
    };
    const adapter = new ConfigurableStrapiAdapter(
      adapterConfig,
      new RetryHttpClient(),
    );

    for (const collection of ds.collections.map((c) => c.name)) {
      console.log(
        JSON.stringify({
          level: "INFO",
          message: "Starting sync for collection",
          sourceId: ds.id,
          sourceType,
          collection,
          clientId,
        }),
      );

      const s3Client = new S3ContentClient({ bucketName });
      const syncStateClient = new SyncStateClient({ tableName, clientId });
      const bedrockClient = new BedrockSyncClient({
        knowledgeBaseId,
        dataSourceId,
      });

      const pipeline = new FullSyncPipeline(
        adapter,
        s3Client,
        syncStateClient,
        bedrockClient,
        { sourceType: collection, collectionName: collection, clientId },
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
            sourceId: ds.id,
            collection,
            errors: result.errors.length,
          }),
        );
      }
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

  // Resolve which data source this webhook belongs to early,
  // so we validate against the correct source's webhookSecret.
  // At this point we only have the URL `source` param (collection name or source id).
  const resolvedDsForAuth =
    config.dataSources.find(
      (ds) => ds.id === source || ds.collections.some((c) => c.name === source),
    ) ?? config.dataSources[0];

  let webhookSecret: string;
  try {
    webhookSecret = await getWebhookSecret(resolvedDsForAuth.id);
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
 * Looks up the incoming uid in the config-driven UidCollectionMap (Req 5.2, 5.3).
 * Logs WARN and leaves collection undefined for unrecognised or non-api:: UIDs
 * (Req 5.4, 5.5) — handled by lookupCollection.
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

  // Derive collection from uid via config-driven UidCollectionMap.
  // lookupCollection handles WARN logging for non-api:: and unknown UIDs.
  // Requirements: 5.2, 5.3, 5.4, 5.5
  const uid = String(raw.uid ?? "");
  const collection = lookupCollection(globalUidMap, uid);

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
 * Creates a ConfigurableStrapiAdapter using config-driven collection definitions.
 * The `source` path parameter doubles as the collection identifier for Strapi
 * (e.g. POST /webhook/articles, POST /webhook/intranet-pages).
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

  // Resolve which data source owns this collection/webhook source.
  // Try to find a source whose collections include the payload or source name,
  // then fall back to the first configured source.
  const resolvedDs =
    config.dataSources.find((ds) =>
      ds.collections.some((c) => c.name === (payload.collection ?? source)),
    ) ?? config.dataSources[0];

  // Retrieve per-source secrets (cached by source id)
  const secrets = await getDataSourceSecrets(resolvedDs.id);

  // Resolve collection within the chosen source
  const knownCollections = resolvedDs.collections.map((c) => c.name);
  const collection =
    payload.collection ??
    (knownCollections.includes(source) ? source : (knownCollections[0] ?? ""));

  // Build adapter from config (Req 5.2, 6.1)
  const adapterConfig: ConfigurableStrapiAdapterConfig = {
    baseUrl: resolvedDs.apiEndpoint,
    apiToken:
      secrets.apiToken ?? secrets.strapiToken ?? resolvedDs.apiToken ?? "",
    frontendBaseUrl:
      resolvedDs.frontendBaseUrl ??
      secrets.frontendBaseUrl ??
      process.env.FRONTEND_BASE_URL,
    collections: resolvedDs.collections,
  };
  const adapter = new ConfigurableStrapiAdapter(
    adapterConfig,
    new RetryHttpClient(),
  );

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
