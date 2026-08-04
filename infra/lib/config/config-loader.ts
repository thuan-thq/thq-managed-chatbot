import * as fs from "fs";
import * as path from "path";
import { DeploymentConfig } from "./deployment-config";

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validates a DeploymentConfig object, returning an array of validation errors.
 * An empty array means the config is valid.
 */
export function validateConfig(config: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!config || typeof config !== "object") {
    errors.push({
      field: "root",
      message: "Configuration must be a non-null object",
    });
    return errors;
  }

  const cfg = config as Record<string, unknown>;

  // Validate clientId
  if (typeof cfg.clientId !== "string") {
    errors.push({ field: "clientId", message: "clientId must be a string" });
  } else if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cfg.clientId)) {
    errors.push({
      field: "clientId",
      message:
        "clientId must be 3-63 characters, lowercase alphanumeric and hyphens, starting and ending with alphanumeric",
    });
  }

  // Validate region
  if (cfg.region !== "ap-southeast-2") {
    errors.push({
      field: "region",
      message: 'region must be "ap-southeast-2"',
    });
  }

  // Validate dataSources
  if (!Array.isArray(cfg.dataSources) || cfg.dataSources.length === 0) {
    errors.push({
      field: "dataSources",
      message: "dataSources must be a non-empty array",
    });
  } else {
    const validTypes = ["strapi", "monday", "employment-hero", "craftcms"];
    for (let i = 0; i < cfg.dataSources.length; i++) {
      const ds = cfg.dataSources[i] as Record<string, unknown>;
      const prefix = `dataSources[${i}]`;

      if (!ds.id || typeof ds.id !== "string") {
        errors.push({
          field: `${prefix}.id`,
          message: `${prefix}.id must be a non-empty string`,
        });
      }
      if (!validTypes.includes(ds.type as string)) {
        errors.push({
          field: `${prefix}.type`,
          message: `${prefix}.type must be one of: ${validTypes.join(", ")}`,
        });
      }
      if (typeof ds.apiEndpoint !== "string" || ds.apiEndpoint.length === 0) {
        errors.push({
          field: `${prefix}.apiEndpoint`,
          message: `${prefix}.apiEndpoint must be a non-empty string`,
        });
      }
      if (typeof ds.apiToken !== "string" || ds.apiToken.length === 0) {
        errors.push({
          field: `${prefix}.apiToken`,
          message: `${prefix}.apiToken must be a non-empty string`,
        });
      }
      if (
        typeof ds.webhookSecret !== "string" ||
        ds.webhookSecret.length === 0
      ) {
        errors.push({
          field: `${prefix}.webhookSecret`,
          message: `${prefix}.webhookSecret must be a non-empty string`,
        });
      }
      if (ds.pageSize !== undefined) {
        if (
          typeof ds.pageSize !== "number" ||
          ds.pageSize < 1 ||
          ds.pageSize > 500
        ) {
          errors.push({
            field: `${prefix}.pageSize`,
            message: `${prefix}.pageSize must be between 1 and 500`,
          });
        }
      }
    }
  }

  // Validate session
  if (cfg.session !== undefined) {
    if (typeof cfg.session !== "object" || cfg.session === null) {
      errors.push({ field: "session", message: "session must be an object" });
    } else {
      const s = cfg.session as Record<string, unknown>;
      if (s.duration !== undefined) {
        if (
          typeof s.duration !== "number" ||
          s.duration < 1 ||
          s.duration > 120
        ) {
          errors.push({
            field: "session.duration",
            message: "session.duration must be between 1 and 120 minutes",
          });
        }
      }
      if (s.turnLimit !== undefined) {
        if (
          typeof s.turnLimit !== "number" ||
          s.turnLimit < 1 ||
          s.turnLimit > 500
        ) {
          errors.push({
            field: "session.turnLimit",
            message: "session.turnLimit must be between 1 and 500",
          });
        }
      }
      if (s.tokenBudget !== undefined) {
        if (
          typeof s.tokenBudget !== "number" ||
          s.tokenBudget < 1000 ||
          s.tokenBudget > 100000
        ) {
          errors.push({
            field: "session.tokenBudget",
            message: "session.tokenBudget must be between 1000 and 100000",
          });
        }
      }
      if (s.retentionDays !== undefined) {
        if (
          typeof s.retentionDays !== "number" ||
          s.retentionDays < 1 ||
          s.retentionDays > 365
        ) {
          errors.push({
            field: "session.retentionDays",
            message: "session.retentionDays must be between 1 and 365",
          });
        }
      }
    }
  }

  // Validate rateLimit
  if (cfg.rateLimit !== undefined) {
    if (typeof cfg.rateLimit !== "object" || cfg.rateLimit === null) {
      errors.push({
        field: "rateLimit",
        message: "rateLimit must be an object",
      });
    } else {
      const rl = cfg.rateLimit as Record<string, unknown>;
      if (rl.requestsPerMinute !== undefined) {
        if (
          typeof rl.requestsPerMinute !== "number" ||
          rl.requestsPerMinute < 1 ||
          rl.requestsPerMinute > 1000
        ) {
          errors.push({
            field: "rateLimit.requestsPerMinute",
            message: "rateLimit.requestsPerMinute must be between 1 and 1000",
          });
        }
      }
    }
  }

  // Validate apiKeys
  if (!cfg.apiKeys || typeof cfg.apiKeys !== "object") {
    errors.push({ field: "apiKeys", message: "apiKeys must be an object" });
  } else {
    const ak = cfg.apiKeys as Record<string, unknown>;
    if (typeof ak.appKey !== "string" || ak.appKey.length === 0) {
      errors.push({
        field: "apiKeys.appKey",
        message: "apiKeys.appKey must be a non-empty string",
      });
    }
    if (typeof ak.adminKey !== "string" || ak.adminKey.length === 0) {
      errors.push({
        field: "apiKeys.adminKey",
        message: "apiKeys.adminKey must be a non-empty string",
      });
    }
  }

  // Validate monitoring
  if (!cfg.monitoring || typeof cfg.monitoring !== "object") {
    errors.push({
      field: "monitoring",
      message: "monitoring must be an object",
    });
  } else {
    const m = cfg.monitoring as Record<string, unknown>;
    if (typeof m.budgetAmount !== "number" || m.budgetAmount <= 0) {
      errors.push({
        field: "monitoring.budgetAmount",
        message: "monitoring.budgetAmount must be a positive number",
      });
    }
    if (
      typeof m.alarmEmail !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.alarmEmail)
    ) {
      errors.push({
        field: "monitoring.alarmEmail",
        message: "monitoring.alarmEmail must be a valid email address",
      });
    }
  }

  return errors;
}

/**
 * Loads and validates a DeploymentConfig from a JSON file.
 * Throws an error with descriptive messages if validation fails.
 */
export function loadConfig(configPath: string): DeploymentConfig {
  const resolvedPath = path.resolve(configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse configuration file as JSON: ${resolvedPath}`,
    );
  }

  const errors = validateConfig(parsed);
  if (errors.length > 0) {
    const messages = errors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${messages}`);
  }

  return parsed as DeploymentConfig;
}
