import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ManagedChatbotStack } from "../lib/managed-chatbot-stack";
import { DeploymentConfig } from "../lib/config";

describe("ClientConfig", () => {
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

  describe("Parameter Store", () => {
    it("creates rate limits parameter with correct name", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/test-client/config/ratelimits",
        Type: "String",
        Value: JSON.stringify({ requestsPerMinute: 30 }),
      });
    });

    it("creates session parameter with correct name", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/test-client/config/session",
        Type: "String",
        Value: JSON.stringify({
          duration: 30,
          turnLimit: 50,
          tokenBudget: 8000,
          retentionDays: 7,
        }),
      });
    });

    it("creates datasource parameter with correct name", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/test-client/config/datasource",
        Type: "String",
        Value: JSON.stringify({
          type: "strapi",
          apiEndpoint: "https://cms.example.com",
          pageSize: 100,
        }),
      });
    });

    it("creates monitoring parameter with correct name", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/test-client/config/monitoring",
        Type: "String",
        Value: JSON.stringify({
          budgetAmount: 50,
          alarmEmail: "test@example.com",
        }),
      });
    });

    it("applies cost allocation tags to parameters", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/test-client/config/ratelimits",
        Tags: Match.objectLike({
          ClientId: "test-client",
          ManagedBy: "cdk",
          Project: "managed-chatbot",
        }),
      });
    });
  });

  describe("Secrets Manager", () => {
    it("creates api-keys secret with correct name", () => {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Name: "/test-client/secrets/api-keys",
        Description: "API keys for test-client",
      });
    });

    it("creates datasource secret with correct name", () => {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Name: "/test-client/secrets/datasource",
        Description: "Data source credentials for test-client",
      });
    });

    it("applies cost allocation tags to secrets", () => {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Name: "/test-client/secrets/api-keys",
        Tags: Match.arrayWith([
          Match.objectLike({ Key: "ClientId", Value: "test-client" }),
          Match.objectLike({ Key: "ManagedBy", Value: "cdk" }),
          Match.objectLike({ Key: "Project", Value: "managed-chatbot" }),
        ]),
      });
    });
  });
});
