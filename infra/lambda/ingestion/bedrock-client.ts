/**
 * Bedrock Agent client wrapper for triggering KB ingestion jobs.
 *
 * Provides a typed wrapper around the StartIngestionJob API to
 * initiate Bedrock Knowledge Base sync after content changes.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 6.4, 6.5
 */

import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  IngestKnowledgeBaseDocumentsCommand,
  DeleteKnowledgeBaseDocumentsCommand,
  ListIngestionJobsCommand,
} from "@aws-sdk/client-bedrock-agent";

// ─── Result Types ────────────────────────────────────────────────────────────

/**
 * Result of a targeted document ingestion operation.
 *
 * Requirements: 1.3, 5.1
 */
export interface IngestDocumentResult {
  /** The S3 URI of the ingested document. */
  uri: string;
  /** The ingestion status returned by the Bedrock API. */
  status:
    | "INDEXED"
    | "PARTIALLY_INDEXED"
    | "PENDING"
    | "FAILED"
    | "METADATA_PARTIALLY_INDEXED"
    | "IGNORED";
  /** Optional reason for the status (typically provided on failure). */
  statusReason?: string;
}

/**
 * Result of a targeted document deletion operation.
 *
 * Requirements: 2.3
 */
export interface DeleteDocumentResult {
  /** The S3 URI of the deleted document. */
  uri: string;
  /** The deletion status returned by the Bedrock API. */
  status: "DELETED" | "FAILED";
  /** Optional reason for the status (typically provided on failure). */
  statusReason?: string;
}

// ─── S3 URI Utility ──────────────────────────────────────────────────────────

/**
 * Constructs an S3 URI from a bucket name and document key.
 *
 * Validates that both parameters are non-empty, strips leading slashes
 * from documentKey, and ensures no double slashes in the output.
 *
 * @param bucketName - The S3 bucket name
 * @param documentKey - The S3 object key (leading slashes are stripped)
 * @returns The constructed S3 URI in format `s3://{bucketName}/{documentKey}`
 * @throws Error if bucketName or documentKey is empty, null, or undefined
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */
export function buildS3Uri(bucketName: string, documentKey: string): string {
  if (!bucketName) {
    throw new Error("Validation error: bucketName must be a non-empty string");
  }
  if (!documentKey) {
    throw new Error("Validation error: documentKey must be a non-empty string");
  }

  // Strip leading slashes from documentKey to prevent double slashes
  const normalizedKey = documentKey.replace(/^\/+/, "");

  if (!normalizedKey) {
    throw new Error(
      "Validation error: documentKey must be a non-empty string after stripping leading slashes",
    );
  }

  return `s3://${bucketName}/${normalizedKey}`;
}

// ─── Bedrock KB Sync Client ─────────────────────────────────────────────────

export interface BedrockSyncClientConfig {
  /** The Bedrock Knowledge Base ID. */
  knowledgeBaseId: string;
  /** The Bedrock Data Source ID. */
  dataSourceId: string;
  /** Optional Bedrock Agent client instance (for testing). */
  client?: BedrockAgentClient;
}

/**
 * Wrapper for triggering Bedrock KB ingestion jobs.
 */
export class BedrockSyncClient {
  private readonly client: BedrockAgentClient;
  private readonly knowledgeBaseId: string;
  private readonly dataSourceId: string;

  constructor(config: BedrockSyncClientConfig) {
    this.client = config.client ?? new BedrockAgentClient({});
    this.knowledgeBaseId = config.knowledgeBaseId;
    this.dataSourceId = config.dataSourceId;
  }

