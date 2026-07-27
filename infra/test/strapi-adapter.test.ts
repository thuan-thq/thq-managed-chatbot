import {
  StrapiAdapter,
  StrapiAdapterConfig,
} from "../lambda/ingestion/strapi-adapter";
import { RetryHttpClient } from "../lambda/ingestion/http-client";
import { PaginationParams } from "../lambda/ingestion/types";

/**
 * Unit tests for StrapiAdapter.
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultConfig: StrapiAdapterConfig = {
  baseUrl: "https://cms.example.com",
  apiToken: "test-api-token-123",
  collection: "articles",
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

/** Builds a Strapi v4 list response. */
function buildStrapiListResponse(
  entries: Array<{ id: number | string; attributes: Record<string, unknown> }>,
  pagination: {
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
  },
) {
  return {
    data: entries.map((e) => ({ id: e.id, attributes: e.attributes })),
    meta: { pagination },
  };
}

/** A valid Strapi entry with all required fields. */
function validStrapiEntry(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    attributes: {
      title: `Article ${id}`,
      content: `<p>Content for article ${id}</p>`,
      updatedAt: "2024-01-15T10:30:00.000Z",
      createdAt: "2024-01-10T08:00:00.000Z",
      slug: `article-${id}`,
      ...overrides,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("StrapiAdapter", () => {
  describe("listContent", () => {
    it("returns transformed records from Strapi response", async () => {
      const strapiResponse = buildStrapiListResponse(
        [validStrapiEntry(1), validStrapiEntry(2)],
        { page: 1, pageSize: 100, pageCount: 1, total: 2 },
      );
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].recordId).toBe("1");
      expect(result.items[0].contentBody).toBe("<p>Content for article 1</p>");
      expect(result.items[0].contentType).toBe("text/html");
      expect(result.items[0].lastModified).toBe("2024-01-15T10:30:00.000Z");
      expect(result.items[0].metadata).toEqual(
        expect.objectContaining({
          source: "strapi",
          collection: "articles",
          recordId: "1",
          title: "Article 1",
          slug: "article-1",
        }),
      );
      expect(result.totalCount).toBe(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it("provides nextCursor when there are more pages", async () => {
      const strapiResponse = buildStrapiListResponse([validStrapiEntry(1)], {
        page: 1,
        pageSize: 1,
        pageCount: 3,
        total: 3,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 1 });

      expect(result.nextCursor).toBeDefined();
      expect(result.items).toHaveLength(1);
    });

    it("uses cursor to fetch specific page", async () => {
      const strapiResponse = buildStrapiListResponse([validStrapiEntry(3)], {
        page: 2,
        pageSize: 1,
        pageCount: 3,
        total: 3,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      // Encode page 2 as cursor
      const cursor = Buffer.from("2").toString("base64");
      const result = await adapter.listContent({ pageSize: 1, cursor });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("3");
      // Should have a next cursor for page 3
      expect(result.nextCursor).toBeDefined();
    });

    it("clamps pageSize to valid range", async () => {
      const strapiResponse = buildStrapiListResponse([], {
        page: 1,
        pageSize: 500,
        pageCount: 0,
        total: 0,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 1000 });

      // Verify the URL was called with clamped pageSize of 500
      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toContain("pagination%5BpageSize%5D=500");
    });

    it("sends Bearer token in Authorization header", async () => {
      const strapiResponse = buildStrapiListResponse([], {
        page: 1,
        pageSize: 100,
        pageCount: 0,
        total: 0,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 100 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe(
        "Bearer test-api-token-123",
      );
    });

    it("throws on non-200 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 401, body: "Unauthorized" },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      await expect(adapter.listContent({ pageSize: 100 })).rejects.toThrow(
        "Strapi API returned status 401",
      );
    });
  });

  describe("fetchById", () => {
    it("returns a content record for a valid entry", async () => {
      const strapiResponse = {
        data: {
          id: 42,
          attributes: {
            title: "Test Article",
            content: "<p>Hello world</p>",
            updatedAt: "2024-03-01T12:00:00.000Z",
            createdAt: "2024-02-28T08:00:00.000Z",
          },
        },
      };
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("42");

      expect(result).not.toBeNull();
      expect(result!.recordId).toBe("42");
      expect(result!.contentBody).toBe("<p>Hello world</p>");
      expect(result!.lastModified).toBe("2024-03-01T12:00:00.000Z");
    });

    it("returns null for 404 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 404, body: "Not Found" },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("999");

      expect(result).toBeNull();
    });

    it("returns null when data is null", async () => {
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify({ data: null }) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("999");

      expect(result).toBeNull();
    });

    it("throws on non-200/404 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 500, body: "Internal Server Error" },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      await expect(adapter.fetchById("1")).rejects.toThrow(
        "Strapi API returned status 500",
      );
    });
  });

  describe("detectChanges", () => {
    it("returns all records as created when no checkpoint", async () => {
      const strapiResponse = buildStrapiListResponse(
        [validStrapiEntry(1), validStrapiEntry(2)],
        { page: 1, pageSize: 100, pageCount: 1, total: 2 },
      );
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.created).toHaveLength(2);
      expect(result.updated).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
      expect(result.checkpoint).toBeDefined();
      expect(new Date(result.checkpoint).getTime()).not.toBeNaN();
    });

    it("uses updatedAt filter when checkpoint is provided", async () => {
      const strapiResponse = buildStrapiListResponse(
        [validStrapiEntry(3, { createdAt: "2024-02-01T00:00:00.000Z" })],
        { page: 1, pageSize: 100, pageCount: 1, total: 1 },
      );
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const since = "2024-01-20T00:00:00.000Z";
      const result = await adapter.detectChanges(since);

      // Verify the filter was applied in the URL
      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[0]).toContain(
        "filters%5BupdatedAt%5D%5B%24gt%5D=" + encodeURIComponent(since),
      );

      expect(result.checkpoint).toBeDefined();
    });

    it("paginates through all pages for change detection", async () => {
      const page1 = buildStrapiListResponse([validStrapiEntry(1)], {
        page: 1,
        pageSize: 1,
        pageCount: 2,
        total: 2,
      });
      const page2 = buildStrapiListResponse([validStrapiEntry(2)], {
        page: 2,
        pageSize: 1,
        pageCount: 2,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(page1) },
        { status: 200, body: JSON.stringify(page2) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.created).toHaveLength(2);
      expect((httpClient.request as jest.Mock).mock.calls).toHaveLength(2);
    });

    it("returns valid checkpoint as ISO 8601 timestamp", async () => {
      const strapiResponse = buildStrapiListResponse([], {
        page: 1,
        pageSize: 100,
        pageCount: 0,
        total: 0,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      // Checkpoint should be a valid ISO 8601 timestamp
      const date = new Date(result.checkpoint);
      expect(date.getTime()).not.toBeNaN();
      expect(result.checkpoint).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("record transformation - skip invalid records (Requirement 5.5)", () => {
    it("skips entries with missing content body", async () => {
      const entries = [
        { id: 1, attributes: { updatedAt: "2024-01-01T00:00:00.000Z" } }, // no content
        validStrapiEntry(2),
      ];
      const strapiResponse = buildStrapiListResponse(entries, {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("2");
      expect(result.errors).toContain("1");
    });

    it("skips entries with missing updatedAt timestamp", async () => {
      const entries = [
        { id: 1, attributes: { content: "Some content" } }, // no timestamp
        validStrapiEntry(2),
      ];
      const strapiResponse = buildStrapiListResponse(entries, {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips entries with invalid ISO 8601 timestamp", async () => {
      const entries = [
        {
          id: 1,
          attributes: { content: "Some content", updatedAt: "not-a-date" },
        },
        validStrapiEntry(2),
      ];
      const strapiResponse = buildStrapiListResponse(entries, {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips entries with content body exceeding 1MB", async () => {
      const largeContent = "x".repeat(1_048_577); // 1MB + 1 byte
      const entries = [
        {
          id: 1,
          attributes: {
            content: largeContent,
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        },
        validStrapiEntry(2),
      ];
      const strapiResponse = buildStrapiListResponse(entries, {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips entries with recordId exceeding 256 characters", async () => {
      const longId = "a".repeat(257);
      const entries = [
        {
          id: longId,
          attributes: {
            content: "Content",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        },
        validStrapiEntry(2),
      ];
      const strapiResponse = buildStrapiListResponse(entries as any, {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("2");
    });

    it("continues processing after skipping invalid records", async () => {
      const entries = [
        { id: 1, attributes: {} }, // invalid - no content, no timestamp
        validStrapiEntry(2),
        { id: 3, attributes: { content: "text" } }, // invalid - no timestamp
        validStrapiEntry(4),
        validStrapiEntry(5),
      ];
      const strapiResponse = buildStrapiListResponse(entries, {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 5,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(3);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContain("1");
      expect(result.errors).toContain("3");
    });
  });

  describe("ContentRecord format conformance (Requirement 5.1)", () => {
    it("produces records with all required fields", async () => {
      const strapiResponse = buildStrapiListResponse([validStrapiEntry(1)], {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

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
      const config: StrapiAdapterConfig = {
        ...defaultConfig,
        contentType: "text/plain",
      };
      const strapiResponse = buildStrapiListResponse([validStrapiEntry(1)], {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(config, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items[0].contentType).toBe("text/plain");
    });
  });

  describe("cursor encoding/decoding", () => {
    it("handles invalid cursor gracefully by defaulting to page 1", async () => {
      const strapiResponse = buildStrapiListResponse([validStrapiEntry(1)], {
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 1,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(strapiResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      // Pass an invalid cursor
      const result = await adapter.listContent({
        pageSize: 100,
        cursor: "invalid!!!",
      });

      // Should not throw, defaults to page 1
      expect(result.items).toHaveLength(1);
    });

    it("roundtrips cursor through pagination", async () => {
      // First page
      const page1Response = buildStrapiListResponse([validStrapiEntry(1)], {
        page: 1,
        pageSize: 1,
        pageCount: 2,
        total: 2,
      });
      // Second page
      const page2Response = buildStrapiListResponse([validStrapiEntry(2)], {
        page: 2,
        pageSize: 1,
        pageCount: 2,
        total: 2,
      });
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(page1Response) },
        { status: 200, body: JSON.stringify(page2Response) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

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

  describe("Strapi v4 flat response format support", () => {
    it("handles entries without attributes wrapper", async () => {
      const flatResponse = {
        data: [
          {
            id: 1,
            title: "Flat Article",
            content: "<p>Flat content</p>",
            updatedAt: "2024-01-15T10:30:00.000Z",
            createdAt: "2024-01-10T08:00:00.000Z",
          },
        ],
        meta: {
          pagination: { page: 1, pageSize: 100, pageCount: 1, total: 1 },
        },
      };
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(flatResponse) },
      ]);
      const adapter = new StrapiAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("1");
      expect(result.items[0].contentBody).toBe("<p>Flat content</p>");
    });
  });
});
