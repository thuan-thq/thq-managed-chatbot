import {
  EmploymentHeroAdapter,
  EmploymentHeroAdapterConfig,
} from "../lambda/ingestion/employment-hero-adapter";
import { RetryHttpClient } from "../lambda/ingestion/http-client";

/**
 * Unit tests for EmploymentHeroAdapter.
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultConfig: EmploymentHeroAdapterConfig = {
  baseUrl: "https://api.employmenthero.com/api/v1",
  apiToken: "test-api-token-456",
  organisationId: "org-123",
};

/** Creates a mock RetryHttpClient with predefined responses. */
function createMockHttpClient(
  responses: Array<{ status: number; body: string }>,
): RetryHttpClient {
  const mockRequest = jest.fn();
  responses.forEach((resp) => {
    mockRequest.mockResolvedValueOnce({
      status: resp.status,
      headers: { "content-type": "application/json" },
      body: resp.body,
    });
  });

  const client = new RetryHttpClient({}, jest.fn() as any, async () => {});
  client.request = mockRequest;
  return client;
}

/** Builds an Employment Hero list response. */
function buildListResponse(
  entries: Array<Record<string, unknown>>,
  meta: {
    current_page: number;
    total_pages: number;
    total_count: number;
    per_page: number;
  },
) {
  return { data: entries, meta };
}

