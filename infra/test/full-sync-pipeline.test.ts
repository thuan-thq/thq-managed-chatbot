import { FullSyncPipeline } from "../lambda/ingestion/sync-pipeline";
import { BedrockSyncClient } from "../lambda/ingestion/bedrock-client";
import { DataSourceAdapter } from "../lambda/ingestion/adapter";
import { S3ContentClient } from "../lambda/ingestion/s3-client";
import { SyncStateClient } from "../lambda/ingestion/dynamo-client";

/**
 * Unit tests for FullSyncPipeline.
 * Validates: Requirements 7.1, 7.2
 */

describe("FullSyncPipeline", () => {
  let mockAdapter: jest.Mocked<DataSourceAdapter>;
  let mockS3Client: jest.Mocked<S3ContentClient>;
  let mockSyncStateClient: jest.Mocked<SyncStateClient>;
  let mockBedrockClient: jest.Mocked<BedrockSyncClient>;

  beforeEach(() => {
    mockAdapter = {
      listContent: jest.fn().mockResolvedValue({
        items: [
          {
            recordId: "rec-1",
            contentBody: "Hello world",
            contentType: "text/plain",
            metadata: { title: "Test Doc" },
            lastModified: "2024-01-01T00:00:00Z",
          },
        ],
        nextCursor: undefined,
        totalCount: 1,
      }),
      fetchById: jest.fn(),
      detectChanges: jest.fn(),
    } as unknown as jest.Mocked<DataSourceAdapter>;

    mockS3Client = {
      putDocument: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<S3ContentClient>;

    mockSyncStateClient = {
      getSyncState: jest.fn().mockResolvedValue(null),
      updateSyncState: jest.fn().mockResolvedValue(undefined),
      clearResumeToken: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SyncStateClient>;

    mockBedrockClient = {
      startIngestionJob: jest.fn().mockResolvedValue("job-123"),
      ingestDocuments: jest.fn(),
      deleteDocuments: jest.fn(),
    } as unknown as jest.Mocked<BedrockSyncClient>;
  });

  it("calls startIngestionJob after execute completes (Requirement 7.1)", async () => {
    const pipeline = new FullSyncPipeline(
      mockAdapter,
      mockS3Client,
      mockSyncStateClient,
      mockBedrockClient,
      { sourceType: "strapi", clientId: "test-client" },
    );

    const result = await pipeline.execute();

    expect(result.success).toBe(true);
    expect(mockBedrockClient.startIngestionJob).toHaveBeenCalledTimes(1);
  });

  it("does NOT call ingestDocuments during execute (Requirement 7.2)", async () => {
    const pipeline = new FullSyncPipeline(
      mockAdapter,
      mockS3Client,
      mockSyncStateClient,
      mockBedrockClient,
      { sourceType: "strapi", clientId: "test-client" },
    );

    await pipeline.execute();

    expect(mockBedrockClient.ingestDocuments).not.toHaveBeenCalled();
  });

  it("does NOT call deleteDocuments during execute (Requirement 7.2)", async () => {
    const pipeline = new FullSyncPipeline(
      mockAdapter,
      mockS3Client,
      mockSyncStateClient,
      mockBedrockClient,
      { sourceType: "strapi", clientId: "test-client" },
    );

    await pipeline.execute();

    expect(mockBedrockClient.deleteDocuments).not.toHaveBeenCalled();
  });
});
