import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ManagedChatbotStack } from "../lib/managed-chatbot-stack";
import { DeploymentConfig } from "../lib/config";

describe("DataBucket", () => {
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

  it("creates an S3 bucket with the correct name", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "test-client-kb-data",
    });
  });

  it("blocks all public access", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("enables versioning", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: {
        Status: "Enabled",
      },
    });
  });

  it("configures lifecycle rule with IA transition after 30 days", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: "STANDARD_IA",
                TransitionInDays: 30,
              }),
            ]),
          }),
        ]),
      },
    });
  });

  it("configures lifecycle rule with deletion after 90 days", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            ExpirationInDays: 90,
          }),
        ]),
      },
    });
  });

  it("sets removal policy to DESTROY for dev environments", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
  });

  it("has cost allocation tags applied", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: "ClientId", Value: "test-client" }),
        Match.objectLike({ Key: "ManagedBy", Value: "cdk" }),
        Match.objectLike({ Key: "Project", Value: "managed-chatbot" }),
      ]),
    });
  });
});
