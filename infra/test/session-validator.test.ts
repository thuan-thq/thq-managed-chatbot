import {
  validateSession,
  transitionSession,
  SessionRecord,
} from "../lambda/chat/session-validator";

// ─── Fixture factory ──────────────────────────────────────────────────────────

const BASE_CREATED_AT = "2024-06-01T12:00:00.000Z";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "sess-abc",
    clientId: "acme-corp",
    status: "active",
    createdAt: BASE_CREATED_AT,
    lastActiveAt: BASE_CREATED_AT,
    turnCount: 0,
    tokensUsed: 0,
    sessionDuration: 30, // minutes
    turnLimit: 50,
    tokenBudget: 8000,
    TTL: 9999999999,
    ...overrides,
  };
}

/** Return a Date that is `minutes` minutes after the base creation time. */
function minutesLater(minutes: number): Date {
  return new Date(new Date(BASE_CREATED_AT).getTime() + minutes * 60 * 1000);
}

// ─── validateSession ──────────────────────────────────────────────────────────

describe("validateSession()", () => {
  // ── Active session within all limits ──────────────────────────────────────

  it("returns valid: true for an active session within all limits", () => {
    const session = makeSession();
    const result = validateSession(session, minutesLater(10));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.session).toEqual(session);
    }
  });

  it("returns valid: true at the boundary (exactly sessionDuration elapsed)", () => {
    // Elapsed = exactly sessionDuration — should still be valid (rule uses >)
    const session = makeSession({ sessionDuration: 30 });
    const result = validateSession(session, minutesLater(30));
    expect(result.valid).toBe(true);
  });

  // ── Duration expiry ───────────────────────────────────────────────────────

  it("returns expired 401 when elapsed time exceeds sessionDuration", () => {
    const session = makeSession({ sessionDuration: 30 });
    const result = validateSession(session, minutesLater(31));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe("session_expired");
    }
  });

  it("returns expired 401 when far past duration", () => {
    const session = makeSession({ sessionDuration: 30 });
    const result = validateSession(session, minutesLater(120));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("session_expired");
    }
  });

  // ── Turn limit ────────────────────────────────────────────────────────────

  it("returns exhausted 401 when turnCount equals turnLimit", () => {
    const session = makeSession({ turnCount: 50, turnLimit: 50 });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe("session_exhausted");
    }
  });

  it("returns exhausted 401 when turnCount exceeds turnLimit", () => {
    const session = makeSession({ turnCount: 51, turnLimit: 50 });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("session_exhausted");
    }
  });

  it("returns valid: true when turnCount is one below the limit", () => {
    const session = makeSession({ turnCount: 49, turnLimit: 50 });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(true);
  });

  // ── Token budget ──────────────────────────────────────────────────────────

  it("returns exhausted 401 when tokensUsed equals tokenBudget", () => {
    const session = makeSession({ tokensUsed: 8000, tokenBudget: 8000 });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe("session_exhausted");
    }
  });

  it("returns exhausted 401 when tokensUsed exceeds tokenBudget", () => {
    const session = makeSession({ tokensUsed: 9000, tokenBudget: 8000 });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("session_exhausted");
    }
  });

  it("returns valid: true when tokensUsed is one below the budget", () => {
    const session = makeSession({ tokensUsed: 7999, tokenBudget: 8000 });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(true);
  });

  // ── Terminal states ───────────────────────────────────────────────────────

  it("rejects an already-expired session with 401 session_expired", () => {
    const session = makeSession({ status: "expired" });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe("session_expired");
    }
  });

  it("rejects an already-exhausted session with 401 session_exhausted", () => {
    const session = makeSession({ status: "exhausted" });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe("session_exhausted");
    }
  });

  it("expired terminal state rejects even if duration has not elapsed", () => {
    // Status is already expired — regardless of timing it should reject
    const session = makeSession({ status: "expired", sessionDuration: 60 });
    const result = validateSession(session, minutesLater(5));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("session_expired");
    }
  });

  it("exhausted terminal state rejects even if under all limits", () => {
    // Status is already exhausted — counters are irrelevant
    const session = makeSession({
      status: "exhausted",
      turnCount: 0,
      tokensUsed: 0,
    });
    const result = validateSession(session, minutesLater(1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("session_exhausted");
    }
  });

  // ── Default now ───────────────────────────────────────────────────────────

  it("uses current time when now is not provided", () => {
    // Session created very recently (1 ms ago) should be valid
    const createdAt = new Date(Date.now() - 1).toISOString();
    const session = makeSession({ createdAt, lastActiveAt: createdAt });
    const result = validateSession(session);
    expect(result.valid).toBe(true);
  });
});

