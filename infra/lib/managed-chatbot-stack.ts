import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { DeploymentConfig } from "./config";
import {
  AdminLambda,
  ApiGateway,
  ChatLambda,
  ClientConfig,
  DataBucket,
  IngestionLambda,
  KnowledgeBase,
  SessionsTable,
  WebhookDedupTable,
} from "./constructs";

export interface ManagedChatbotStackProps extends cdk.StackProps {
  readonly config: DeploymentConfig;
}

/**
 * Base stack for the AWS Managed Chatbot platform.
 * Deploys all resources for a single client from the provided DeploymentConfig.
 * All resources are deployed to ap-southeast-2.
 */
export class ManagedChatbotStack extends cdk.Stack {
  public readonly config: DeploymentConfig;
  public readonly sessionsTable: SessionsTable;
  public readonly webhookDedupTable: WebhookDedupTable;
  public readonly dataBucket: DataBucket;
  public readonly knowledgeBase: KnowledgeBase;
  public readonly apiGateway: ApiGateway;
  public readonly clientConfig: ClientConfig;
  public readonly chatLambda: ChatLambda;
  public readonly ingestionLambda: IngestionLambda;
  public readonly adminLambda: AdminLambda;

  constructor(scope: Construct, id: string, props: ManagedChatbotStackProps) {
    super(scope, id, {
      ...props,
      env: {
        region: props.config.region,
        ...props.env,
      },
      tags: {
        ClientId: props.config.clientId,
        Project: "managed-chatbot",
        ManagedBy: "cdk",
        ...props.tags,
      },
    });

    this.config = props.config;

    // Apply cost allocation tags to all resources in the stack
    cdk.Tags.of(this).add("ClientId", this.config.clientId);
    cdk.Tags.of(this).add("Project", "managed-chatbot");
    cdk.Tags.of(this).add("ManagedBy", "cdk");

    // DynamoDB Sessions table for session state management
    this.sessionsTable = new SessionsTable(this, "SessionsTable");

    // DynamoDB Webhook Deduplication table for at-most-once processing
    this.webhookDedupTable = new WebhookDedupTable(this, "WebhookDedupTable");

    // S3 Data Bucket for knowledge base documents and sync state
    this.dataBucket = new DataBucket(this, "DataBucket", {
      clientId: this.config.clientId,
    });

    // Bedrock Knowledge Base with S3 data source
    this.knowledgeBase = new KnowledgeBase(this, "KnowledgeBase", {
      dataBucket: this.dataBucket.bucket,
      clientId: this.config.clientId,
    });

    // HTTP API Gateway for client requests
    this.apiGateway = new ApiGateway(this, "ApiGateway", {
      apiName: `${this.config.clientId}-chatbot-api`,
      description: `Managed Chatbot API for ${this.config.clientId}`,
    });

    // Parameter Store and Secrets Manager for client configuration
    this.clientConfig = new ClientConfig(this, "ClientConfig", {
      config: this.config,
    });

    // Chat Lambda — handles POST /chat, POST /session, GET /session/{sessionId}
    this.chatLambda = new ChatLambda(this, "ChatLambda", {
      clientId: this.config.clientId,
      sessionsTable: this.sessionsTable.table,
      knowledgeBaseId: this.knowledgeBase.knowledgeBaseId,
      knowledgeBaseArn: this.knowledgeBase.knowledgeBaseArn,
      httpApi: this.apiGateway.httpApi,
      modelId: this.config.modelId,
      confidenceThreshold: this.config.confidenceThreshold,
      ssmParameters: [
        this.clientConfig.rateLimitsParameter,
        this.clientConfig.sessionParameter,
        this.clientConfig.dataSourceParameter,
        this.clientConfig.monitoringParameter,
      ],
      secrets: [
        this.clientConfig.apiKeysSecret,
        this.clientConfig.dataSourceSecret,
      ],
    });

    // Ingestion Lambda - handles POST /webhook/{source}, POST /ingest/record, DELETE /ingest/record/{recordId}
    this.ingestionLambda = new IngestionLambda(this, "IngestionLambda", {
      clientId: this.config.clientId,
      dataBucket: this.dataBucket.bucket,
      sessionsTable: this.sessionsTable.table,
      webhookDedupTable: this.webhookDedupTable.table,
      knowledgeBaseId: this.knowledgeBase.knowledgeBaseId,
      knowledgeBaseArn: this.knowledgeBase.knowledgeBaseArn,
      dataSourceId: this.knowledgeBase.dataSource.attrDataSourceId,
      httpApi: this.apiGateway.httpApi,
      ssmParameters: [
        this.clientConfig.dataSourceParameter,
        this.clientConfig.monitoringParameter,
      ],
      secrets: [
        this.clientConfig.apiKeysSecret,
        this.clientConfig.dataSourceSecret,
      ],
    });

    // Admin Lambda - handles GET/PUT /admin/config, GET /admin/sync-status, POST /admin/sync/trigger, GET /admin/analytics
    this.adminLambda = new AdminLambda(this, "AdminLambda", {
      clientId: this.config.clientId,
      sessionsTable: this.sessionsTable.table,
      httpApi: this.apiGateway.httpApi,
      ssmParameters: [
        this.clientConfig.rateLimitsParameter,
        this.clientConfig.sessionParameter,
        this.clientConfig.dataSourceParameter,
        this.clientConfig.monitoringParameter,
      ],
      secrets: [
        this.clientConfig.apiKeysSecret,
        this.clientConfig.dataSourceSecret,
      ],
    });

    // Stack outputs - printed by CDK after deploy
    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: this.apiGateway.apiEndpoint,
      description: "HTTP API Gateway endpoint URL",
      exportName: `${this.config.clientId}-api-endpoint`,
    });

    new cdk.CfnOutput(this, "ChatStreamEndpoint", {
      value: this.chatLambda.streamFunctionUrl.url,
      description:
        "Lambda Function URL for streaming chat - use as NEXT_PUBLIC_STREAM_ENDPOINT",
      exportName: `${this.config.clientId}-chat-stream-endpoint`,
    });
  }
}
