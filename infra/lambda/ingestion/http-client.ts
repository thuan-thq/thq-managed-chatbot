/**
 * Shared HTTP client wrapper with retry logic and exponential backoff.
 *
 * Provides a resilient HTTP client for data source adapters that automatically
 * retries failed requests on 5xx responses and connection/read timeouts.
 *
 * Retry behaviour:
 * - Maximum retries: 3 (configurable)
 * - Base delay: 1 second (configurable)
 * - Maximum delay: 10 seconds (configurable)
 * - Backoff formula: min(baseDelay * 2^attempt, maxDelay) + jitter
 * - Jitter: random value between 0 and 50% of the computed delay
 *
 * Retryable conditions:
 * - HTTP 5xx status codes (server errors)
 * - AbortError (request timeout via AbortController)
 * - TypeError with network-related messages (connection refused, DNS failures)
 *
 * Non-retryable conditions:
 * - HTTP 4xx status codes (client errors)
 * - Other non-5xx responses
 *
 * Requirements: 5.3
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Configuration for the retry HTTP client. */
export interface RetryHttpClientConfig {
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds cap (default: 10000). */
  maxDelayMs?: number;
  /** Request timeout in milliseconds (default: 30000). */
  requestTimeoutMs?: number;
}

/** Options for an individual HTTP request. */
export interface HttpRequestOptions {
  /** HTTP method (default: "GET"). */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body (for POST, PUT, PATCH). */
  body?: string;
  /** Override the default request timeout for this request (ms). */
  timeoutMs?: number;
}

/** Represents a successful HTTP response. */
export interface HttpResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers. */
  headers: Record<string, string>;
  /** Response body as text. */
  body: string;
}

/** Error thrown when all retries are exhausted. */
export class HttpRetryError extends Error {
  /** The HTTP status code from the last attempt (if available). */
  public readonly statusCode?: number;
  /** The number of attempts made (initial + retries). */
  public readonly attempts: number;
  /** The underlying error from the last attempt. */
  public readonly lastError: Error;

  constructor(
    message: string,
    opts: { statusCode?: number; attempts: number; lastError: Error },
  ) {
    super(message);
    this.name = "HttpRetryError";
    this.statusCode = opts.statusCode;
    this.attempts = opts.attempts;
    this.lastError = opts.lastError;
  }
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<RetryHttpClientConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  requestTimeoutMs: 30000,
};

// ─── Retry HTTP Client ───────────────────────────────────────────────────────

/**
 * HTTP client with automatic retry logic and exponential backoff.
 *
 * Designed to be shared across all data source adapters (Strapi, Monday.com,
 * Employment Hero) to provide consistent retry behaviour when calling
 * external APIs.
 *
 * Validates: Requirement 5.3
 */
export class RetryHttpClient {
  private readonly config: Required<RetryHttpClientConfig>;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  /**
   * Creates a new RetryHttpClient.
   *
   * @param config - Retry and timeout configuration
   * @param fetchFn - Optional fetch implementation (defaults to global fetch, useful for testing)
   * @param sleepFn - Optional sleep implementation (defaults to setTimeout-based, useful for testing)
   */
  constructor(
    config: RetryHttpClientConfig = {},
    fetchFn?: typeof fetch,
    sleepFn?: (ms: number) => Promise<void>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.sleepFn =
      sleepFn ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Executes an HTTP request with automatic retries on retryable failures.
   *
   * @param url - The URL to request
   * @param options - Request options (method, headers, body, timeout)
   * @returns The HTTP response on success
   * @throws {HttpRetryError} When all retries are exhausted
   */
  async request(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse> {
    const maxAttempts = this.config.maxRetries + 1; // initial attempt + retries
    let lastError: Error | undefined;
    let lastStatusCode: number | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.executeRequest(url, options);

        // Success - return immediately
        if (response.status < 500) {
          return response;
        }

        // 5xx - retryable server error
        lastStatusCode = response.status;
        lastError = new Error(
          `HTTP ${response.status}: ${response.body.substring(0, 200)}`,
        );
      } catch (error) {
        // Check if this is a retryable network/timeout error
        if (this.isRetryableError(error)) {
          lastError = error as Error;
          lastStatusCode = undefined;
        } else {
          // Non-retryable error (e.g. programming error) - throw immediately
          throw error;
        }
      }

      // If this isn't the last attempt, wait with exponential backoff
      if (attempt < maxAttempts - 1) {
        const delay = this.calculateDelay(attempt);
        await this.sleepFn(delay);
      }
    }

    // All retries exhausted - propagate failure with last error details
    throw new HttpRetryError(
      `Request to ${url} failed after ${maxAttempts} attempts: ${lastError?.message}`,
      {
        statusCode: lastStatusCode,
        attempts: maxAttempts,
        lastError: lastError!,
      },
    );
  }

  /**
   * Executes a single HTTP request with a timeout via AbortController.
   */
  private async executeRequest(
    url: string,
    options: HttpRequestOptions,
  ): Promise<HttpResponse> {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        headers,
        body,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Determines if an error is retryable (network error or timeout).
   */
  private isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    // AbortError indicates a request timeout via AbortController
    if (error.name === "AbortError") {
      return true;
    }

    // TypeError with network-related messages indicates connection failures
    if (error.name === "TypeError") {
      const message = error.message.toLowerCase();
      return (
        message.includes("fetch failed") ||
        message.includes("network") ||
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("etimedout") ||
        message.includes("enotfound")
      );
    }

    return false;
  }

  /**
   * Calculates the backoff delay for a given attempt.
   *
   * Formula: min(baseDelay * 2^attempt, maxDelay) + jitter
   * Jitter is a random value between 0 and 50% of the computed delay.
   *
   * @param attempt - Zero-based attempt index
   * @returns Delay in milliseconds
   */
  calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    const jitter = Math.random() * cappedDelay * 0.5;
    return cappedDelay + jitter;
  }
}
