import {
  SSMClient,
  GetParameterCommand,
  GetParameterCommandOutput,
} from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";

// ─── Domain types ────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  requestsPerMinute: number;
}

export interface SessionConfig {
  duration: number; // minutes
  turnLimit: number;
  tokenBudget: number;
  retentionDays: number;
}

export interface DataSourceConfig {
  type: "strapi" | "craftcms" | "monday" | "employment-hero";
  apiEndpoint: string;
  pageSize: number;
}

export interface MonitoringConfig {
  budgetAmount: number;
  alarmEmail: string;
}

export interface ClientConfig {
  clientId: string;
  dataSource: DataSourceConfig;
  rateLimits: RateLimitConfig;
  session: SessionConfig;
  monitoring: MonitoringConfig;
}

export interface SecretValues {
  /** App-facing API key */
  appKey: string;
  /** Admin-facing API key */
  adminKey: string;
  /** Data source bearer token */
  apiToken: string;
  /** Webhook HMAC secret */
  webhookSecret: string;
}

// ─── Cache entry ─────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  fetchedAt: number; // Date.now() ms
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

// ─── ConfigurationService ────────────────────────────────────────────────────

/**
 * Centralised configuration access layer.
 *
 * Reads non-sensitive config from Parameter Store and credentials from
 * Secrets Manager. Maintains a per-clientId in-memory cache with a
 * configurable TTL (default 5 minutes).
 *
 * On a Lambda cold start (first read) or after the TTL expires the service
 * re-fetches from the backing stores.
 *
 * Parameter Store paths
 *   /{clientId}/config/ratelimits   → JSON: RateLimitConfig
 *   /{clientId}/config/session      → JSON: SessionConfig
 *   /{clientId}/config/datasource   → JSON: DataSourceConfig
 *   /{clientId}/config/monitoring   → JSON: MonitoringConfig
 *
 * Secrets Manager paths
 *   /{clientId}/secrets/api-keys    → JSON: { appKey, adminKey }
 *   /{clientId}/secrets/datasource  → JSON: { apiToken, webhookSecret }
 */
export class ConfigurationService {
  private readonly ssm: SSMClient;
  private readonly sm: SecretsManagerClient;
  private readonly ttlMs: number;

  // Per-clientId caches
  private readonly configCache = new Map<string, CacheEntry<ClientConfig>>();
  private readonly secretsCache = new Map<string, CacheEntry<SecretValues>>();

  constructor(options?: {
    ssmClient?: SSMClient;
    smClient?: SecretsManagerClient;
    ttlMs?: number;
  }) {
    this.ssm = options?.ssmClient ?? new SSMClient({});
    this.sm = options?.smClient ?? new SecretsManagerClient({});
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Returns the full ClientConfig for the given clientId, using the cache. */
  async getConfig(clientId: string): Promise<ClientConfig> {
    const cached = this.configCache.get(clientId);
    if (cached && !this.isExpired(cached)) {
      return cached.value;
    }
    const config = await this.fetchConfig(clientId);
    this.configCache.set(clientId, { value: config, fetchedAt: Date.now() });
    return config;
  }

  /** Convenience accessor — returns just the DataSourceConfig. */
  async getDataSourceConfig(clientId: string): Promise<DataSourceConfig> {
    const config = await this.getConfig(clientId);
    return config.dataSource;
  }

  /** Returns the SecretValues for the given clientId, using the cache. */
  async getSecrets(clientId: string): Promise<SecretValues> {
    const cached = this.secretsCache.get(clientId);
    if (cached && !this.isExpired(cached)) {
      return cached.value;
    }
    const secrets = await this.fetchSecrets(clientId);
    this.secretsCache.set(clientId, { value: secrets, fetchedAt: Date.now() });
    return secrets;
  }

  /** Clears all caches, forcing a full refresh on the next read. */
  invalidateCache(): void {
    this.configCache.clear();
    this.secretsCache.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private isExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.fetchedAt >= this.ttlMs;
  }

  private async fetchConfig(clientId: string): Promise<ClientConfig> {
    const [rateLimits, session, dataSource, monitoring] = await Promise.all([
      this.fetchParameter<RateLimitConfig>(
        `/${clientId}/config/ratelimits`,
        DEFAULT_RATE_LIMITS,
      ),
      this.fetchParameter<SessionConfig>(
        `/${clientId}/config/session`,
        DEFAULT_SESSION,
      ),
      this.fetchParameter<DataSourceConfig>(
        `/${clientId}/config/datasource`,
        null,
      ),
      this.fetchParameter<MonitoringConfig>(
        `/${clientId}/config/monitoring`,
        DEFAULT_MONITORING,
      ),
    ]);

    return { clientId, dataSource, rateLimits, session, monitoring };
  }

  private async fetchSecrets(clientId: string): Promise<SecretValues> {
    const [apiKeys, dsSecrets] = await Promise.all([
      this.fetchSecret<{ appKey: string; adminKey: string }>(
        `/${clientId}/secrets/api-keys`,
      ),
      this.fetchSecret<{ apiToken: string; webhookSecret: string }>(
        `/${clientId}/secrets/datasource`,
      ),
    ]);

    return {
      appKey: apiKeys.appKey,
      adminKey: apiKeys.adminKey,
      apiToken: dsSecrets.apiToken,
      webhookSecret: dsSecrets.webhookSecret,
    };
  }

  private async fetchParameter<T>(
    name: string,
    defaultValue: T | null,
  ): Promise<T> {
    let output: GetParameterCommandOutput;
    try {
      output = await this.ssm.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
    } catch (err: unknown) {
      if (isAwsNotFoundError(err)) {
        if (defaultValue !== null) return defaultValue;
        throw new Error(`Missing required Parameter Store entry: ${name}`);
      }
      throw err;
    }

    const raw = output.Parameter?.Value;
    if (!raw) {
      if (defaultValue !== null) return defaultValue;
      throw new Error(`Empty parameter value for: ${name}`);
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(
        `Failed to parse JSON from Parameter Store path: ${name}`,
      );
    }
  }

  private async fetchSecret<T>(name: string): Promise<T> {
    let output: GetSecretValueCommandOutput;
    try {
      output = await this.sm.send(
        new GetSecretValueCommand({ SecretId: name }),
      );
    } catch (err: unknown) {
      if (isAwsNotFoundError(err)) {
        throw new Error(`Secret not found: ${name}`);
      }
      throw err;
    }

    const raw = output.SecretString;
    if (!raw) {
      throw new Error(`Empty secret value for: ${name}`);
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(
        `Failed to parse JSON from Secrets Manager secret: ${name}`,
      );
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAwsNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const code = (err as { name?: string; $metadata?: unknown }).name;
    return (
      code === "ParameterNotFound" ||
      code === "ResourceNotFoundException" ||
      code === "NoSuchKey"
    );
  }
  return false;
}
