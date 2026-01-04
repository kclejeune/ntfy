export interface Env {
  // D1 Database
  DB: D1Database;

  // Durable Objects
  TOPIC_DO: DurableObjectNamespace;

  // R2 Storage for attachments
  ATTACHMENTS?: R2Bucket;

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

  // Attachment configuration
  NTFY_ATTACHMENT_FILE_SIZE_LIMIT?: string; // Per-file size limit in bytes (default: 15MB)
  NTFY_ATTACHMENT_TOTAL_SIZE_LIMIT?: string; // Total storage limit in bytes (default: 1GB)
  NTFY_ATTACHMENT_EXPIRY_DURATION?: string; // Attachment expiry in seconds (default: 3 hours)

  // Secrets (set via wrangler secret put)
  JWT_SECRET?: string;

  // Web Push VAPID keys (set via wrangler secret put)
  VAPID_PUBLIC_KEY?: string; // Base64url-encoded ECDSA P-256 public key
  VAPID_PRIVATE_KEY?: string; // Base64url-encoded ECDSA P-256 private key
  VAPID_SUBJECT?: string; // mailto: or https:// contact URL

  // Email publishing configuration (matches ntfy server naming)
  NTFY_SMTP_SERVER_DOMAIN?: string; // Domain for email-to-topic (e.g., "ntfy.yourdomain.com")
  NTFY_SMTP_SERVER_ADDR_PREFIX?: string; // Optional: prefix for email addresses (e.g., "ntfy-" for ntfy-topic@domain.com)
  NTFY_EMAIL_ARCHIVE_ADDRESS?: string; // Optional: forward processed emails to this address
}
