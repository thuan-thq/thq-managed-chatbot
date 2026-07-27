import {
  MondayAdapter,
  MondayAdapterConfig,
} from "../lambda/ingestion/monday-adapter";
import { RetryHttpClient } from "../lambda/ingestion/http-client";

/**
 * Unit tests for MondayAdapter.
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultConfig: MondayAdapterConfig = {
  baseUrl: "https://api.monday.com/v2",
  apiToken: "test-monday-token-123",
  boardId: "12345",
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

/** Builds a Monday.com boards GraphQL response. */
function buildMondayBoardsResponse(
  items: Array<{
    id: string;
    name: string;
    updated_at: string;
    column_values: Array<{ id: string; text: string; value: string | null }>;
  }>,
  cursor: string | null = null,
) {
  return {
    data: {
      boards: [
        {
          items_page: {
            cursor,
            items,
          },
        },
      ],
    },
  };
}

/** Builds a Monday.com items GraphQL response. */
function buildMondayItemsResponse(
  items: Array<{
    id: string;
    name: string;
    updated_at: string;
    column_values: Array<{ id: string; text: string; value: string | null }>;
  }>,
) {
  return {
    data: {
      items,
    },
  };
}

/** A valid Monday.com item with all required fields. */
function validMondayItem(
  id: string,
  overrides: Partial<{
    name: string;
    updated_at: string;
    column_values: Array<{ id: string; text: string; value: string | null }>;
  }> = {},
) {
  return {
    id,
    name: overrides.name ?? `Task ${id}`,
    updated_at: overrides.updated_at ?? "2024-01-15T10:30:00.000Z",
    column_values: overrides.column_values ?? [
      { id: "status", text: "Working on it", value: '{"index":1}' },
      { id: "person", text: "John Doe", value: '{"id":123}' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MondayAdapter", () => {
  describe("listContent", () => {
    it("returns transformed records from Monday.com response", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100"),
        validMondayItem("200"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items).toHaveLength(2);
      expect(result.items[0].recordId).toBe("100");
      expect(result.items[0].contentBody).toBe(
        "Task 100\nWorking on it\nJohn Doe",
      );
      expect(result.items[0].contentType).toBe("text/plain");
      expect(result.items[0].lastModified).toBe("2024-01-15T10:30:00.000Z");
      expect(result.items[0].metadata).toEqual({
        source: "monday",
        boardId: "12345",
        name: "Task 100",
        recordId: "100",
      });
      expect(result.nextCursor).toBeUndefined();
    });

    it("provides nextCursor when Monday.com returns a cursor", async () => {
      const mondayResponse = buildMondayBoardsResponse(
        [validMondayItem("100")],
        "next_page_cursor_abc",
      );
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 1 });

      expect(result.nextCursor).toBeDefined();
      expect(result.items).toHaveLength(1);
    });

    it("uses decoded cursor to fetch subsequent pages", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("200"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      // Encode a Monday.com cursor as base64
      const externalCursor = Buffer.from("next_page_cursor_abc").toString(
        "base64",
      );
      const result = await adapter.listContent({
        pageSize: 1,
        cursor: externalCursor,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("200");

      // Verify the cursor was passed in the GraphQL query
      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.query).toContain("next_page_cursor_abc");
    });

    it("clamps pageSize to valid range", async () => {
      const mondayResponse = buildMondayBoardsResponse([]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 1000 });

      // Verify the query used clamped pageSize of 500
      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.query).toContain("limit: 500");
    });

    it("sends API token in Authorization header (no Bearer prefix)", async () => {
      const mondayResponse = buildMondayBoardsResponse([]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 100 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe("test-monday-token-123");
    });

    it("sends POST request with Content-Type application/json", async () => {
      const mondayResponse = buildMondayBoardsResponse([]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await adapter.listContent({ pageSize: 100 });

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      expect(callArgs[1].method).toBe("POST");
      expect(callArgs[1].headers["Content-Type"]).toBe("application/json");
    });

    it("throws on non-200 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 401, body: "Unauthorized" },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await expect(adapter.listContent({ pageSize: 100 })).rejects.toThrow(
        "Monday.com API returned status 401",
      );
    });

    it("throws on GraphQL error response", async () => {
      const errorResponse = {
        data: null,
        errors: [{ message: "Board not found" }],
      };
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(errorResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await expect(adapter.listContent({ pageSize: 100 })).rejects.toThrow(
        "Monday.com GraphQL error: Board not found",
      );
    });

    it("returns empty items when board has no items", async () => {
      const mondayResponse = buildMondayBoardsResponse([]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
    });
  });

  describe("fetchById", () => {
    it("returns a content record for a valid item", async () => {
      const mondayResponse = buildMondayItemsResponse([validMondayItem("42")]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("42");

      expect(result).not.toBeNull();
      expect(result!.recordId).toBe("42");
      expect(result!.contentBody).toBe("Task 42\nWorking on it\nJohn Doe");
      expect(result!.lastModified).toBe("2024-01-15T10:30:00.000Z");
    });

    it("returns null when item is not found", async () => {
      const mondayResponse = buildMondayItemsResponse([]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.fetchById("999");

      expect(result).toBeNull();
    });

    it("throws on non-200 response", async () => {
      const httpClient = createMockHttpClient([
        { status: 500, body: "Internal Server Error" },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await expect(adapter.fetchById("1")).rejects.toThrow(
        "Monday.com API returned status 500",
      );
    });

    it("sends correct GraphQL query with item ID", async () => {
      const mondayResponse = buildMondayItemsResponse([validMondayItem("42")]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      await adapter.fetchById("42");

      const callArgs = (httpClient.request as jest.Mock).mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.query).toContain("items(ids: [42])");
    });
  });

  describe("detectChanges", () => {
    it("returns all records as created when no checkpoint", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100"),
        validMondayItem("200"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.created).toHaveLength(2);
      expect(result.updated).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
      expect(result.checkpoint).toBeDefined();
      expect(new Date(result.checkpoint).getTime()).not.toBeNaN();
    });

    it("classifies items updated after checkpoint as updated", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100", { updated_at: "2024-02-01T12:00:00.000Z" }),
        validMondayItem("200", { updated_at: "2024-01-01T12:00:00.000Z" }),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("2024-01-15T00:00:00.000Z");

      expect(result.updated).toHaveLength(1);
      expect(result.updated[0].recordId).toBe("100");
      // Item 200 was updated before the checkpoint, so it should not appear
      expect(result.created).toHaveLength(0);
    });

    it("paginates through all pages for change detection", async () => {
      const page1 = buildMondayBoardsResponse(
        [validMondayItem("100")],
        "cursor_page2",
      );
      const page2 = buildMondayBoardsResponse([validMondayItem("200")]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(page1) },
        { status: 200, body: JSON.stringify(page2) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.created).toHaveLength(2);
      expect((httpClient.request as jest.Mock).mock.calls).toHaveLength(2);
    });

    it("returns valid checkpoint as ISO 8601 timestamp", async () => {
      const mondayResponse = buildMondayBoardsResponse([]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      const date = new Date(result.checkpoint);
      expect(date.getTime()).not.toBeNaN();
      expect(result.checkpoint).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("always returns empty deleted array", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.detectChanges("");

      expect(result.deleted).toEqual([]);
    });
  });

  describe("record transformation - skip invalid records (Requirement 5.5)", () => {
    it("skips items with empty name and no column values", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        {
          id: "1",
          name: "",
          updated_at: "2024-01-01T00:00:00.000Z",
          column_values: [],
        },
        validMondayItem("2"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("2");
      expect(result.errors).toContain("1");
    });

    it("skips items with missing updated_at timestamp", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        {
          id: "1",
          name: "Item 1",
          updated_at: "",
          column_values: [{ id: "col1", text: "val", value: null }],
        },
        validMondayItem("2"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips items with invalid ISO 8601 timestamp", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        {
          id: "1",
          name: "Item 1",
          updated_at: "not-a-date",
          column_values: [{ id: "col1", text: "val", value: null }],
        },
        validMondayItem("2"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips items with content body exceeding 1MB", async () => {
      const largeText = "x".repeat(1_048_577); // 1MB + 1 byte
      const mondayResponse = buildMondayBoardsResponse([
        {
          id: "1",
          name: largeText,
          updated_at: "2024-01-01T00:00:00.000Z",
          column_values: [],
        },
        validMondayItem("2"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.errors).toContain("1");
    });

    it("skips items with recordId exceeding 256 characters", async () => {
      const longId = "a".repeat(257);
      const mondayResponse = buildMondayBoardsResponse([
        {
          id: longId,
          name: "Item",
          updated_at: "2024-01-01T00:00:00.000Z",
          column_values: [{ id: "col1", text: "val", value: null }],
        },
        validMondayItem("2"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("2");
    });

    it("continues processing after skipping invalid records", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        {
          id: "1",
          name: "",
          updated_at: "2024-01-01T00:00:00.000Z",
          column_values: [],
        }, // invalid - no content
        validMondayItem("2"),
        {
          id: "3",
          name: "Item 3",
          updated_at: "not-a-date",
          column_values: [{ id: "col1", text: "val", value: null }],
        }, // invalid - bad date
        validMondayItem("4"),
        validMondayItem("5"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = (await adapter.listContent({ pageSize: 100 })) as any;

      expect(result.items).toHaveLength(3);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContain("1");
      expect(result.errors).toContain("3");
    });
  });

  describe("ContentRecord format conformance (Requirement 5.1)", () => {
    it("produces records with all required fields", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

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
      const config: MondayAdapterConfig = {
        ...defaultConfig,
        contentType: "text/html",
      };
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(config, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items[0].contentType).toBe("text/html");
    });

    it("includes correct metadata fields", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100", { name: "My Task" }),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });
      const metadata = result.items[0].metadata;

      expect(metadata.source).toBe("monday");
      expect(metadata.boardId).toBe("12345");
      expect(metadata.name).toBe("My Task");
      expect(metadata.recordId).toBe("100");
    });
  });

  describe("cursor encoding/decoding", () => {
    it("handles invalid cursor gracefully by treating as first page", async () => {
      const mondayResponse = buildMondayBoardsResponse([
        validMondayItem("100"),
      ]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      // Pass an invalid cursor that decodes to empty
      const result = await adapter.listContent({
        pageSize: 100,
        cursor: Buffer.from("").toString("base64"),
      });

      // Should not throw
      expect(result.items).toHaveLength(1);
    });

    it("roundtrips cursor through pagination", async () => {
      // First page returns a cursor
      const page1Response = buildMondayBoardsResponse(
        [validMondayItem("100")],
        "abc123_next_cursor",
      );
      // Second page (no more)
      const page2Response = buildMondayBoardsResponse([validMondayItem("200")]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(page1Response) },
        { status: 200, body: JSON.stringify(page2Response) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const firstPage = await adapter.listContent({ pageSize: 1 });
      expect(firstPage.nextCursor).toBeDefined();

      const secondPage = await adapter.listContent({
        pageSize: 1,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items[0].recordId).toBe("200");
      expect(secondPage.nextCursor).toBeUndefined();
    });
  });

  describe("content body composition", () => {
    it("composes content from name and all column text values", async () => {
      const item = validMondayItem("100", {
        name: "Project Alpha",
        column_values: [
          { id: "status", text: "Done", value: '{"index":2}' },
          { id: "date", text: "2024-03-15", value: '"2024-03-15"' },
          { id: "notes", text: "Final review complete", value: null },
        ],
      });
      const mondayResponse = buildMondayBoardsResponse([item]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items[0].contentBody).toBe(
        "Project Alpha\nDone\n2024-03-15\nFinal review complete",
      );
    });

    it("skips column values with empty text", async () => {
      const item = validMondayItem("100", {
        name: "Task Name",
        column_values: [
          { id: "status", text: "In progress", value: '{"index":1}' },
          { id: "empty_col", text: "", value: null },
          { id: "notes", text: "Some notes", value: null },
        ],
      });
      const mondayResponse = buildMondayBoardsResponse([item]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items[0].contentBody).toBe(
        "Task Name\nIn progress\nSome notes",
      );
    });

    it("uses only name when all column values are empty", async () => {
      const item = validMondayItem("100", {
        name: "Only Name",
        column_values: [
          { id: "col1", text: "", value: null },
          { id: "col2", text: "", value: null },
        ],
      });
      const mondayResponse = buildMondayBoardsResponse([item]);
      const httpClient = createMockHttpClient([
        { status: 200, body: JSON.stringify(mondayResponse) },
      ]);
      const adapter = new MondayAdapter(defaultConfig, httpClient);

      const result = await adapter.listContent({ pageSize: 100 });

      expect(result.items[0].contentBody).toBe("Only Name");
    });
  });
});
