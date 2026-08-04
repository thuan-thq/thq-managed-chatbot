import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface IngestionLambdaProps {
  /**
   * The client ID used for naming and tagging resources.
   */
  readonly clientId: string;

  /**
   * The S3 data bucket for storing ingested content documents.
   */
  readonly dataBucket: s3.IBucket;

  /**
   * The DynamoDB Sessions table for sync state tracking.
   */
  readonly sessionsTable: dynamodb.ITable;

  /**
   * The DynamoDB Webhook Deduplication table for at-most-once processing.
   */
  readonly webhookDedupTable: dynamodb.ITable;

  /**
   * The Bedrock Knowledge Base ID (used to trigger ingestion jobs).
   */
  readonly knowledgeBaseId: string;

  /**
   * The Bedrock Knowledge Base ARN.
   */
  readonly knowledgeBaseArn: string;

  /**
   * The Bedrock Data Source ID (used to start ingestion jobs).
   */
  readonly dataSourceId: string;

  /**
   * The HTTP API to attach Lambda integrations to.
   */
  readonly httpApi: apigatewayv2.HttpApi;

  /**
   * SSM parameters the Lambda needs read access to.
   */
  readonly ssmParameters: ssm.IStringParameter[];

  /**
   * Secrets Manager secrets the Lambda needs read access to.
   */
  readonly secrets: secretsmanager.ISecret[];

  /**
   * Memory size in MB.
   * @default 512
   */
  readonly memorySize?: number;

  /**
   * Lambda timeout.
   * @default 900 seconds (15 minutes - max for full sync operations)
   */
  readonly timeout?: cdk.Duration;
}

/**
 * Ingestion Lambda CDK construct.
 *
 * Deploys a Node.js 20.x Lambda function (512MB default) with:
 * - IAM permissions for S3 (read/write), DynamoDB (read/write),
 *   Bedrock KB (StartIngestionJob), SSM (read), Secrets Manager (read)
 * - HTTP API Gateway integrations for:
 *   POST /webhook/{source}
 *   POST /ingest/record
 *   DELETE /ingest/record/{recordId}
 * - Cost allocation tags (inherited from stack tags)
 *
 * Timeout is set to 15 minutes (maximum Lambda timeout) to support
 * full sync operations that paginate through large data sources.
 */
export class IngestionLambda extends Construct {
  /** The underlying Lambda function resource */
  public readonly fn: NodejsFunction;

  /** The IAM execution role */
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: IngestionLambdaProps) {
    super(scope, id);

    const memorySize = props.memorySize ?? 512;

    // --- IAM execution role ---
    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Ingestion Lambda execution role for ${props.clientId}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });

    // S3 read/write on the data bucket
    props.dataBucket.grantReadWrite(this.role);

    // DynamoDB read/write on Sessions table (for sync state)
    props.sessionsTable.grantReadWriteData(this.role);

    // DynamoDB read/write on Webhook Dedup table (for at-most-once processing)
    props.webhookDedupTable.grantReadWriteData(this.role);

    // Bedrock KB ingestion permissions (full scan + targeted ingest/delete + job status)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockKBIngestion",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:StartIngestionJob",
          "bedrock:IngestKnowledgeBaseDocuments",
          "bedrock:DeleteKnowledgeBaseDocuments",
          "bedrock:ListIngestionJobs",
          "bedrock:ListKnowledgeBaseDocuments",
        ],
        resources: [props.knowledgeBaseArn],
      }),
    );

    // Parameter Store read permissions
    for (const param of props.ssmParameters) {
      param.grantRead(this.role);
    }

    // Secrets Manager read permissions
    for (const secret of props.secrets) {
      secret.grantRead(this.role);
    }

    // --- Lambda function ---
    this.fn = new NodejsFunction(this, "Function", {
      functionName: `${props.clientId}-ingestion`,
      description: `Ingestion handler for ${props.clientId}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "lambda",
        "ingestion",
        "handler.ts",
      ),
      memorySize,
      timeout: props.timeout ?? cdk.Duration.seconds(900),
      role: this.role,
      environment: {
        CLIENT_ID: props.clientId,
        DATA_BUCKET_NAME: props.dataBucket.bucketName,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        WEBHOOK_DEDUP_TABLE_NAME: props.webhookDedupTable.tableName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
        // Copy config files into the bundle so require('../../config/*.json')
        // resolves correctly inside the Lambda zip.
        commandHooks: {
          beforeBundling(): string[] {
            return [];
          },
          beforeInstall(): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [
              `mkdir -p ${outputDir}/config`,
              `cp ${inputDir}/config/deployment.json ${outputDir}/config/deployment.json`,
              // collections.json is optional — copy only if it exists
              `[ -f ${inputDir}/config/collections.json ] && cp ${inputDir}/config/collections.json ${outputDir}/config/collections.json || true`,
            ];
          },
        },
      },
    });

    // --- HTTP API Gateway integrations ---
    const integration = new apigatewayv2integrations.HttpLambdaIntegration(
      "Integration",
      this.fn,
    );

    new apigatewayv2.HttpRoute(this, "PostWebhookRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/webhook/{source}",
        apigatewayv2.HttpMethod.POST,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "PostIngestRecordRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/ingest/record",
        apigatewayv2.HttpMethod.POST,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "DeleteIngestRecordRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/ingest/record/{recordId}",
        apigatewayv2.HttpMethod.DELETE,
      ),
      integration,
    });
  }
}
