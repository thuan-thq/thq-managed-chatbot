/**
 * Configuration CRUD handler for the Admin Lambda.
 *
 * GET /admin/config  - Returns full client configuration
 * PUT /admin/config  - Updates partial configuration with validation
 *
 * Requirements: 10.4, 10.5
 */

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { validateConfigUpdate } from "./validation";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RateLimitConfig {
  requestsPerMinute: number;
}

interface SessionConfig {
  duration: number;
  turnLimit: number;
  tokenBudget: number;
  retentionDays: number;
}

interface DataSourceConfig {
  type: string;
  apiEndpoint: string;
  pageSize: number;
}

interface MonitoringConfig {
  budgetAmount: number;
  alarmEmail: string;
}

interface ClientConfig {
  clientId: string;
  dataSource: DataSourceConfig | null;
  rateLimits: RateLimitConfig;
  session: SessionConfig;
  monitoring: MonitoringConfig;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_RATE_LIMITS: RateLimitConfig = { requestsPerMinute: 30 };
const DEFAULT_SESSION: SessionConfig = {
  duration: 30,
  turnLimit: 50,
  tokenBudget: 8000,
  retentionDays: 7,
};
const DEFAULT_MONITORING: MonitoringConfig = {
  budgetAmount: 0,
  alarmEmail: "",
};

// ─── SSM Client (reused across invocations) ─────────────────────────────────

const ssm = new SSMClient({});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchParameter<T>(
  name: string,
  defaultValue: T | null,
): Promise<T> {
  try {
    const output = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const raw = output.Parameter?.Value;
    if (!raw) {
      if (defaultValue !== null) return defaultValue;
      throw new Error(`Empty parameter value for: ${name}`);
    }
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      (err as { name?: string }).name === "ParameterNotFound"
    ) {
      if (defaultValue !== null) return defaultValue;
      throw new Error(`Missing required Parameter Store entry: ${name}`);
    }
    throw err;
  }
}

async function putParameter(name: string, value: unknown): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: JSON.stringify(value),
      Type: "String",
      Overwrite: true,
    }),
  );
}

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

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * GET /admin/config
 * Reads all configuration parameters and returns the full ClientConfig.
 */
export async function handleGetConfig(
  clientId: string,
): Promise<LambdaResponse> {
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Fetching configuration",
      clientId,
    }),
  );

  try {
    const [rateLimits, session, dataSource, monitoring] = await Promise.all([
      fetchParameter<RateLimitConfig>(
        `/${clientId}/config/ratelimits`,
        DEFAULT_RATE_LIMITS,
      ),
      fetchParameter<SessionConfig>(
        `/${clientId}/config/session`,
        DEFAULT_SESSION,
      ),
      fetchParameter<DataSourceConfig | null>(
        `/${clientId}/config/datasource`,
        null,
      ),
      fetchParameter<MonitoringConfig>(
        `/${clientId}/config/monitoring`,
        DEFAULT_MONITORING,
      ),
    ]);

    const config: ClientConfig = {
      clientId,
      dataSource,
      rateLimits,
      session,
      monitoring,
    };

    return jsonResponse(200, config as unknown as Record<string, unknown>);
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Failed to fetch configuration",
        clientId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonResponse(500, { message: "Failed to fetch configuration" });
  }
}

/**
 * PUT /admin/config
 * Validates and updates partial configuration.
 * Returns 400 with errors array if validation fails.
 * Returns 200 with merged config on success.
 */
export async function handleUpdateConfig(
  clientId: string,
  body: string | null | undefined,
): Promise<LambdaResponse> {
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Updating configuration",
      clientId,
    }),
  );

  if (!body) {
    return jsonResponse(400, { message: "Request body is required" });
  }

  let update: Record<string, unknown>;
  try {
    update = JSON.parse(body);
  } catch {
    return jsonResponse(400, { message: "Invalid JSON in request body" });
  }

  // Validate the update
  const validation = validateConfigUpdate(update);
  if (!validation.valid) {
    return jsonResponse(400, {
      message: "Configuration validation failed",
      errors: validation.errors,
    });
  }

  try {
    // Fetch current values
    const [currentRateLimits, currentSession, currentMonitoring] =
      await Promise.all([
        fetchParameter<RateLimitConfig>(
          `/${clientId}/config/ratelimits`,
          DEFAULT_RATE_LIMITS,
        ),
        fetchParameter<SessionConfig>(
          `/${clientId}/config/session`,
          DEFAULT_SESSION,
        ),
        fetchParameter<MonitoringConfig>(
          `/${clientId}/config/monitoring`,
          DEFAULT_MONITORING,
        ),
      ]);

    // Merge updates
    const mergedRateLimits = update.rateLimits
      ? { ...currentRateLimits, ...(update.rateLimits as object) }
      : currentRateLimits;

    const mergedSession = update.session
      ? { ...currentSession, ...(update.session as object) }
      : currentSession;

    const mergedMonitoring = update.monitoring
      ? { ...currentMonitoring, ...(update.monitoring as object) }
      : currentMonitoring;

    // Write updated values to Parameter Store
    const writePromises: Promise<void>[] = [];
    if (update.rateLimits) {
      writePromises.push(
        putParameter(`/${clientId}/config/ratelimits`, mergedRateLimits),
      );
    }
    if (update.session) {
      writePromises.push(
        putParameter(`/${clientId}/config/session`, mergedSession),
      );
    }
    if (update.monitoring) {
      writePromises.push(
        putParameter(`/${clientId}/config/monitoring`, mergedMonitoring),
      );
    }

    await Promise.all(writePromises);

    // Fetch datasource for the full response (read-only, not updatable here)
    const dataSource = await fetchParameter<DataSourceConfig | null>(
      `/${clientId}/config/datasource`,
      null,
    );

    const mergedConfig: ClientConfig = {
      clientId: (update.clientId as string) ?? clientId,
      dataSource,
      rateLimits: mergedRateLimits,
      session: mergedSession,
      monitoring: mergedMonitoring,
    };

    return jsonResponse(
      200,
      mergedConfig as unknown as Record<string, unknown>,
    );
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Failed to update configuration",
        clientId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonResponse(500, { message: "Failed to update configuration" });
  }
}
