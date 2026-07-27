import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface AdminLambdaProps {
  /**
   * The client ID used for naming and tagging resources.
   */
  readonly clientId: string;

  /**
   * The DynamoDB Sessions table for analytics and sync state.
   */
  readonly sessionsTable: dynamodb.ITable;

  /**
   * SSM parameters the Lambda needs read/write access to (for config updates).
   */
  readonly ssmParameters: ssm.IStringParameter[];

  /**
   * Secrets Manager secrets the Lambda needs read access to.
   */
  readonly secrets: secretsmanager.ISecret[];

  /**
   * The HTTP API to attach Lambda integrations to.
   */
  readonly httpApi: apigatewayv2.HttpApi;

  /**
   * Memory size in MB.
   * @default 128
   */
  readonly memorySize?: number;

  /**
   * Lambda timeout.
   * @default 30 seconds
   */
  readonly timeout?: cdk.Duration;
}

/**
 * Admin Lambda CDK construct.
 *
 * Deploys a Node.js 20.x Lambda function (128MB) with:
 * - IAM permissions for DynamoDB (read/write), Parameter Store (read/write), Secrets Manager (read)
 * - HTTP API Gateway integrations for:
 *   GET /admin/config
 *   PUT /admin/config
 *   GET /admin/sync-status
 *   POST /admin/sync/trigger
 *   GET /admin/analytics
 * - Cost allocation tags (inherited from stack tags)
 */
export class AdminLambda extends Construct {
  /** The underlying Lambda function resource */
  public readonly fn: NodejsFunction;

  /** The IAM execution role */
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AdminLambdaProps) {
    super(scope, id);

    const memorySize = props.memorySize ?? 128;

    // --- IAM execution role ---
    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Admin Lambda execution role for ${props.clientId}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });

    // DynamoDB read/write on Sessions table (for analytics and sync state)
    props.sessionsTable.grantReadWriteData(this.role);

    // Parameter Store read/write permissions (admin can update config)
    for (const param of props.ssmParameters) {
      param.grantRead(this.role);
      param.grantWrite(this.role);
    }

    // Secrets Manager read permissions
    for (const secret of props.secrets) {
      secret.grantRead(this.role);
    }

    // --- Lambda function ---
    this.fn = new NodejsFunction(this, "Function", {
      functionName: `${props.clientId}-admin`,
      description: `Admin handler for ${props.clientId}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      entry: path.join(__dirname, "..", "..", "lambda", "admin", "index.ts"),
      memorySize,
      timeout: props.timeout ?? cdk.Duration.seconds(30),
      role: this.role,
      environment: {
        CLIENT_ID: props.clientId,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });

    // --- HTTP API Gateway integrations ---
    const integration = new apigatewayv2integrations.HttpLambdaIntegration(
      "Integration",
      this.fn,
    );

    new apigatewayv2.HttpRoute(this, "GetAdminConfigRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/admin/config",
        apigatewayv2.HttpMethod.GET,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "PutAdminConfigRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/admin/config",
        apigatewayv2.HttpMethod.PUT,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "GetSyncStatusRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/admin/sync-status",
        apigatewayv2.HttpMethod.GET,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "PostSyncTriggerRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/admin/sync/trigger",
        apigatewayv2.HttpMethod.POST,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "GetAnalyticsRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/admin/analytics",
        apigatewayv2.HttpMethod.GET,
      ),
      integration,
    });
  }
}