  /**
   * Triggers a Bedrock KB ingestion job to re-index S3 documents.
   *
   * @returns The ingestion job ID
   */
  async startIngestionJob(): Promise<string> {
    const result = await this.client.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
      }),
    );

    return result.ingestionJob?.ingestionJobId ?? "unknown";
  }

  /**
   * Ingests specific documents into the Bedrock Knowledge Base by S3 URI.
   *
   * Calls the IngestKnowledgeBaseDocuments API for targeted document indexing
   * without triggering a full data source scan.
   *
   * @param s3Uris - Array of S3 URIs to ingest (1 to 10 items)
   * @returns Array of IngestDocumentResult, one per input URI
   * @throws Error if s3Uris is null/undefined, empty, or exceeds 10 items
   * @throws Error if the Bedrock API call fails (after logging)
   *
   * Requirements: 1.2, 1.3, 1.4, 4.1, 4.3, 4.4, 5.1, 5.3, 6.1, 6.3
   */
  async ingestDocuments(s3Uris: string[]): Promise<IngestDocumentResult[]> {
    // Input validation (Requirements: 4.4, 4.3, 4.1)
    if (s3Uris == null) {
      throw new Error("Validation error: s3Uris argument is required");
    }
    if (s3Uris.length === 0) {
      throw new Error(
        "Validation error: s3Uris array must contain at least 1 item",
      );
    }
    if (s3Uris.length > 10) {
      throw new Error(
        "Validation error: s3Uris array exceeds the maximum allowed size of 10",
      );
    }

    // Build SDK command (Requirement: 1.2)
    const command = new IngestKnowledgeBaseDocumentsCommand({
      knowledgeBaseId: this.knowledgeBaseId,
      dataSourceId: this.dataSourceId,
      documents: s3Uris.map((uri) => ({
        content: {
          dataSourceType: "S3" as const,
          s3: {
            s3Location: { uri },
          },
        },
      })),
    });

    let response;
    try {
      response = await this.client.send(command);
    } catch (error) {
      // Log structured JSON at ERROR level and re-throw (Requirement: 6.1)
      console.log(
        JSON.stringify({
          level: "ERROR",
          message: "IngestKnowledgeBaseDocuments API call failed",
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
          s3Uris,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }

    // Map response to results, preserving input order (Requirements: 1.3, 5.1, 5.3)
    const documentDetails = response.documentDetails ?? [];

    const results: IngestDocumentResult[] = s3Uris.map((inputUri) => {
      const entry = documentDetails.find(
        (item) => item.identifier?.s3?.uri === inputUri,
      );

      if (entry) {
        const status =
          (entry.status as IngestDocumentResult["status"]) ?? "FAILED";
        const result: IngestDocumentResult = {
          uri: inputUri,
          status,
        };
        if (entry.statusReason) {
          result.statusReason = entry.statusReason;
        }

        // Log WARN for individual FAILED statuses (Requirement: 6.3)
        if (status === "FAILED") {
          console.log(
            JSON.stringify({
              level: "WARN",
              message: "Document ingestion failed",
              uri: inputUri,
              statusReason: entry.statusReason ?? "No reason provided",
            }),
          );
        }

        return result;
      }

      // Synthesize FAILED result for missing entries (Requirement: 5.3)
      console.log(
        JSON.stringify({
          level: "WARN",
          message: "Document ingestion failed",
          uri: inputUri,
          statusReason: "Document status absent from API response",
        }),
      );

      return {
        uri: inputUri,
        status: "FAILED" as const,
        statusReason: "Document status absent from API response",
      };
    });

    return results;
  }

  /**
   * Waits for all currently running or starting ingestion jobs on this data
   * source to reach a terminal state (COMPLETE, FAILED, or STOPPED).
   *
   * Bedrock rejects DeleteKnowledgeBaseDocuments calls while any ingestion job
   * is in-progress, so callers should await this before attempting deletes.
   *
   * @param pollIntervalMs - How often to re-check job status (default 5 000 ms)
   * @param timeoutMs      - Maximum wait time before throwing (default 120 000 ms)
   * @throws Error if the timeout is exceeded while jobs are still running
   */
  async waitForActiveIngestionJobs(
    pollIntervalMs = 5_000,
    timeoutMs = 120_000,
  ): Promise<void> {
    const terminalStatuses = new Set(["COMPLETE", "FAILED", "STOPPED"]);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // List the most recent jobs — newest first, we only care about non-terminal ones
      const listResponse = await this.client.send(
        new ListIngestionJobsCommand({
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
          maxResults: 10,
        }),
      );

      const runningJobs = (listResponse.ingestionJobSummaries ?? []).filter(
        (j) => !terminalStatuses.has(j.status ?? ""),
      );

      if (runningJobs.length === 0) {
        return;
      }

      console.log(
        JSON.stringify({
          level: "INFO",
          message:
            "Waiting for running ingestion jobs to complete before KB delete",
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
          runningJobIds: runningJobs.map((j) => j.ingestionJobId),
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Final check — one last list before giving up
    const finalList = await this.client.send(
      new ListIngestionJobsCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        maxResults: 10,
      }),
    );

    const stillRunning = (finalList.ingestionJobSummaries ?? []).filter(
      (j) => !terminalStatuses.has(j.status ?? ""),
    );

    if (stillRunning.length > 0) {
      throw new Error(
        `Timed out waiting for ingestion jobs to complete after ${timeoutMs}ms. ` +
          `Still running: ${stillRunning.map((j) => j.ingestionJobId).join(", ")}`,
      );
    }
  }

  /**
   * Deletes specific documents from the Bedrock Knowledge Base by S3 URI.
   *
   * Calls the DeleteKnowledgeBaseDocuments API for targeted document removal
   * without triggering a full data source scan.
   *
   * @param s3Uris - Array of S3 URIs to delete (1 to 10 items)
   * @returns Array of DeleteDocumentResult, one per input URI
   * @throws Error if s3Uris is null/undefined, empty, or exceeds 10 items
   * @throws Error if the Bedrock API call fails (after logging)
   *
   * Requirements: 2.2, 2.3, 4.2, 4.3, 4.4, 5.2, 5.3, 6.2
   */
  async deleteDocuments(s3Uris: string[]): Promise<DeleteDocumentResult[]> {
    // Input validation (Requirements: 4.4, 4.3, 4.2)
    if (s3Uris == null) {
      throw new Error("Validation error: s3Uris argument is required");
    }
    if (s3Uris.length === 0) {
      throw new Error(
        "Validation error: s3Uris array must contain at least 1 item",
      );
    }
    if (s3Uris.length > 10) {
      throw new Error(
        "Validation error: s3Uris array exceeds the maximum allowed size of 10",
      );
    }

    // Build SDK command (Requirement: 2.2)
    const command = new DeleteKnowledgeBaseDocumentsCommand({
      knowledgeBaseId: this.knowledgeBaseId,
      dataSourceId: this.dataSourceId,
      documentIdentifiers: s3Uris.map((uri) => ({
        dataSourceType: "S3" as const,
        s3: {
          uri,
        },
      })),
    });

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "DeleteKnowledgeBaseDocuments API call starting",
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        s3Uris,
      }),
    );

    let response;
    try {
      response = await this.client.send(command);
    } catch (error) {
      // Log structured JSON at ERROR level and re-throw (Requirement: 6.2)
      console.log(
        JSON.stringify({
          level: "ERROR",
          message: "DeleteKnowledgeBaseDocuments API call failed",
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
          s3Uris,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "DeleteKnowledgeBaseDocuments API call succeeded",
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        documentDetails: response.documentDetails,
      }),
    );

    // Map response to results, preserving input order (Requirements: 2.3, 5.2, 5.3)
    const documentDetails = response.documentDetails ?? [];

    const results: DeleteDocumentResult[] = s3Uris.map((inputUri) => {
      const entry = documentDetails.find(
        (item) => item.identifier?.s3?.uri === inputUri,
      );

      if (entry) {
        const status =
          (entry.status as DeleteDocumentResult["status"]) ?? "FAILED";
        const result: DeleteDocumentResult = {
          uri: inputUri,
          status,
        };
        if (entry.statusReason) {
          result.statusReason = entry.statusReason;
        }

        if (status === "FAILED") {
          console.log(
            JSON.stringify({
              level: "WARN",
              message: "KB document deletion failed",
              uri: inputUri,
              statusReason: entry.statusReason ?? "No reason provided",
            }),
          );
        }

        return result;
      }

      // Synthesize FAILED result for missing entries (Requirement: 5.3)
      console.log(
        JSON.stringify({
          level: "WARN",
          message: "KB document deletion failed",
          uri: inputUri,
          statusReason: "Document status absent from API response",
        }),
      );

      return {
        uri: inputUri,
        status: "FAILED" as const,
        statusReason: "Document status absent from API response",
      };
    });

    return results;
  }
}
