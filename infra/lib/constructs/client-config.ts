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
 * - /{clientId}/config/datasource   → JSON: DataSourceConfig[] (non-sensitive metadata)
 * - /{clientId}/config/monitoring   → JSON: MonitoringConfig
 *
 * Secrets Manager schema:
 * - /{clientId}/secrets/api-keys                  → JSON: { appKey, adminKey }
 * - /{clientId}/secrets/datasource/{sourceId}     → JSON: { apiToken, webhookSecret, ... } per source
 */
export class ClientConfig extends Construct {
  public readonly rateLimitsParameter: ssm.StringParameter;
  public readonly sessionParameter: ssm.StringParameter;
  public readonly dataSourceParameter: ssm.StringParameter;
  public readonly monitoringParameter: ssm.StringParameter;
  public readonly apiKeysSecret: secretsmanager.Secret;
  /** One secret per data source, keyed by source id. */
  public readonly dataSourceSecrets: Map<string, secretsmanager.Secret>;
  /**
   * @deprecated Use dataSourceSecrets instead.
   * Points to the first data source's secret for backwards compatibility
   * with constructs that accept a single secret reference.
   */
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

    // Parameter Store: Data Source (non-sensitive metadata only — one entry per source)
    this.dataSourceParameter = new ssm.StringParameter(this, "DataSource", {
      parameterName: `/${clientId}/config/datasource`,
      description: `Data source configuration for ${clientId}`,
      stringValue: JSON.stringify(
        config.dataSources.map((ds) => ({
          id: ds.id,
          type: ds.type,
          apiEndpoint: ds.apiEndpoint,
          pageSize: ds.pageSize ?? 100,
        })),
      ),
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

    // Secrets Manager: one secret per data source at /{clientId}/secrets/datasource/{sourceId}
    this.dataSourceSecrets = new Map<string, secretsmanager.Secret>();
    for (const ds of config.dataSources) {
      const secret = new secretsmanager.Secret(
        this,
        `DataSourceCredentials-${ds.id}`,
        {
          secretName: `/${clientId}/secrets/datasource/${ds.id}`,
          description: `Data source credentials for ${clientId} / ${ds.id}`,
          secretStringValue: cdk.SecretValue.unsafePlainText(
            JSON.stringify({
              apiToken: ds.apiToken,
              webhookSecret: ds.webhookSecret,
              apiEndpoint: ds.apiEndpoint,
              frontendBaseUrl: ds.frontendBaseUrl,
            }),
          ),
        },
      );
      this.dataSourceSecrets.set(ds.id, secret);
    }

    // Point the legacy single-secret reference to the first source
    this.dataSourceSecret = this.dataSourceSecrets.values().next()
      .value as secretsmanager.Secret;
  }
}
