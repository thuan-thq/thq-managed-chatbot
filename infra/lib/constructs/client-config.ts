import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { DeploymentConfig } from "../config";

export interface ClientConfigProps {
  /**
   * The full deployment configuration for the client.
   * Used to populate Parameter Store entries and Secrets Manager secrets.
   */
  readonly config: DeploymentConfig;
}

/**
 * Parameter Store and Secrets Manager resources for client configuration.
 *
 * Parameter Store schema:
 * - /{clientId}/config/ratelimits   → JSON: RateLimitConfig
 * - /{clientId}/config/session      → JSON: SessionConfig
 * - /{clientId}/config/datasource   → JSON: DataSourceConfig
 * - /{clientId}/config/monitoring   → JSON: MonitoringConfig
 *
 * Secrets Manager schema:
 * - /{clientId}/secrets/api-keys    → JSON: { appKey, adminKey }
 * - /{clientId}/secrets/datasource  → JSON: { apiToken, webhookSecret }
 */
export class ClientConfig extends Construct {
  public readonly rateLimitsParameter: ssm.StringParameter;
  public readonly sessionParameter: ssm.StringParameter;
  public readonly dataSourceParameter: ssm.StringParameter;
  public readonly monitoringParameter: ssm.StringParameter;
  public readonly apiKeysSecret: secretsmanager.Secret;
  public readonly dataSourceSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ClientConfigProps) {
    super(scope, id);

    const { config } = props;
    const clientId = config.clientId;

    // Parameter Store: Rate Limits
    this.rateLimitsParameter = new ssm.StringParameter(this, "RateLimits", {
      parameterName: `/${clientId}/config/ratelimits`,
      description: `Rate limit configuration for ${clientId}`,
      stringValue: JSON.stringify({
        requestsPerMinute: config.rateLimit.requestsPerMinute ?? 30,
      }),
    });

    // Parameter Store: Session
    this.sessionParameter = new ssm.StringParameter(this, "Session", {
      parameterName: `/${clientId}/config/session`,
      description: `Session configuration for ${clientId}`,
      stringValue: JSON.stringify({
        duration: config.session.duration ?? 30,
        turnLimit: config.session.turnLimit ?? 50,
        tokenBudget: config.session.tokenBudget ?? 8000,
        retentionDays: config.session.retentionDays ?? 7,
      }),
    });

    // Parameter Store: Data Source (non-sensitive metadata only)
    this.dataSourceParameter = new ssm.StringParameter(this, "DataSource", {
      parameterName: `/${clientId}/config/datasource`,
      description: `Data source configuration for ${clientId}`,
      stringValue: JSON.stringify({
        type: config.dataSource.type,
        apiEndpoint: config.dataSource.apiEndpoint,
        pageSize: config.dataSource.pageSize ?? 100,
      }),
    });

    // Parameter Store: Monitoring
    this.monitoringParameter = new ssm.StringParameter(this, "Monitoring", {
      parameterName: `/${clientId}/config/monitoring`,
      description: `Monitoring configuration for ${clientId}`,
      stringValue: JSON.stringify({
        budgetAmount: config.monitoring.budgetAmount,
        alarmEmail: config.monitoring.alarmEmail,
      }),
    });

    // Secrets Manager: API Keys
    this.apiKeysSecret = new secretsmanager.Secret(this, "ApiKeys", {
      secretName: `/${clientId}/secrets/api-keys`,
      description: `API keys for ${clientId}`,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          appKey: config.apiKeys.appKey,
          adminKey: config.apiKeys.adminKey,
        }),
      ),
    });

    // Secrets Manager: Data Source Credentials
    this.dataSourceSecret = new secretsmanager.Secret(
      this,
      "DataSourceCredentials",
      {
        secretName: `/${clientId}/secrets/datasource`,
        description: `Data source credentials for ${clientId}`,
        secretStringValue: cdk.SecretValue.unsafePlainText(
          JSON.stringify({
            apiToken: config.dataSource.apiToken,
            webhookSecret: config.dataSource.webhookSecret,
            apiEndpoint: config.dataSource.apiEndpoint,
            frontendBaseUrl: config.dataSource.frontendBaseUrl,
          }),
        ),
      },
    );
  }
}
