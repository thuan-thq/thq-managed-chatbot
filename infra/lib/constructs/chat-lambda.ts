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

export interface ChatLambdaProps {
  /**
   * The client ID used for naming and tagging resources.
   */
  readonly clientId: string;

  /**
   * The DynamoDB Sessions table the Lambda will read/write.
   */
  readonly sessionsTable: dynamodb.ITable;

  /**
   * The Bedrock Knowledge Base ID.
   */
  readonly knowledgeBaseId: string;

  /**
   * The Bedrock Knowledge Base ARN.
   */
  readonly knowledgeBaseArn: string;

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
   * Bedrock cross-region inference profile ID for the chat model.
   * @default "au.anthropic.claude-sonnet-4-5-20250929-v1:0"
   */
  readonly modelId?: string;

  /**
   * Confidence threshold for KB retrieval results (0.0 - 1.0).
   * @default 0.3
   */
  readonly confidenceThreshold?: number;

  /**
   * Memory size in MB. Must be >= 512.
   * @default 512
   */
  readonly memorySize?: number;

  /**
   * Lambda timeout.
   * @default 30 seconds
   */
  readonly timeout?: cdk.Duration;
}

/**
 * Chat Lambda CDK construct.
 *
 * Deploys two Lambda functions:
 * 1. A standard Lambda for POST /session and GET /session/{sessionId} (via API Gateway)
 * 2. A streaming Lambda for POST /chat (via Function URL with RESPONSE_STREAM)
 *
 * The streaming Lambda uses Lambda Response Streaming to deliver SSE events
 * token-by-token to the client in real time.
 *
 * Both functions share the same IAM role and environment configuration.
 */
export class ChatLambda extends Construct {
  /** The standard Lambda function (session routes) */
  public readonly fn: NodejsFunction;

  /** The streaming Lambda function (chat route) */
  public readonly streamFn: NodejsFunction;

  /** The Function URL for the streaming Lambda */
  public readonly streamFunctionUrl: lambda.FunctionUrl;

  /** The IAM execution role */
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: ChatLambdaProps) {
    super(scope, id);

    const memorySize = props.memorySize ?? 512;
    if (memorySize < 512) {
      throw new Error(
        `ChatLambda memorySize must be >= 512 MB, got ${memorySize}`,
      );
    }

    // --- IAM execution role ---
    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Chat Lambda execution role for ${props.clientId}`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });

    // Bedrock Knowledge Base permissions
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockKnowledgeBase",
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"],
        resources: [props.knowledgeBaseArn],
      }),
    );

    // Bedrock Runtime permissions (model invocation via cross-region inference profiles)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockRuntime",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/*`,
          `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/*`,
          `arn:aws:bedrock:*::foundation-model/*`,
        ],
      }),
    );

    // DynamoDB read/write on Sessions table
    props.sessionsTable.grantReadWriteData(this.role);

    // Parameter Store read permissions
    for (const param of props.ssmParameters) {
      param.grantRead(this.role);
    }

    // Secrets Manager read permissions
    for (const secret of props.secrets) {
      secret.grantRead(this.role);
    }

    // --- Lambda function (session routes only) ---
    this.fn = new NodejsFunction(this, "Function", {
      functionName: `${props.clientId}-chat`,
      description: `Session handler for ${props.clientId}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      entry: path.join(__dirname, "..", "..", "lambda", "chat", "index.ts"),
      memorySize,
      timeout: props.timeout ?? cdk.Duration.seconds(30),
      role: this.role,
      environment: {
        CLIENT_ID: props.clientId,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        CLAUDE_MODEL_ID:
          props.modelId ?? "au.anthropic.claude-sonnet-4-5-20250929-v1:0",
        CONFIDENCE_THRESHOLD: String(props.confidenceThreshold ?? 0.3),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });

    // --- Streaming Lambda function (POST /chat with real-time SSE) ---
    this.streamFn = new NodejsFunction(this, "StreamFunction", {
      functionName: `${props.clientId}-chat-stream`,
      description: `Streaming chat handler for ${props.clientId}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "lambda",
        "chat",
        "stream-handler.ts",
      ),
      memorySize,
      timeout: props.timeout ?? cdk.Duration.seconds(60),
      role: this.role,
      environment: {
        CLIENT_ID: props.clientId,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        CLAUDE_MODEL_ID:
          props.modelId ?? "au.anthropic.claude-sonnet-4-5-20250929-v1:0",
        CONFIDENCE_THRESHOLD: String(props.confidenceThreshold ?? 0.3),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    });

    // Function URL with RESPONSE_STREAM for real-time SSE streaming
    this.streamFunctionUrl = this.streamFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // --- HTTP API Gateway integrations (session routes only) ---
    // POST /chat is handled by the streaming Function URL instead.
    const integration = new apigatewayv2integrations.HttpLambdaIntegration(
      "Integration",
      this.fn,
    );

    new apigatewayv2.HttpRoute(this, "PostSessionRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/session",
        apigatewayv2.HttpMethod.POST,
      ),
      integration,
    });

    new apigatewayv2.HttpRoute(this, "GetSessionRoute", {
      httpApi: props.httpApi,
      routeKey: apigatewayv2.HttpRouteKey.with(
        "/session/{sessionId}",
        apigatewayv2.HttpMethod.GET,
      ),
      integration,
    });
  }
}
