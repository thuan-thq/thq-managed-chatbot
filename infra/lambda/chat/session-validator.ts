// ─── Domain types ─────────────────────────────────────────────────────────────

/** Mirrors the DynamoDB Sessions table row with JS-native types. */
export interface SessionRecord {
  sessionId: string;
  clientId: string;
  status: "active" | "expired" | "exhausted";
  createdAt: string; // ISO 8601
  lastActiveAt: string; // ISO 8601
  turnCount: number;
  tokensUsed: number;
  sessionDuration: number; // minutes
  turnLimit: number;
  tokenBudget: number;
  TTL: number; // Unix epoch seconds (DynamoDB auto-delete)
}

/** Result of validating a session before processing a request. */
export type SessionValidationResult =
  | { valid: true; session: SessionRecord }
  | {
      valid: false;
      statusCode: 401;
      errorCode: "session_expired" | "session_exhausted";
      reason: string;
    };

// ─── validateSession ──────────────────────────────────────────────────────────

/**
 * Validates whether a session is still usable.
 *
 * Rules (applied in order):
 *  1. Terminal states (expired / exhausted) immediately reject with 401.
 *  2. Active session whose elapsed time > sessionDuration → expired → reject.
 *  3. Active session whose turnCount ≥ turnLimit → exhausted → reject.
 *  4. Active session whose tokensUsed ≥ tokenBudget → exhausted → reject.
 *  5. Otherwise, return valid.
 *
 * The `now` parameter is injectable for testing purposes (defaults to `new Date()`).
 */
export function validateSession(
  session: SessionRecord,
  now: Date = new Date(),
): SessionValidationResult {
  // ── 1. Terminal states are absorbing ──────────────────────────────────────
  if (session.status === "expired") {
    return {
      valid: false,
      statusCode: 401,
      errorCode: "session_expired",
      reason: "Session has already expired",
    };
  }

  if (session.status === "exhausted") {
    return {
      valid: false,
      statusCode: 401,
      errorCode: "session_exhausted",
      reason: "Session has been exhausted",
    };
  }

  // ── 2. Duration check — active → expired ──────────────────────────────────
  const createdAt = new Date(session.createdAt);
  const elapsedMs = now.getTime() - createdAt.getTime();
  const elapsedMinutes = elapsedMs / (60 * 1000);

  if (elapsedMinutes > session.sessionDuration) {
    return {
      valid: false,
      statusCode: 401,
      errorCode: "session_expired",
      reason: `Session expired after ${session.sessionDuration} minutes`,
    };
  }

  // ── 3. Turn limit — active → exhausted ───────────────────────────────────
  if (session.turnCount >= session.turnLimit) {
    return {
      valid: false,
      statusCode: 401,
      errorCode: "session_exhausted",
      reason: `Session exhausted: turn limit of ${session.turnLimit} reached`,
    };
  }

  // ── 4. Token budget — active → exhausted ─────────────────────────────────
  if (session.tokensUsed >= session.tokenBudget) {
    return {
      valid: false,
      statusCode: 401,
      errorCode: "session_exhausted",
      reason: `Session exhausted: token budget of ${session.tokenBudget} reached`,
    };
  }

  // ── 5. Session is usable ──────────────────────────────────────────────────
  return { valid: true, session };
}

// ─── transitionSession ────────────────────────────────────────────────────────

/**
 * Records the result of a completed turn on a session.
 *
 * - Increments `turnCount` by 1.
 * - Adds `tokensUsedThisTurn` to `tokensUsed`.
 * - Updates `lastActiveAt` to `now` (defaults to `new Date()`).
 * - If the new `turnCount >= turnLimit` OR new `tokensUsed >= tokenBudget`,
 *   transitions `status` to `exhausted`.
 * - Does NOT check duration expiry — that is handled by `validateSession`.
 *
 * Returns a new `SessionRecord` object (does not mutate the input).
 */
export function transitionSession(
  session: SessionRecord,
  tokensUsedThisTurn: number,
  now: Date = new Date(),
): SessionRecord {
  const newTurnCount = session.turnCount + 1;
  const newTokensUsed = session.tokensUsed + tokensUsedThisTurn;
  const newLastActiveAt = now.toISOString();

  const isExhausted =
    newTurnCount >= session.turnLimit || newTokensUsed >= session.tokenBudget;

  return {
    ...session,
    turnCount: newTurnCount,
    tokensUsed: newTokensUsed,
    lastActiveAt: newLastActiveAt,
    status: isExhausted ? "exhausted" : session.status,
  };
}
