/**
 * Webhook deduplication service.
 *
 * Provides at-most-once processing guarantees by checking a DynamoDB table
 * before processing and recording event IDs only after successful processing.
 *
 * Requirements: 6.3, 6.6
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.WEBHOOK_DEDUP_TABLE_NAME ?? "";

/** TTL duration: 24 hours in seconds */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Checks whether a webhook event has already been processed.
 *
 * @param source - The webhook source identifier (e.g. "strapi")
 * @param eventId - The unique event identifier
 * @returns true if the event was already processed, false otherwise
 */
export async function isDuplicate(
  source: string,
  eventId: string,
): Promise<boolean> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `WEBHOOK#${source}#${eventId}`,
        SK: "DEDUP",
      },
    }),
  );

  return result.Item !== undefined;
}

/**
 * Records a successfully processed webhook event in the dedup table.
 * Sets a 24-hour TTL for automatic cleanup.
 *
 * @param source - The webhook source identifier (e.g. "strapi")
 * @param eventId - The unique event identifier
 */
export async function recordProcessed(
  source: string,
  eventId: string,
): Promise<void> {
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + TTL_SECONDS;

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `WEBHOOK#${source}#${eventId}`,
        SK: "DEDUP",
        processedAt: now.toISOString(),
        TTL: ttl,
      },
    }),
  );
}
