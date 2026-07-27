import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { Construct } from "constructs";

/**
 * Route definition for the API Gateway.
 */
export interface RouteDefinition {
  /** HTTP method (GET, POST, etc.) */
  readonly method: string;
  /** Route path (e.g. /chat, /session/{sessionId}) */
  readonly path: string;
}

export interface ApiGatewayProps {
  /**
   * Name for the HTTP API.
   */
  readonly apiName: string;

  /**
   * Description of the API.
   * @default - none
   */
  readonly description?: string;
}

/**
 * Phase 1 route definitions for the managed chatbot API.
 * These are the routes that will be served by the Chat Lambda.
 */
export const PHASE1_ROUTES: RouteDefinition[] = [
  { method: "POST", path: "/chat" },
  { method: "POST", path: "/session" },
  { method: "GET", path: "/session/{sessionId}" },
];

/**
 * HTTP API Gateway construct for the managed chatbot platform.
 *
 * Deploys an HTTP API (not REST API) for cost efficiency.
 * AWS HTTP API Gateway automatically generates request IDs via $context.requestId
 * which is available in access logs and integration request/response mappings.
 *
 * Phase 1 routes:
 * - POST /chat        → Chat handler
 * - POST /session     → Session creation
 * - GET /session/{sessionId} → Session status
 *
 * Routes are defined without integrations; Lambda integrations will be
 * attached in a subsequent deployment task.
 */
export class ApiGateway extends Construct {
  /** The underlying HTTP API resource */
  public readonly httpApi: apigatewayv2.HttpApi;

  /** The API endpoint URL */
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    this.httpApi = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: props.apiName,
      description: props.description,
      createDefaultStage: true,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "x-api-key",
          "x-webhook-secret",
          "x-webhook-id",
        ],
        maxAge: cdk.Duration.hours(1),
      },
    });

    this.apiEndpoint = this.httpApi.apiEndpoint;
  }
}