// ─── transitionSession ────────────────────────────────────────────────────────

describe("transitionSession()", () => {
  const TRANSITION_NOW = minutesLater(5);

  it("increments turnCount by 1", () => {
    const session = makeSession({ turnCount: 3 });
    const next = transitionSession(session, 100, TRANSITION_NOW);
    expect(next.turnCount).toBe(4);
  });

  it("adds tokensUsedThisTurn to tokensUsed", () => {
    const session = makeSession({ tokensUsed: 500 });
    const next = transitionSession(session, 200, TRANSITION_NOW);
    expect(next.tokensUsed).toBe(700);
  });

  it("updates lastActiveAt to the provided now timestamp", () => {
    const session = makeSession();
    const next = transitionSession(session, 0, TRANSITION_NOW);
    expect(next.lastActiveAt).toBe(TRANSITION_NOW.toISOString());
  });

  it("keeps status active when limits are not yet reached", () => {
    const session = makeSession({
      turnCount: 10,
      turnLimit: 50,
      tokensUsed: 100,
      tokenBudget: 8000,
    });
    const next = transitionSession(session, 100, TRANSITION_NOW);
    expect(next.status).toBe("active");
  });

  it("transitions to exhausted when new turnCount reaches turnLimit", () => {
    const session = makeSession({ turnCount: 49, turnLimit: 50 });
    const next = transitionSession(session, 1, TRANSITION_NOW);
    expect(next.turnCount).toBe(50);
    expect(next.status).toBe("exhausted");
  });

  it("transitions to exhausted when new turnCount exceeds turnLimit", () => {
    const session = makeSession({ turnCount: 50, turnLimit: 50 });
    const next = transitionSession(session, 1, TRANSITION_NOW);
    expect(next.status).toBe("exhausted");
  });

  it("transitions to exhausted when new tokensUsed reaches tokenBudget", () => {
    const session = makeSession({ tokensUsed: 7900, tokenBudget: 8000 });
    const next = transitionSession(session, 100, TRANSITION_NOW);
    expect(next.tokensUsed).toBe(8000);
    expect(next.status).toBe("exhausted");
  });

  it("transitions to exhausted when new tokensUsed exceeds tokenBudget", () => {
    const session = makeSession({ tokensUsed: 7999, tokenBudget: 8000 });
    const next = transitionSession(session, 500, TRANSITION_NOW);
    expect(next.status).toBe("exhausted");
  });

  it("does not mutate the original session object", () => {
    const session = makeSession({ turnCount: 5 });
    transitionSession(session, 100, TRANSITION_NOW);
    expect(session.turnCount).toBe(5);
  });

  it("does not alter sessionDuration, turnLimit, tokenBudget, or clientId", () => {
    const session = makeSession({
      sessionDuration: 45,
      turnLimit: 25,
      tokenBudget: 4000,
      clientId: "acme",
    });
    const next = transitionSession(session, 50, TRANSITION_NOW);
    expect(next.sessionDuration).toBe(45);
    expect(next.turnLimit).toBe(25);
    expect(next.tokenBudget).toBe(4000);
    expect(next.clientId).toBe("acme");
  });

  it("does NOT transition to expired (duration check is validateSession's responsibility)", () => {
    // Even if we're way past duration, transitionSession must not set expired
    const session = makeSession({ status: "active", sessionDuration: 1 });
    const longAfter = minutesLater(999);
    const next = transitionSession(session, 1, longAfter);
    // Should be active (no limits exceeded) — duration is NOT checked here
    expect(next.status).toBe("active");
  });

  it("uses current time when now is not provided", () => {
    const session = makeSession();
    const before = new Date();
    const next = transitionSession(session, 0);
    const after = new Date();
    const lastActive = new Date(next.lastActiveAt);
    expect(lastActive.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lastActive.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
