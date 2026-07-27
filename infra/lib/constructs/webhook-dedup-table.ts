import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface WebhookDedupTableProps {
  // Intentionally minimal - no configuration needed for this ephemeral table
}

/**
 * DynamoDB Webhook Deduplication table for at-most-once webhook processing.
 *
 * Schema:
 * - PK: WEBHOOK#{source}#{eventId} (String)
 * - SK: DEDUP (String)
 * - processedAt: ISO 8601 timestamp
 * - TTL: Unix epoch for automatic cleanup after 24 hours
 *
 * Uses PAY_PER_REQUEST billing for unpredictable webhook burst patterns.
 * Data is ephemeral - no point-in-time recovery needed.
 */
export class WebhookDedupTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(
    scope: Construct,
    id: string,
    _props: WebhookDedupTableProps = {},
  ) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "TTL",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });
  }
}
