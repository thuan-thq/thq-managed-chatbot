import { validateConfig, loadConfig } from "../lib/config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("validateConfig", () => {
  const validConfig = {
    clientId: "test-client",
    region: "ap-southeast-2",
    dataSource: {
      type: "strapi",
      apiEndpoint: "https://cms.example.com",
      apiToken: "token-123",
      webhookSecret: "secret-456",
      pageSize: 100,
    },
    session: {
      duration: 30,
      turnLimit: 50,
      tokenBudget: 8000,
      retentionDays: 7,
    },
    rateLimit: {
      requestsPerMinute: 30,
    },
    apiKeys: {
      appKey: "wk-key",
      adminKey: "ak-key",
    },
    monitoring: {
      budgetAmount: 50,
      alarmEmail: "test@example.com",
    },
  };

  it("accepts a valid configuration", () => {
    const errors = validateConfig(validConfig);
    expect(errors).toHaveLength(0);
  });

  it("rejects null configuration", () => {
    const errors = validateConfig(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });

  it("rejects invalid clientId format", () => {
    const errors = validateConfig({ ...validConfig, clientId: "INVALID" });
    expect(errors.some((e) => e.field === "clientId")).toBe(true);
  });

  it("rejects clientId that is too short", () => {
    const errors = validateConfig({ ...validConfig, clientId: "ab" });
    expect(errors.some((e) => e.field === "clientId")).toBe(true);
  });

  it("rejects invalid region", () => {
    const errors = validateConfig({ ...validConfig, region: "us-east-1" });
    expect(errors.some((e) => e.field === "region")).toBe(true);
  });

  it("rejects invalid dataSource type", () => {
    const config = {
      ...validConfig,
      dataSource: { ...validConfig.dataSource, type: "invalid" },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.field === "dataSource.type")).toBe(true);
  });

  it("rejects pageSize out of range", () => {
    const config = {
      ...validConfig,
      dataSource: { ...validConfig.dataSource, pageSize: 0 },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.field === "dataSource.pageSize")).toBe(true);
  });

  it("rejects session duration out of range", () => {
    const config = {
      ...validConfig,
      session: { ...validConfig.session, duration: 200 },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.field === "session.duration")).toBe(true);
  });

  it("rejects tokenBudget out of range", () => {
    const config = {
      ...validConfig,
      session: { ...validConfig.session, tokenBudget: 500 },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.field === "session.tokenBudget")).toBe(true);
  });

  it("rejects invalid email in monitoring", () => {
    const config = {
      ...validConfig,
      monitoring: { ...validConfig.monitoring, alarmEmail: "not-an-email" },
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.field === "monitoring.alarmEmail")).toBe(true);
  });

  it("accepts config with optional fields omitted", () => {
    const minimalConfig = {
      clientId: "test-client",
      region: "ap-southeast-2",
      dataSource: {
        type: "monday",
        apiEndpoint: "https://api.monday.com",
        apiToken: "token",
        webhookSecret: "secret",
      },
      apiKeys: {
        appKey: "wk-key",
        adminKey: "ak-key",
      },
      monitoring: {
        budgetAmount: 25,
        alarmEmail: "ops@example.com",
      },
    };
    const errors = validateConfig(minimalConfig);
    expect(errors).toHaveLength(0);
  });
});

describe("loadConfig", () => {
  it("throws when file does not exist", () => {
    expect(() => loadConfig("/nonexistent/path.json")).toThrow(
      "Configuration file not found",
    );
  });

  it("throws for invalid JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    const tmpFile = path.join(tmpDir, "bad.json");
    fs.writeFileSync(tmpFile, "not json {{{");
    try {
      expect(() => loadConfig(tmpFile)).toThrow("Failed to parse");
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it("throws for invalid config content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    const tmpFile = path.join(tmpDir, "invalid.json");
    fs.writeFileSync(tmpFile, JSON.stringify({ clientId: "X" }));
    try {
      expect(() => loadConfig(tmpFile)).toThrow(
        "Configuration validation failed",
      );
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it("loads a valid config file successfully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    const tmpFile = path.join(tmpDir, "valid.json");
    const validConfig = {
      clientId: "my-client",
      region: "ap-southeast-2",
      dataSource: {
        type: "strapi",
        apiEndpoint: "https://cms.example.com",
        apiToken: "token-123",
        webhookSecret: "secret-456",
      },
      apiKeys: {
        appKey: "wk-key",
        adminKey: "ak-key",
      },
      monitoring: {
        budgetAmount: 50,
        alarmEmail: "test@example.com",
      },
    };
    fs.writeFileSync(tmpFile, JSON.stringify(validConfig));
    try {
      const loaded = loadConfig(tmpFile);
      expect(loaded.clientId).toBe("my-client");
      expect(loaded.region).toBe("ap-southeast-2");
    } finally {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    }
  });
});
