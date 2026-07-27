/**
 * Deployment configuration interface for a single client stack.
 * All resources are deployed from this single configuration file.
 */
export interface DeploymentConfig {
  /** Lowercase alphanumeric + hyphens, 3-63 chars */
  clientId: string;
  /** Deployment region — always ap-southeast-2 */
  region: "ap-southeast-2";
  /**
   * Bedrock cross-region inference profile ID for the chat model.
   * Must use inference profile format (e.g. "au.anthropic.claude-sonnet-4-5-20250929-v1:0").
   * Raw model IDs are not supported with on-demand throughput.
   * @default "au.anthropic.claude-sonnet-4-5-20250929-v1:0"
   */
  modelId?: string;
  /**
   * Confidence threshold for KB retrieval results (0.0 - 1.0).
   * Results scoring below this value are filtered out.
   * @default 0.3
   */
  confidenceThreshold?: number;
  dataSource: {
    type: "strapi" | "craftcms" | "monday" | "employment-hero";
    apiEndpoint: string;
    /** Stored in Secrets Manager */
    apiToken: string;
    /** Stored in Secrets Manager */
    webhookSecret: string;
    /** Front-end base URL for constructing source links in markdown output (e.g. "https://staging.intranet.think-hq.com.au"). Stored in Secrets Manager. */
    frontendBaseUrl?: string;
    /** Default 100 */
    pageSize?: number;
  };
  session: {
    /** Minutes, default 30 */
    duration?: number;
    /** Default 50 */
    turnLimit?: number;
    /** Default 8000 */
    tokenBudget?: number;
    /** Default 7 */
    retentionDays?: number;
  };
  rateLimit: {
    /** Default 30 */
    requestsPerMinute?: number;
  };
  apiKeys: {
    appKey: string;
    adminKey: string;
  };
  monitoring: {
    /** Monthly USD budget threshold */
    budgetAmount: number;
    /** Email for alarm notifications */
    alarmEmail: string;
  };
}
