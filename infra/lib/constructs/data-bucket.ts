import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface DataBucketProps {
  /**
   * The client ID used to derive the bucket name.
   * Format: {clientId}-kb-data
   */
  readonly clientId: string;
}

/**
 * S3 Data Bucket for the managed chatbot platform.
 *
 * Prefix structure:
 * - documents/       Individual content records
 * - metadata/        Bedrock KB metadata files
 * - sync/progress/   Sync progress snapshots
 *
 * Lifecycle rules:
 * - Transition to Infrequent Access after 30 days
 * - Delete objects after 90 days
 */
export class DataBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: `${props.clientId}-kb-data`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "transition-and-expiry",
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(90),
        },
      ],
    });
  }
}
