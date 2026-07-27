import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface SessionsTableProps {
  /**
   * Minimum read capacity units for auto-scaling.
   * @default 1
   */
  readonly minReadCapacity?: number;

  /**
   * Maximum read capacity units for auto-scaling.
   * @default 50
   */
  readonly maxReadCapacity?: number;

  /**
   * Minimum write capacity units for auto-scaling.
   * @default 1
   */
  readonly minWriteCapacity?: number;

  /**
   * Maximum write capacity units for auto-scaling.
   * @default 25
   */
  readonly maxWriteCapacity?: number;

  /**
   * Target utilization percentage for auto-scaling policies.
   * @default 70
   */
  readonly targetUtilizationPercent?: number;
}

/**
 * DynamoDB Sessions table for the managed chatbot platform.
 *
 * Schema:
 * - PK: SESSION#{sessionId} (String)
 * - SK: META or TURN#{turnNumber} (String)
 * - TTL: Unix epoch for automatic session cleanup
 *
 * Provisioned capacity with auto-scaling enabled for cost-efficient scaling.
 */
export class SessionsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: SessionsTableProps = {}) {
    super(scope, id);

    const minReadCapacity = props.minReadCapacity ?? 1;
    const maxReadCapacity = props.maxReadCapacity ?? 50;
    const minWriteCapacity = props.minWriteCapacity ?? 1;
    const maxWriteCapacity = props.maxWriteCapacity ?? 25;
    const targetUtilization = props.targetUtilizationPercent ?? 70;

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: minReadCapacity,
      writeCapacity: minWriteCapacity,
      timeToLiveAttribute: "TTL",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Configure auto-scaling for read capacity
    const readScaling = this.table.autoScaleReadCapacity({
      minCapacity: minReadCapacity,
      maxCapacity: maxReadCapacity,
    });
    readScaling.scaleOnUtilization({
      targetUtilizationPercent: targetUtilization,
    });

    // Configure auto-scaling for write capacity
    const writeScaling = this.table.autoScaleWriteCapacity({
      minCapacity: minWriteCapacity,
      maxCapacity: maxWriteCapacity,
    });
    writeScaling.scaleOnUtilization({
      targetUtilizationPercent: targetUtilization,
    });
  }
}
