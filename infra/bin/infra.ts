#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ManagedChatbotStack } from "../lib/managed-chatbot-stack";
import { loadConfig } from "../lib/config";
import * as path from "path";

const app = new cdk.App();

// Load deployment config from the path specified via CDK context or default location
const configPath =
  app.node.tryGetContext("configPath") ||
  path.resolve(__dirname, "../config/deployment.json");
const config = loadConfig(configPath);

new ManagedChatbotStack(app, `ManagedChatbot-${config.clientId}`, {
  config,
  env: {
    region: config.region,
  },
  description: `AWS Managed Chatbot stack for client: ${config.clientId}`,
});
