import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

import {
  ConfigurationService,
  ClientConfig,
  SecretValues,
  DataSourceConfig,
} from "../lib/services/configuration-service";

// ─── Minimal mock helpers ────────────────────────────────────────────────────

type SendFn = (cmd: unknown) => Promise<unknown>;

function makeSsmClient(sendFn: SendFn): SSMClient {
  const client = Object.create(SSMClient.prototype) as SSMClient;
  (client as unknown as { send: SendFn }).send = sendFn;
  return client;
}

function makeSmClient(sendFn: SendFn): SecretsManagerClient {
  const client = Object.create(
    SecretsManagerClient.prototype,
  ) as SecretsManagerClient;
  (client as unknown as { send: SendFn }).send = sendFn;
  return client;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CLIENT_ID = "test-client";

const RATE_LIMITS = { requestsPerMinute: 30 };
const SESSION_CFG = {
  duration: 30,
  turnLimit: 50,
  tokenBudget: 8000,
  retentionDays: 7,
};
const DATA_SOURCE: DataSourceConfig = {
  type: "strapi",
  apiEndpoint: "https://cms.example.com",
  pageSize: 100,
};
const MONITORING = { budgetAmount: 50, alarmEmail: "ops@example.com" };
const API_KEYS = { appKey: "wk-abc", adminKey: "ak-xyz" };
const DS_SECRETS = { apiToken: "token-123", webhookSecret: "hmac-secret" };

/** Build a send() that returns SSM param values keyed by name. */
function buildSsmSend(params: Record<string, unknown>): SendFn {
  return async (cmd: unknown) => {
    const name = (cmd as GetParameterCommand).input.Name as string;
    if (!(name in params)) {
      const err = new Error("ParameterNotFound");
      (err as unknown as { name: string }).name = "ParameterNotFound";
      throw err;
    }
    return { Parameter: { Value: JSON.stringify(params[name]) } };
  };
}

/** Build a send() that returns Secrets Manager values keyed by SecretId. */
function buildSmSend(secrets: Record<string, unknown>): SendFn {
  return async (cmd: unknown) => {
    const id = (cmd as GetSecretValueCommand).input.SecretId as string;
    if (!(id in secrets)) {
      const err = new Error("ResourceNotFoundException");
      (err as unknown as { name: string }).name = "ResourceNotFoundException";
      throw err;
    }
    return { SecretString: JSON.stringify(secrets[id]) };
  };
}

function buildDefaultSsmParams(): Record<string, unknown> {
  return {
    [`/${CLIENT_ID}/config/ratelimits`]: RATE_LIMITS,
    [`/${CLIENT_ID}/config/session`]: SESSION_CFG,
    [`/${CLIENT_ID}/config/datasource`]: DATA_SOURCE,
    [`/${CLIENT_ID}/config/monitoring`]: MONITORING,
  };
}

function buildDefaultSmSecrets(): Record<string, unknown> {
  return {
    [`/${CLIENT_ID}/secrets/api-keys`]: API_KEYS,
    [`/${CLIENT_ID}/secrets/datasource`]: DS_SECRETS,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ConfigurationService", () => {
  // ── getConfig ──────────────────────────────────────────────────────────

  describe("getConfig()", () => {
    it("returns correctly typed ClientConfig", async () => {
      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
      });

      const config = await svc.getConfig(CLIENT_ID);

      expect(config.clientId).toBe(CLIENT_ID);
      expect(config.rateLimits).toEqual(RATE_LIMITS);
      expect(config.session).toEqual(SESSION_CFG);
      expect(config.dataSource).toEqual(DATA_SOURCE);
      expect(config.monitoring).toEqual(MONITORING);
    });

    it("returns cached value on second call within TTL (no extra fetches)", async () => {
      let callCount = 0;
      const ssmSend: SendFn = async (cmd) => {
        callCount++;
        return buildSsmSend(buildDefaultSsmParams())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(ssmSend),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
        ttlMs: 60_000, // 1 minute TTL
      });

      await svc.getConfig(CLIENT_ID);
      const callsAfterFirst = callCount;
      await svc.getConfig(CLIENT_ID);

      // Second call must not add any SSM fetches
      expect(callCount).toBe(callsAfterFirst);
    });

    it("re-fetches from backing store after TTL expiry", async () => {
      let callCount = 0;
      const ssmSend: SendFn = async (cmd) => {
        callCount++;
        return buildSsmSend(buildDefaultSsmParams())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(ssmSend),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
        ttlMs: 0, // TTL of 0 ms — every call is "expired"
      });

      await svc.getConfig(CLIENT_ID);
      const callsAfterFirst = callCount;
      await svc.getConfig(CLIENT_ID);

      // With TTL=0 the second call must trigger new SSM fetches
      expect(callCount).toBeGreaterThan(callsAfterFirst);
    });
  });

  // ── getDataSourceConfig ────────────────────────────────────────────────

  describe("getDataSourceConfig()", () => {
    it("returns the DataSourceConfig subset of the config", async () => {
      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
      });

      const ds = await svc.getDataSourceConfig(CLIENT_ID);

      expect(ds).toEqual(DATA_SOURCE);
    });

    it("uses the same cache as getConfig (no duplicate fetches)", async () => {
      let callCount = 0;
      const ssmSend: SendFn = async (cmd) => {
        callCount++;
        return buildSsmSend(buildDefaultSsmParams())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(ssmSend),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
        ttlMs: 60_000,
      });

      await svc.getConfig(CLIENT_ID);
      const callsAfterFull = callCount;

      // getDataSourceConfig should hit the same config cache
      await svc.getDataSourceConfig(CLIENT_ID);
      expect(callCount).toBe(callsAfterFull);
    });
  });

  // ── getSecrets ─────────────────────────────────────────────────────────

  describe("getSecrets()", () => {
    it("returns correctly typed SecretValues", async () => {
      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
      });

      const secrets = await svc.getSecrets(CLIENT_ID);

      expect(secrets.appKey).toBe(API_KEYS.appKey);
      expect(secrets.adminKey).toBe(API_KEYS.adminKey);
      expect(secrets.apiToken).toBe(DS_SECRETS.apiToken);
      expect(secrets.webhookSecret).toBe(DS_SECRETS.webhookSecret);
    });

    it("returns cached secrets within TTL (no extra SM calls)", async () => {
      let smCallCount = 0;
      const smSend: SendFn = async (cmd) => {
        smCallCount++;
        return buildSmSend(buildDefaultSmSecrets())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(smSend),
        ttlMs: 60_000,
      });

      await svc.getSecrets(CLIENT_ID);
      const afterFirst = smCallCount;
      await svc.getSecrets(CLIENT_ID);

      expect(smCallCount).toBe(afterFirst);
    });

    it("re-fetches secrets after TTL expiry", async () => {
      let smCallCount = 0;
      const smSend: SendFn = async (cmd) => {
        smCallCount++;
        return buildSmSend(buildDefaultSmSecrets())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(smSend),
        ttlMs: 0,
      });

      await svc.getSecrets(CLIENT_ID);
      const afterFirst = smCallCount;
      await svc.getSecrets(CLIENT_ID);

      expect(smCallCount).toBeGreaterThan(afterFirst);
    });
  });

  // ── invalidateCache ────────────────────────────────────────────────────

  describe("invalidateCache()", () => {
    it("forces a fresh fetch from backing store on next getConfig call", async () => {
      let callCount = 0;
      const ssmSend: SendFn = async (cmd) => {
        callCount++;
        return buildSsmSend(buildDefaultSsmParams())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(ssmSend),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
        ttlMs: 60_000,
      });

      await svc.getConfig(CLIENT_ID);
      const afterFirst = callCount;

      svc.invalidateCache();
      await svc.getConfig(CLIENT_ID);

      expect(callCount).toBeGreaterThan(afterFirst);
    });

    it("forces a fresh fetch from backing store on next getSecrets call", async () => {
      let smCallCount = 0;
      const smSend: SendFn = async (cmd) => {
        smCallCount++;
        return buildSmSend(buildDefaultSmSecrets())(cmd);
      };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(smSend),
        ttlMs: 60_000,
      });

      await svc.getSecrets(CLIENT_ID);
      const afterFirst = smCallCount;

      svc.invalidateCache();
      await svc.getSecrets(CLIENT_ID);

      expect(smCallCount).toBeGreaterThan(afterFirst);
    });

    it("returns refreshed config after invalidation and backing store update", async () => {
      const params = { ...buildDefaultSsmParams() };

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(params)),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
        ttlMs: 60_000,
      });

      const first = await svc.getConfig(CLIENT_ID);
      expect(first.rateLimits.requestsPerMinute).toBe(30);

      // Simulate backing store update
      params[`/${CLIENT_ID}/config/ratelimits`] = { requestsPerMinute: 60 };

      svc.invalidateCache();
      const second = await svc.getConfig(CLIENT_ID);
      expect(second.rateLimits.requestsPerMinute).toBe(60);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws when required datasource parameter is missing", async () => {
      const params = { ...buildDefaultSsmParams() };
      delete params[`/${CLIENT_ID}/config/datasource`];

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(params)),
        smClient: makeSmClient(buildSmSend(buildDefaultSmSecrets())),
      });

      await expect(svc.getConfig(CLIENT_ID)).rejects.toThrow(
        "Missing required Parameter Store entry",
      );
    });

    it("throws when a required secret is missing", async () => {
      const secrets: Record<string, unknown> = {};

      const svc = new ConfigurationService({
        ssmClient: makeSsmClient(buildSsmSend(buildDefaultSsmParams())),
        smClient: makeSmClient(buildSmSend(secrets)),
      });

      await expect(svc.getSecrets(CLIENT_ID)).rejects.toThrow(
        "Secret not found",
      );
    });
  });
});