/** A valid Employment Hero entry with all required fields. */
function validEntry(
  id: number | string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: `Policy ${id}`,
    body: `<p>Content for policy ${id}</p>`,
    updated_at: "2024-01-15T10:30:00.000Z",
    created_at: "2024-01-10T08:00:00.000Z",
    status: "published",
    category: "HR",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("EmploymentHeroAdapter", () => {
  describe("listContent", () => {
    it("returns transformed records from Employment Hero response", async () => {
      const response = buildListResponse([validEntry(1), validEntry(2)], {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].recordId).toBe("1");
      expect(result.items[0].contentBody).toBe("<p>Content for policy 1</p>");
      expect(result.items[0].contentType).toBe("text/html");
      expect(result.items[0].lastModified).toBe("2024-01-15T10:30:00.000Z");
      expect(result.items[0].metadata).toEqual(
        expect.objectContaining({
          source: "employment-hero",
          organisationId: "org-123",
          recordId: "1",
          name: "Policy 1",
          category: "HR",
        }),
      );
      expect(result.totalCount).toBe(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it("provides nextCursor when there are more pages", async () => {
      const response = buildListResponse([validEntry(1)], {
        current_page: 1,
        total_pages: 3,
        total_count: 3,
        per_page: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 1 });

      expect(result.nextCursor).toBeDefined();
      expect(result.items).toHaveLength(1);
    });

    it("uses cursor to fetch specific page", async () => {
      const response = buildListResponse([validEntry(3)], {
        current_page: 2,
        total_pages: 3,
        total_count: 3,
        per_page: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      // Encode page 2 as cursor
      const cursor = Buffer.from("2").toString("base64");
      const result = await adapter.listContent({ pageSize: 1, cursor });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("3");
      expect(result.nextCursor).toBeDefined();
    });

    it("clamps pageSize to valid range", async () => {
      const response = buildListResponse([], {
        current_page: 1,
        total_pages: 0,
        total_count: 0,
        per_page: 500,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 1000 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toContain("per_page=500");
    });

    it("sends Bearer token in Authorization header", async () => {
      const response = buildListResponse([], {
        current_page: 1,
        total_pages: 0,
        total_count: 0,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 100 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe(
        "Bearer test-api-token-456",
      );
    });

    it("builds correct URL with organisation ID and resource type", async () => {
      const response = buildListResponse([], {
        current_page: 1,
        total_pages: 0,
        total_count: 0,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 100 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toContain("/organisations/org-123/policies?");
    });

    it("uses knowledge_articles resource type when configured", async () => {
      const config: EmploymentHeroAdapterConfig = {
        ...defaultConfig,
        resourceType: "knowledge_articles",
      };
      const response = buildListResponse([], {
        current_page: 1,
        total_pages: 0,
        total_count: 0,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(config, httpClient);

      await adapter.listContent({ pageSize: 100 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toContain(
        "/organisations/org-123/knowledge_articles?",
      );
    });

    it("throws on non-200 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 401, body: "Unauthorized" },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      await expect(adapter.listContent({ pageSize: 100 })).rejects.toThrow(
        "Employment Hero API returned status 401",
      );
    });
  });

  describe("fetchById", () => {
    it("returns a content record for a valid entry", async () => {
      const singleResponse = {
        data: validEntry(42),
      };
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(singleResponse) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("42");

      expect(result).not.toBeNull();
      expect(result!.recordId).toBe("42");
      expect(result!.contentBody).toBe("<p>Content for policy 42</p>");
      expect(result!.lastModified).toBe("2024-01-15T10:30:00.000Z");
    });

    it("builds correct fetch URL with organisation and resource", async () => {
      const singleResponse = { data: validEntry(42) };
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(singleResponse) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      await adapter.fetchById("42");

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toBe(
        "https://api.employmenthero.com/api/v1/organisations/org-123/policies/42",
      );
    });

    it("returns null for 404 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 404, body: "Not Found" },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("999");

      expect(result).toBeNull();
    });

    it("returns null when data is null", async () => {
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify({ data: null }) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("999");

      expect(result).toBeNull();
    });

    it("throws on non-200/404 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 500, body: "Internal Server Error" },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      await expect(adapter.fetchById("1")).rejects.toThrow(
        "Employment Hero API returned status 500",
      );
    });
  });

  describe("detectChanges", () => {
    it("returns all records as created when no checkpoint", async () => {
      const response = buildListResponse([validEntry(1), validEntry(2)], {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.created).toHaveLength(2);
      expect(result.updated).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
      expect(result.checkpoint).toBeDefined();
      expect(new Date(result.checkpoint).getTime()).not.toBeNaN();
    });

    it("uses updated_since filter when checkpoint is provided", async () => {
      const response = buildListResponse([validEntry(3)], {
        current_page: 1,
        total_pages: 1,
        total_count: 1,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const since = "2024-01-20T00:00:00.000Z";
      const result = await adapter.detectChanges(since);

      // Verify the updated_since filter was applied in the URL
      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toContain(
        "updated_since=" + encodeURIComponent(since),
      );

      // Records found with checkpoint should be categorized as updated
      expect(result.updated).toHaveLength(1);
      expect(result.created).toHaveLength(0);
      expect(result.checkpoint).toBeDefined();
    });

    it("paginates through all pages for change detection", async () => {
      const page1 = buildListResponse([validEntry(1)], {
        current_page: 1,
        total_pages: 2,
        total_count: 2,
        per_page: 1,
      });
      const page2 = buildListResponse([validEntry(2)], {
        current_page: 2,
        total_pages: 2,
        total_count: 2,
        per_page: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(page1) },
        { status: 200, body: JSON.stringify(page2) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.created).toHaveLength(2);
      expect((httpClient.request as jest.Mock).mock.calls).toHaveLength(2);
    });

    it("returns valid checkpoint as ISO 8601 timestamp", async () => {
      const response = buildListResponse([], {
        current_page: 1,
        total_pages: 0,
        total_count: 0,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      const date = new Date(result.checkpoint);
      expect(date.getTime()).not.toBeNaN();
      expect(result.checkpoint).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("record transformation - skip invalid records (Requirement 5.5)", () => {
    it("skips entries with missing body content", async () => {
      const entries = [
        { id: 1, name: "No body", updated_at: "2024-01-01T00:00:00.000Z" },
        validEntry(2),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("2");
      expect(result.errors).toContain("1");
    });

    it("skips entries with empty body string", async () => {
      const entries = [
        {
          id: 1,
          name: "Empty body",
          body: "",
          updated_at: "2024-01-01T00:00:00.000Z",
        },
        validEntry(2),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips entries with missing id", async () => {
      const entries = [
        {
          name: "No ID",
          body: "<p>Content</p>",
          updated_at: "2024-01-01T00:00:00.000Z",
        },
        validEntry(2),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("unknown");
    });

    it("skips entries with invalid ISO 8601 timestamp", async () => {
      const entries = [
        { id: 1, body: "<p>Content</p>", updated_at: "not-a-date" },
        validEntry(2),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips entries with content body exceeding 1MB", async () => {
      const largeBody = "x".repeat(1_048_577); // 1MB + 1 byte
      const entries = [
        { id: 1, body: largeBody, updated_at: "2024-01-01T00:00:00.000Z" },
        validEntry(2),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips entries with recordId exceeding 256 characters", async () => {
      const longId = "a".repeat(257);
      const entries = [
        {
          id: longId,
          body: "<p>Content</p>",
          updated_at: "2024-01-01T00:00:00.000Z",
        },
        validEntry(2),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 2,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("2");
    });

    it("falls back to created_at when updated_at is missing", async () => {
      const entries = [
        {
          id: 1,
          body: "<p>Content</p>",
          created_at: "2024-01-10T08:00:00.000Z",
        },
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 1,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastModified).toBe("2024-01-10T08:00:00.000Z");
    });

    it("continues processing after skipping invalid records", async () => {
      const entries = [
        { id: 1, updated_at: "2024-01-01T00:00:00.000Z" }, // invalid - no body
        validEntry(2),
        { id: 3, body: "<p>text</p>", updated_at: "invalid" }, // invalid - bad timestamp
        validEntry(4),
        validEntry(5),
      ];
      const response = buildListResponse(entries, {
        current_page: 1,
        total_pages: 1,
        total_count: 5,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(3);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContain("1");
      expect(result.errors).toContain("3");
    });
  });

  describe("ContentRecord format conformance (Requirement 5.1)", () => {
    it("produces records with all required fields", async () => {
      const response = buildListResponse([validEntry(1)], {
        current_page: 1,
        total_pages: 1,
        total_count: 1,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });
      const record = result.items[0];

      // recordId: non-empty, max 256 chars
      expect(record.recordId.length).toBeGreaterThan(0);
      expect(record.recordId.length).toBeLessThanOrEqual(256);

      // contentBody: non-empty, max 1MB
      expect(record.contentBody.length).toBeGreaterThan(0);
      expect(record.contentBody.length).toBeLessThanOrEqual(1_048_576);

      // contentType: non-empty, MIME format
      expect(record.contentType.length).toBeGreaterThan(0);
      expect(record.contentType).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);

      // lastModified: valid ISO 8601
      const date = new Date(record.lastModified);
      expect(date.getTime()).not.toBeNaN();

      // metadata: non-null object
      expect(record.metadata).toBeDefined();
      expect(typeof record.metadata).toBe("object");
      expect(record.metadata).not.toBeNull();
    });

    it("uses configured contentType", async () => {
      const config: EmploymentHeroAdapterConfig = {
        ...defaultConfig,
        contentType: "text/plain",
      };
      const response = buildListResponse([validEntry(1)], {
        current_page: 1,
        total_pages: 1,
        total_count: 1,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(config, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items[0].contentType).toBe("text/plain");
    });
  });

  describe("cursor encoding/decoding", () => {
    it("handles invalid cursor gracefully by defaulting to page 1", async () => {
      const response = buildListResponse([validEntry(1)], {
        current_page: 1,
        total_pages: 1,
        total_count: 1,
        per_page: 100,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({
        pageSize: 100,
        cursor: "invalid!!!",
      });

      expect(result.items).toHaveLength(1);
    });

    it("roundtrips cursor through pagination", async () => {
      const page1Response = buildListResponse([validEntry(1)], {
        current_page: 1,
        total_pages: 2,
        total_count: 2,
        per_page: 1,
      });
      const page2Response = buildListResponse([validEntry(2)], {
        current_page: 2,
        total_pages: 2,
        total_count: 2,
        per_page: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(page1Response) },
        { status: 200, body: JSON.stringify(page2Response) },
      ]);
      const adapter = new EmploymentHeroAdapter(defaultConfig, httpClient);

      const firstPage = await adapter.listContent({ pageSize: 1 });
      expect(firstPage.nextCursor).toBeDefined();

      const secondPage = await adapter.listContent({
        pageSize: 1,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items[0].recordId).toBe("2");
      expect(secondPage.nextCursor).toBeUndefined();
    });
  });
});
