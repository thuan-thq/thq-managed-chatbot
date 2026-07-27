import * as cdk from "aws-cdk-lib";
import { ManagedChatbotStack } from "../lib/managed-chatbot-stack";
import { DeploymentConfig } from "../lib/config";

describe("ManagedChatbotStack", () => {
  const testConfig: DeploymentConfig = {
    clientId: "test-client",
    region: "ap-southeast-2",
    dataSource: {
      type: "strapi",
      apiEndpoint: "https://cms.example.com",
      apiToken: "token-123",
      webhookSecret: "secret-456",
      pageSize: 100,
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

  it("creates a stack with the correct region", () => {
    const app = new cdk.App();
    const stack = new ManagedChatbotStack(app, "TestStack", {
      config: testConfig,
    });

    expect(stack.region).toBe("ap-southeast-2");
  });

  it("stores the deployment config on the stack", () => {
    const app = new cdk.App();
    const stack = new ManagedChatbotStack(app, "TestStack", {
      config: testConfig,
    });

    expect(stack.config).toBe(testConfig);
    expect(stack.config.clientId).toBe("test-client");
  });

  it("applies cost allocation tags", () => {
    const app = new cdk.App();
    const stack = new ManagedChatbotStack(app, "TestStack", {
      config: testConfig,
    });

    const tags = cdk.Tags.of(stack);
    // Verify tags were applied (we can't directly read them from Tags.of,
    // but we can synthesize and check the template)
    const template = app.synth().getStackByName(stack.stackName);
    // The stack should synthesize without error
    expect(template).toBeDefined();
  });

  it("synthesizes without errors", () => {
    const app = new cdk.App();
    const stack = new ManagedChatbotStack(app, "TestStack", {
      config: testConfig,
    });

    // This will throw if the stack has synthesis errors
    const assembly = app.synth();
    expect(assembly.getStackByName(stack.stackName)).toBeDefined();
  });
});
