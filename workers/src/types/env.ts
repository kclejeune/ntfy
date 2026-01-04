export interface Env {
  // D1 Database
  DB: D1Database;

  // Durable Objects
  TOPIC_DO: DurableObjectNamespace;

  // Environment variables
  DEFAULT_MESSAGE_EXPIRY: string;
  MAX_MESSAGE_SIZE: string;
  KEEPALIVE_INTERVAL: string;

  // Secrets (set via wrangler secret put)
  JWT_SECRET?: string;
}
