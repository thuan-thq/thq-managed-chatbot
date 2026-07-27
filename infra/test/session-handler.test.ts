import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

import {
  generateSessionToken,
  clampSessionDuration,
  createSession,
  handler,
  SessionCreateEvent,
} from "../lambda/chat/session-handler";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type SendFn = (cmd: unknown) => Promise<unknown>;

function makeDdbClient(sendFn: SendFn): DynamoDBClient {
  const client = Object.create(DynamoDBClient.prototype) as DynamoDBClient;
  (client as unknown as { send: SendFn }).send = sendFn;
  return client;
}

/** Captures calls to DynamoDB PutItem and resolves successfully. */
function captureClient(): {
  client: DynamoDBClient;
  calls: PutItemCommand[];
} {
  const calls: PutItemCommand[] = [];
  const client = makeDdbClient(async (cmd: unknown) => {
    calls.push(cmd as PutItemCommand);
    return {};
  });
  return { client, calls };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("generateSessionToken()", () => {
  it("returns a hex string of at least 32 characters (128 bits)", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("returns a 64-character hex string (256-bit token)", () => {
    const token = generateSessionToken();
    expect(token.length).toBe(64);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateSessionToken()),
    );
    expect(tokens.size).toBe(100);
  });
});

describe("clampSessionDuration()", () => {
  it("uses default (30) when no value is provided", () => {
    expect(clampSessionDuration()).toBe(30);
    expect(clampSessionDuration(undefined)).toBe(30);
  });

  it("clamps values below 1 minute to 1", () => {
    expect(clampSessionDuration(0)).toBe(1);
    expect(clampSessionDuration(-10)).toBe(1);
  });

  it("clamps values above 120 minutes to 120", () => {
    expect(clampSessionDuration(121)).toBe(120);
    expect(clampSessionDuration(999)).toBe(120);
  });

  it("passes through valid values unchanged", () => {
    expect(clampSessionDuration(1)).toBe(1);
    expect(clampSessionDuration(60)).toBe(60);
    expect(clampSessionDuration(120)).toBe(120);
  });

  it("handles boundary values exactly", () => {
    expect(clampSessionDuration(1)).toBe(1);
    expect(clampSessionDuration(120)).toBe(120);
  });
});

describe("createSession()", () => {
  const TABLE = "Sessions";
  const CLIENT = "acme-corp";

  it("calls DynamoDB PutItem with correct attributes", async () => {
    const { client, calls } = captureClient();
    const now = new Date("2024-06-01T12:00:00.000Z");

    await createSession(CLIENT, {}, client, TABLE, now);

    expect(calls).toHaveLength(1);
    const item = calls[0].input.Item!;

    // Keys
    expect(item.PK.S).toMatch(/^SESSION#[0-9a-f]{64}$/);
    expect(item.SK.S).toBe("META");

    // Client & status
    expect(item.clientId.S).toBe(CLIENT);
    expect(item.status.S).toBe("active");

    // Initial counters
    expect(item.turnCount.N).toBe("0");
    expect(item.tokensUsed.N).toBe("0");

    // Timestamps
    expect(item.createdAt.S).toBe("2024-06-01T12:00:00.000Z");
    expect(item.lastActiveAt.S).toBe("2024-06-01T12:00:00.000Z");

    // Defaults
    expect(item.sessionDuration.N).toBe("30");
    expect(item.turnLimit.N).toBe("50");
    expect(item.tokenBudget.N).toBe("8000");

    // TTL should be 7 days from now in seconds
    const expectedTtl =
      Math.floor(new Date("2024-06-01T12:00:00.000Z").getTime() / 1000) +
      7 * 24 * 60 * 60;
    expect(Number(item.TTL.N)).toBe(expectedTtl);
  });

  it("uses the custom sessionDuration when provided", async () => {
    const { client, calls } = captureClient();

    await createSession(CLIENT, { sessionDuration: 45 }, client, TABLE);

    expect(calls[0].input.Item!.sessionDuration.N).toBe("45");
  });

  it("clamps sessionDuration below minimum to 1", async () => {
    const { client, calls } = captureClient();

    await createSession(CLIENT, { sessionDuration: 0 }, client, TABLE);

    expect(calls[0].input.Item!.sessionDuration.N).toBe("1");
  });

  it("clamps sessionDuration above maximum to 120", async () => {
    const { client, calls } = captureClient();

    await createSession(CLIENT, { sessionDuration: 300 }, client, TABLE);

    expect(calls[0].input.Item!.sessionDuration.N).toBe("120");
  });

  it("applies custom turnLimit and tokenBudget", async () => {
    const { client, calls } = captureClient();

    await createSession(
      CLIENT,
      { turnLimit: 10, tokenBudget: 4000 },
      client,
      TABLE,
    );

    expect(calls[0].input.Item!.turnLimit.N).toBe("10");
    expect(calls[0].input.Item!.tokenBudget.N).toBe("4000");
  });

  it("returns a sessionId and token that are both 64-char hex strings", async () => {
    const { client } = captureClient();
    const result = await createSession(CLIENT, {}, client, TABLE);

    expect(result.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns distinct sessionId and token", async () => {
    const { client } = captureClient();
    const result = await createSession(CLIENT, {}, client, TABLE);
    expect(result.sessionId).not.toBe(result.token);
  });

  it("table name is forwarded to the PutItem command", async () => {
    const { client, calls } = captureClient();

    await createSession(CLIENT, {}, client, "MyCustomTable");

    expect(calls[0].input.TableName).toBe("MyCustomTable");
  });
});

describe("handler()", () => {
  const TABLE_ENV = "SESSIONS_TABLE_NAME";

  beforeEach(() => {
    process.env[TABLE_ENV] = "SessionsTable";
  });

  afterEach(() => {
    delete process.env[TABLE_ENV];
  });

  it("returns 201 with sessionId and token in body", async () => {
    // We cannot inject a mock DynamoDB client into the handler's private
    // singleton directly, so we exercise the handler end-to-end relying on
    // DynamoDB being mocked at the module boundary via jest.spyOn.
    // Instead, spy on PutItemCommand send to avoid real AWS calls.
    jest
      .spyOn(DynamoDBClient.prototype, "send")
      .mockResolvedValueOnce({} as never);

    const event: SessionCreateEvent = {
      requestContext: {
        authorizer: { lambda: { clientId: "acme-corp" } },
      },
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(201);
    expect(response.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(response.body);
    expect(body.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 500 when SESSIONS_TABLE_NAME is not set", async () => {
    delete process.env[TABLE_ENV];

    const event: SessionCreateEvent = {};
    const response = await handler(event);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.message).toContain("SESSIONS_TABLE_NAME");
  });

  it("returns 400 for malformed JSON body", async () => {
    const event: SessionCreateEvent = { body: "not-json{{" };
    const response = await handler(event);
    expect(response.statusCode).toBe(400);
  });

  it("returns token with at least 32 hex characters (128-bit minimum)", async () => {
    jest
      .spyOn(DynamoDBClient.prototype, "send")
      .mockResolvedValueOnce({} as never);

    const event: SessionCreateEvent = {
      requestContext: { authorizer: { lambda: { clientId: "test" } } },
    };

    const response = await handler(event);
    const body = JSON.parse(response.body);

    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(body.token).toMatch(/^[0-9a-f]+$/);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });
});
