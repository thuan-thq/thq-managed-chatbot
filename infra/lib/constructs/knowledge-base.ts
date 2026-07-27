import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface KnowledgeBaseProps {
  /**
   * The S3 data bucket containing knowledge base source documents.
   * Documents are expected under the `documents/` prefix.
   */
  readonly dataBucket: s3.IBucket;

  /**
   * The client ID used for naming resources.
   */
  readonly clientId: string;
}

/**
 * Amazon Bedrock Managed Knowledge Base with S3 data source.
 *
 * Uses the new Managed Knowledge Base type where Bedrock handles storage,
 * indexing, retrieval infrastructure, and embedding model selection automatically.
 * The S3 data source points to the data bucket's `documents/` prefix.
 *
 * Key benefits over the old VECTOR type:
 * - No vector database to provision or manage
 * - Service-managed embedding model (or bring your own)
 * - Automatic storage auto-scaling
 * - Built-in Smart Parsing and Agentic Retriever support
 */
export class KnowledgeBase extends Construct {
  /** The Knowledge Base ID */
  public readonly knowledgeBaseId: string;

  /** The Knowledge Base ARN */
  public readonly knowledgeBaseArn: string;

  /** The underlying CfnKnowledgeBase resource */
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;

  /** The data source linking S3 to the KB */
  public readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    // IAM role for the Knowledge Base to access S3 data source
    const kbRole = new iam.Role(this, "KbRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: `Bedrock Managed KB role for ${props.clientId}`,
    });

    // Grant read access to the data bucket's documents/ prefix
    props.dataBucket.grantRead(kbRole, "documents/*");

    // Grant list access to the bucket (required for S3 data source ingestion)
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [props.dataBucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": ["documents/*"],
          },
        },
      }),
    );

    // Create the Bedrock Managed Knowledge Base
    // No storageConfiguration needed — Bedrock manages storage internally
    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "Resource", {
      name: `${props.clientId}-knowledge-base`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "MANAGED",
        managedKnowledgeBaseConfiguration: {
          // Use service-managed embedding model — Bedrock selects the optimal model.
          // embeddingModelArn is required by CDK types but ignored by the service
          // when embeddingModelType is MANAGED.
          embeddingModelType: "MANAGED",
          embeddingModelArn: "MANAGED",
        },
      },
      // No storageConfiguration — fully managed by Bedrock
    });

    // Override the synthesized template to remove the embeddingModelArn field
    // which is not needed (and should be absent) for MANAGED type KBs.
    this.knowledgeBase.addPropertyDeletionOverride(
      "KnowledgeBaseConfiguration.ManagedKnowledgeBaseConfiguration.EmbeddingModelArn",
    );

    this.knowledgeBaseId = this.knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = this.knowledgeBase.attrKnowledgeBaseArn;

    // Create the S3 Data Source linked to the Knowledge Base
    // For MANAGED knowledge bases, the data source type must be
    // MANAGED_KNOWLEDGE_BASE_CONNECTOR with S3 connector parameters.
    //
    // ConnectorParameters is typed as `any` in CDK, so CDK doesn't resolve
    // tokens (like Ref/Fn::GetAtt) within it. We define the data source with
    // a minimal config and then override the full ConnectorParameters using
    // addPropertyOverride with raw CloudFormation intrinsics.
    this.dataSource = new bedrock.CfnDataSource(this, "DataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: `${props.clientId}-s3-data-source`,
      dataSourceConfiguration: {
        type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
        managedKnowledgeBaseConnectorConfiguration: {},
      },
    });

    // Override ConnectorParameters with raw CloudFormation to inject Ref intrinsics
    this.dataSource.addPropertyOverride(
      "DataSourceConfiguration.ManagedKnowledgeBaseConnectorConfiguration.ConnectorParameters",
      {
        type: "S3",
        version: "1",
        connectionConfiguration: {
          bucketName: props.dataBucket.bucketName,
          bucketOwnerAccountId: { Ref: "AWS::AccountId" },
        },
        filterConfiguration: {
          inclusionPrefixes: ["documents/"],
        },
      },
    );

    // Ensure data source is created after the knowledge base
    this.dataSource.addDependency(this.knowledgeBase);
  }
}
