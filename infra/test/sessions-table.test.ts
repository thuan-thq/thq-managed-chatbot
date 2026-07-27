import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ManagedChatbotStack } from "../lib/managed-chatbot-stack";
import { DeploymentConfig } from "../lib/config";

describe("SessionsTable", () => {
  const testConfig: DeploymentConfig = {
    clientId: "test-client",
    region: "ap-southeast-2",
    dataSource: {
      type: "strapi",
      apiEndpoint: "https://cms.example.com",
      apiToken: "token-123",
      webhookSecret: "secret-456",
    },
    session: {
      duration: 30,
      turnLimit: 50,
      tokenBudget: 8000,
      retentionDays: 7,
    },
    rateLimit: {
      requestsPerMinute: 30,
    },
    apiKeys: {
      appKey: "wk-key",
      adminKey: "ak-key",
    },
    monitoring: {
      budgetAmount: 50,
      alarmEmail: "test@example.com",
    },
  };

  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ManagedChatbotStack(app, "TestStack", {
      config: testConfig,
    });
    template = Template.fromStack(stack);
  });

  it("creates a DynamoDB table with PK and SK keys", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
    });
  });

  it("uses provisioned billing mode with 1 RCU and 1 WCU base", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: Match.absent(),
      ProvisionedThroughput: {
        ReadCapacityUnits: 1,
        WriteCapacityUnits: 1,
      },
    });
  });

  it("enables TTL with attribute name TTL", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: {
        AttributeName: "TTL",
        Enabled: true,
      },
    });
  });

  it("sets removal policy to RETAIN", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("enables point-in-time recovery", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  it("configures read auto-scaling target with max 50 RCU", () => {
    template.hasResourceProperties(
      "AWS::ApplicationAutoScaling::ScalableTarget",
      {
        MaxCapacity: 50,
        MinCapacity: 1,
        ScalableDimension: "dynamodb:table:ReadCapacityUnits",
      },
    );
  });

  it("configures write auto-scaling target with max 25 WCU", () => {
    template.hasResourceProperties(
      "AWS::ApplicationAutoScaling::ScalableTarget",
      {
        MaxCapacity: 25,
        MinCapacity: 1,
        ScalableDimension: "dynamodb:table:WriteCapacityUnits",
      },
    );
  });

  it("sets 70% target utilization for read scaling policy", () => {
    template.hasResourceProperties(
      "AWS::ApplicationAutoScaling::ScalingPolicy",
      {
        TargetTrackingScalingPolicyConfiguration: {
          PredefinedMetricSpecification: {
            PredefinedMetricType: "DynamoDBReadCapacityUtilization",
          },
          TargetValue: 70,
        },
      },
    );
  });

  it("sets 70% target utilization for write scaling policy", () => {
    template.hasResourceProperties(
      "AWS::ApplicationAutoScaling::ScalingPolicy",
      {
        TargetTrackingScalingPolicyConfiguration: {
          PredefinedMetricSpecification: {
            PredefinedMetricType: "DynamoDBWriteCapacityUtilization",
          },
          TargetValue: 70,
        },
      },
    );
  });
});
