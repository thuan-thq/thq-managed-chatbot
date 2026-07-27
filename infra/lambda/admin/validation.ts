/**
 * Configuration validation logic for the Admin Lambda.
 *
 * Validates partial configuration updates against the defined schema,
 * collecting ALL validation errors (not failing on first).
 *
 * Requirements: 10.4, 10.5
 */

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validates a partial configuration update object.
 * Returns all validation errors at once (does not fail on first).
 */
export function validateConfigUpdate(
  update: Record<string, unknown>,
): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate clientId if provided
  if ("clientId" in update) {
    const clientId = update.clientId;
    if (typeof clientId !== "string" || !/^[a-z0-9-]{3,63}$/.test(clientId)) {
      errors.push({
        field: "clientId",
        message:
          "clientId must be lowercase alphanumeric plus hyphens, between 3 and 63 characters",
        value: clientId,
      });
    }
  }

  // Validate rateLimits if provided
  if ("rateLimits" in update && update.rateLimits != null) {
    const rateLimits = update.rateLimits as Record<string, unknown>;
    if ("requestsPerMinute" in rateLimits) {
      const rpm = rateLimits.requestsPerMinute;
      if (
        typeof rpm !== "number" ||
        !Number.isFinite(rpm) ||
        rpm < 1 ||
        rpm > 1000
      ) {
        errors.push({
          field: "rateLimits.requestsPerMinute",
          message: "requestsPerMinute must be between 1 and 1000",
          value: rpm,
        });
      }
    }
  }

  // Validate session if provided
  if ("session" in update && update.session != null) {
    const session = update.session as Record<string, unknown>;

    if ("duration" in session) {
      const duration = session.duration;
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 1 ||
        duration > 120
      ) {
        errors.push({
          field: "session.duration",
          message: "session duration must be between 1 and 120 minutes",
          value: duration,
        });
      }
    }

    if ("turnLimit" in session) {
      const turnLimit = session.turnLimit;
      if (
        typeof turnLimit !== "number" ||
        !Number.isFinite(turnLimit) ||
        turnLimit < 1 ||
        turnLimit > 500
      ) {
        errors.push({
          field: "session.turnLimit",
          message: "session turnLimit must be between 1 and 500",
          value: turnLimit,
        });
      }
    }

    if ("tokenBudget" in session) {
      const tokenBudget = session.tokenBudget;
      if (
        typeof tokenBudget !== "number" ||
        !Number.isFinite(tokenBudget) ||
        tokenBudget < 1000 ||
        tokenBudget > 100000
      ) {
        errors.push({
          field: "session.tokenBudget",
          message: "session tokenBudget must be between 1000 and 100000",
          value: tokenBudget,
        });
      }
    }

    if ("retentionDays" in session) {
      const retentionDays = session.retentionDays;
      if (
        typeof retentionDays !== "number" ||
        !Number.isFinite(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 365
      ) {
        errors.push({
          field: "session.retentionDays",
          message: "session retentionDays must be between 1 and 365",
          value: retentionDays,
        });
      }
    }
  }

  // Validate monitoring if provided
  if ("monitoring" in update && update.monitoring != null) {
    const monitoring = update.monitoring as Record<string, unknown>;

    if ("budgetAmount" in monitoring) {
      const budgetAmount = monitoring.budgetAmount;
      if (
        typeof budgetAmount !== "number" ||
        !Number.isFinite(budgetAmount) ||
        budgetAmount <= 0
      ) {
        errors.push({
          field: "monitoring.budgetAmount",
          message: "monitoring budgetAmount must be greater than 0",
          value: budgetAmount,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
