import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ManagedChatbotStack } from "../lib/managed-chatbot-stack";
import { DeploymentConfig } from "../lib/config";

describe("KnowledgeBase", () => {
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

  it("creates a Bedrock Managed Knowledge Base resource", () => {
    template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", {
      Name: "test-client-knowledge-base",
      KnowledgeBaseConfiguration: {
        Type: "MANAGED",
        ManagedKnowledgeBaseConfiguration: {
          EmbeddingModelType: "MANAGED",
        },
      },
    });
  });

  it("does not include a StorageConfiguration (fully managed)", () => {
    const kbResources = template.findResources("AWS::Bedrock::KnowledgeBase");
    const kbLogicalIds = Object.keys(kbResources);
    expect(kbLogicalIds.length).toBe(1);

    const kbProps = kbResources[kbLogicalIds[0]].Properties;
    expect(kbProps.StorageConfiguration).toBeUndefined();
  });

  it("creates a Bedrock Data Source linked to the S3 bucket", () => {
    template.hasResourceProperties("AWS::Bedrock::DataSource", {
      Name: "test-client-s3-data-source",
      DataSourceConfiguration: {
        Type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
        ManagedKnowledgeBaseConnectorConfiguration: {
          ConnectorParameters: Match.objectLike({
            type: "S3",
          }),
        },
      },
    });
  });

  it("creates an IAM role for the Knowledge Base with bedrock principal", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: {
              Service: "bedrock.amazonaws.com",
            },
            Effect: "Allow",
          }),
        ]),
      }),
    });
  });

  it("grants the KB role read access to documents/ prefix in data bucket", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject*"]),
            Effect: "Allow",
          }),
        ]),
      }),
    });
  });

  it("grants the KB role ListBucket access with documents/ prefix condition", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:ListBucket",
            Effect: "Allow",
            Condition: {
              StringLike: {
                "s3:prefix": ["documents/*"],
              },
            },
          }),
        ]),
      }),
    });
  });

  it("has cost allocation tags applied to the Knowledge Base", () => {
    template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", {
      Tags: Match.objectLike({
        ClientId: "test-client",
        ManagedBy: "cdk",
        Project: "managed-chatbot",
      }),
    });
  });
});
