export interface Env {
  // D1 Database
  DB: D1Database;

  // Durable Objects
  TOPIC_DO: DurableObjectNamespace;

  // Environment variables (NTFY_ prefix for consistency with upstream ntfy)
  NTFY_CACHE_DURATION: string; // Message cache duration in seconds (default: 43200 = 12h)
  NTFY_MESSAGE_SIZE_LIMIT: string; // Max message size in bytes (default: 4096)
  NTFY_KEEPALIVE_INTERVAL: string; // WebSocket keepalive interval in seconds (default: 45)

  // Config toggles (for UI)
  NTFY_ENABLE_LOGIN?: string;
  NTFY_ENABLE_SIGNUP?: string;
  NTFY_ENABLE_RESERVATIONS?: string;
  NTFY_AUTH_DEFAULT_ACCESS?: string; // "read-write" (default) or "deny-all" to require login

  // Upstream configuration for iOS push notifications
  NTFY_BASE_URL?: string;
  NTFY_UPSTREAM_BASE_URL?: string;
  NTFY_UPSTREAM_ACCESS_TOKEN?: string;

  // Secrets (set via wrangler secret put)
  JWT_SECRET?: string;
}
