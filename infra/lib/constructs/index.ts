/**
 * Shared constructs directory.
 * Reusable CDK constructs for the managed chatbot platform are exported from here.
 */

export { AdminLambda, AdminLambdaProps } from "./admin-lambda";
export { ApiGateway, ApiGatewayProps, PHASE1_ROUTES } from "./api-gateway";
export { ChatLambda, ChatLambdaProps } from "./chat-lambda";
export { ClientConfig, ClientConfigProps } from "./client-config";
export { DataBucket, DataBucketProps } from "./data-bucket";
export { IngestionLambda, IngestionLambdaProps } from "./ingestion-lambda";
export { KnowledgeBase, KnowledgeBaseProps } from "./knowledge-base";
export { SessionsTable, SessionsTableProps } from "./sessions-table";
export {
  WebhookDedupTable,
  WebhookDedupTableProps,
} from "./webhook-dedup-table";
