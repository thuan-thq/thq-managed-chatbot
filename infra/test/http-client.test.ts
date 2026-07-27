import {
  RetryHttpClient,
  HttpRetryError,
  RetryHttpClientConfig,
} from "../lambda/ingestion/http-client";

/**
 * Unit tests for RetryHttpClient.
 * Validates: Requirement 5.3
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a mock fetch function from a sequence of responses/errors. */
function createMockFetch(
  responses: Array<{ status: number; body?: string } | Error>,
): jest.Mock {
  const mockFn = jest.fn();
  responses.forEach((resp, index) => {
    if (resp instanceof Error) {
      mockFn.mockRejectedValueOnce(resp);
    } else {
      mockFn.mockResolvedValueOnce({
        status: resp.status,
        text: async () => resp.body ?? "",
        headers: new Map([["content-type", "application/json"]]),
      });
    }
  });
  return mockFn;
}

/** A no-op sleep function for testing (resolves immediately). */
const noopSleep = async (_ms: number): Promise<void> => {};

/** A sleep tracker that records delay values. */
function createSleepTracker() {
  const delays: number[] = [];
  const sleepFn = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { delays, sleepFn };
}

/** Default test config with fast timeouts. */
const testConfig: RetryHttpClientConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  requestTimeoutMs: 5000,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("RetryHttpClient", () => {
  describe("successful request on first attempt", () => {
    it("returns the response without retrying", async () => {
      const mockFetch = createMockFetch([{ status: 200, body: '{"ok":true}' }]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(200);
      expect(response.body).toBe('{"ok":true}');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns 4xx responses without retrying", async () => {
      const mockFetch = createMockFetch([{ status: 404, body: "Not Found" }]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/missing");

      expect(response.status).toBe(404);
      expect(response.body).toBe("Not Found");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry on 5xx with eventual success", () => {
    it("retries on 500 and succeeds on second attempt", async () => {
      const mockFetch = createMockFetch([
        { status: 500, body: "Internal Server Error" },
        { status: 200, body: '{"ok":true}' },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 502 and succeeds on third attempt", async () => {
      const mockFetch = createMockFetch([
        { status: 502, body: "Bad Gateway" },
        { status: 503, body: "Service Unavailable" },
        { status: 200, body: '{"data":"ok"}' },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(200);
      expect(response.body).toBe('{"data":"ok"}');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("retry on timeout/network error with eventual success", () => {
    it("retries on AbortError (timeout) and succeeds", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";

      const mockFetch = createMockFetch([
        abortError,
        { status: 200, body: '{"ok":true}' },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on network TypeError (fetch failed) and succeeds", async () => {
      const networkError = new TypeError("fetch failed");

      const mockFetch = createMockFetch([
        networkError,
        { status: 200, body: '{"ok":true}' },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on ECONNREFUSED and succeeds", async () => {
      const connError = new TypeError("ECONNREFUSED: connection refused");

      const mockFetch = createMockFetch([
        connError,
        { status: 200, body: "ok" },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("all retries exhausted - error propagated with details", () => {
    it("throws HttpRetryError after all retries on 5xx", async () => {
      const mockFetch = createMockFetch([
        { status: 500, body: "Error 1" },
        { status: 502, body: "Error 2" },
        { status: 503, body: "Error 3" },
        { status: 500, body: "Error 4" },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      try {
        await client.request("https://api.example.com/data");
        fail("Should have thrown");
      } catch (error) {
        const retryError = error as HttpRetryError;
        expect(retryError).toBeInstanceOf(HttpRetryError);
        expect(retryError.name).toBe("HttpRetryError");
        expect(retryError.attempts).toBe(4); // 1 initial + 3 retries
        expect(retryError.statusCode).toBe(500);
        expect(retryError.lastError).toBeDefined();
        expect(retryError.message).toContain("https://api.example.com/data");
        expect(retryError.message).toContain("4 attempts");
      }

      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("throws HttpRetryError after all retries on timeout", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";

      const mockFetch = createMockFetch([
        abortError,
        abortError,
        abortError,
        abortError,
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      try {
        await client.request("https://api.example.com/data");
        fail("Should have thrown");
      } catch (error) {
        const retryError = error as HttpRetryError;
        expect(retryError).toBeInstanceOf(HttpRetryError);
        expect(retryError.attempts).toBe(4);
        expect(retryError.statusCode).toBeUndefined(); // timeout has no status code
        expect(retryError.lastError.name).toBe("AbortError");
      }
    });
  });

  describe("exponential backoff delays increase correctly", () => {
    it("applies exponential backoff between retries", async () => {
      const { delays, sleepFn } = createSleepTracker();
      const mockFetch = createMockFetch([
        { status: 500, body: "Error" },
        { status: 500, body: "Error" },
        { status: 500, body: "Error" },
        { status: 500, body: "Error" },
      ]);

      const client = new RetryHttpClient(testConfig, mockFetch as any, sleepFn);

      try {
        await client.request("https://api.example.com/data");
      } catch {
        // Expected to throw
      }

      // 3 retries = 3 delays
      expect(delays).toHaveLength(3);

      // Verify delays increase (accounting for jitter: delay = cappedDelay + jitter)
      // Attempt 0: min(1000 * 2^0, 10000) = 1000, + jitter [0, 500] -> [1000, 1500]
      // Attempt 1: min(1000 * 2^1, 10000) = 2000, + jitter [0, 1000] -> [2000, 3000]
      // Attempt 2: min(1000 * 2^2, 10000) = 4000, + jitter [0, 2000] -> [4000, 6000]
      expect(delays[0]).toBeGreaterThanOrEqual(1000);
      expect(delays[0]).toBeLessThanOrEqual(1500);
      expect(delays[1]).toBeGreaterThanOrEqual(2000);
      expect(delays[1]).toBeLessThanOrEqual(3000);
      expect(delays[2]).toBeGreaterThanOrEqual(4000);
      expect(delays[2]).toBeLessThanOrEqual(6000);

      // Each delay should be larger than the previous
      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
    });
  });

  describe("max backoff cap is respected", () => {
    it("caps delay at maxDelayMs regardless of attempt number", async () => {
      const config: RetryHttpClientConfig = {
        maxRetries: 3,
        baseDelayMs: 5000,
        maxDelayMs: 10000,
        requestTimeoutMs: 5000,
      };
      const { delays, sleepFn } = createSleepTracker();
      const mockFetch = createMockFetch([
        { status: 500, body: "Error" },
        { status: 500, body: "Error" },
        { status: 500, body: "Error" },
        { status: 500, body: "Error" },
      ]);

      const client = new RetryHttpClient(config, mockFetch as any, sleepFn);

      try {
        await client.request("https://api.example.com/data");
      } catch {
        // Expected
      }

      // With base 5000:
      // Attempt 0: min(5000 * 1, 10000) = 5000, + jitter [0, 2500] -> [5000, 7500]
      // Attempt 1: min(5000 * 2, 10000) = 10000, + jitter [0, 5000] -> [10000, 15000]
      // Attempt 2: min(5000 * 4, 10000) = 10000 (capped), + jitter [0, 5000] -> [10000, 15000]
      expect(delays).toHaveLength(3);

      // Verify the cap: delay should never exceed maxDelay + 50% jitter = 15000
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(15000);
      }

      // Attempt 1 and 2 should both be capped at 10000 base
      expect(delays[1]).toBeGreaterThanOrEqual(10000);
      expect(delays[2]).toBeGreaterThanOrEqual(10000);
    });

    it("calculateDelay never exceeds maxDelay + jitter", () => {
      const config: RetryHttpClientConfig = {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
      };
      const client = new RetryHttpClient(config, jest.fn() as any, noopSleep);

      // Even for very high attempt numbers, delay should be capped
      for (let attempt = 0; attempt < 20; attempt++) {
        const delay = client.calculateDelay(attempt);
        // max possible = 10000 + 5000 (50% jitter) = 15000
        expect(delay).toBeLessThanOrEqual(15000);
        expect(delay).toBeGreaterThanOrEqual(
          Math.min(1000 * Math.pow(2, attempt), 10000),
        );
      }
    });
  });

  describe("non-retryable errors (4xx) are NOT retried", () => {
    it("does not retry on 400 Bad Request", async () => {
      const mockFetch = createMockFetch([{ status: 400, body: "Bad Request" }]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(400);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 401 Unauthorized", async () => {
      const mockFetch = createMockFetch([
        { status: 401, body: "Unauthorized" },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 403 Forbidden", async () => {
      const mockFetch = createMockFetch([{ status: 403, body: "Forbidden" }]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 429 Too Many Requests", async () => {
      const mockFetch = createMockFetch([
        { status: 429, body: "Rate limited" },
      ]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      const response = await client.request("https://api.example.com/data");

      expect(response.status).toBe(429);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry non-network TypeError", async () => {
      const typeError = new TypeError("Cannot read properties of undefined");
      const mockFetch = jest.fn().mockRejectedValueOnce(typeError);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      await expect(
        client.request("https://api.example.com/data"),
      ).rejects.toThrow(TypeError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("request options forwarding", () => {
    it("forwards method, headers, and body to fetch", async () => {
      const mockFetch = createMockFetch([{ status: 200, body: "ok" }]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      await client.request("https://api.example.com/data", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: '{"key":"value"}',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/data",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token",
          },
          body: '{"key":"value"}',
        }),
      );
    });

    it("defaults to GET method when not specified", async () => {
      const mockFetch = createMockFetch([{ status: 200, body: "ok" }]);
      const client = new RetryHttpClient(
        testConfig,
        mockFetch as any,
        noopSleep,
      );

      await client.request("https://api.example.com/data");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/data",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});
