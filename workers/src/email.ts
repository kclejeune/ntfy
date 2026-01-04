import type { Env } from "./types/env";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import type { AuthContext, Token, User, TokenRow, UserRow } from "./types/user";
import { publishMessageInternal, parsePriority } from "./handlers/publish";
import { checkTopicAccess } from "./auth/access";

/**
 * Email Worker handler for email-to-topic publishing.
 * Emails sent to mytopic@ntfy.yourdomain.com will be published to that topic.
 * If SMTP_SERVER_ADDR_PREFIX is set (e.g., "ntfy-"), emails to ntfy-mytopic@domain.com
 * will publish to "mytopic".
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const recipient = message.to;
  const from = message.from;
  const subject = message.headers.get("subject") || "";

  // Extract topic and optional token from recipient address
  // e.g., "mytopic@ntfy.yourdomain.com" -> topic: "mytopic"
  // With prefix "ntfy-": "ntfy-mytopic@domain.com" -> topic: "mytopic"
  // With token: "mytopic+tk_TOKEN@domain.com" -> topic: "mytopic", token: "tk_TOKEN"
  const parsed = extractTopicFromEmail(
    recipient,
    env.NTFY_SMTP_SERVER_ADDR_PREFIX,
  );

  if (!parsed) {
    // Reject emails without valid topic (or missing required prefix)
    const prefix = env.NTFY_SMTP_SERVER_ADDR_PREFIX || "";
    const basePrefix = prefix.replace(/[-_.]$/, "");
    message.setReject(
      prefix
        ? `Invalid recipient: expected format ${prefix}<topic>@domain or ${basePrefix}+<topic>@domain`
        : "Invalid recipient: topic not found",
    );
    return;
  }

  const { topic, token } = parsed;

  // Validate topic format (alphanumeric, underscore, hyphen, 1-64 chars)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
    message.setReject("Invalid topic format");
    return;
  }

  // Authenticate with token if provided, otherwise anonymous
  const auth = token
    ? await authenticateToken(env.DB, token)
    : { anonymous: true };

  // Check write access to topic
  const access = await checkTopicAccess(env.DB, topic, auth, "write");
  if (!access.allowed) {
    message.setReject(access.error || "Access denied");
    return;
  }

  // Read email body
  let body = "";
  try {
    body = await streamToText(message.raw);
    body = parseEmailBody(body);
  } catch (err) {
    console.error("Failed to read email body:", err);
    body = "";
  }

  // Extract priority from subject (e.g., "[high]" or "[urgent]" prefix)
  const { priority, cleanSubject } = extractPriority(subject);

  // Publish the message
  try {
    await publishMessageInternal(env, {
      topic,
      title: cleanSubject || undefined,
      message: body || "(no content)",
      priority,
      tags: ["email"],
      sender: from,
    });

    // Optionally forward to archive address
    if (env.NTFY_EMAIL_ARCHIVE_ADDRESS) {
      await message.forward(env.NTFY_EMAIL_ARCHIVE_ADDRESS);
    }
  } catch (err) {
    console.error("Failed to publish email message:", err);
    message.setReject("Failed to process email");
  }
}

interface EmailParseResult {
  topic: string;
  token?: string; // Access token (tk_...) for authentication
}

/**
 * Authenticate with a database token (tk_*).
 * Returns the auth context with user info if valid, anonymous otherwise.
 */
async function authenticateToken(
  db: D1Database,
  tokenId: string,
): Promise<AuthContext> {
  // Look up token in database
  const tokenRow = await db
    .prepare(
      "SELECT id, user_id, label, last_access, last_origin, expires FROM tokens WHERE id = ?",
    )
    .bind(tokenId)
    .first<TokenRow>();

  if (!tokenRow) {
    return { anonymous: true };
  }

  // Check if token is expired
  const now = Math.floor(Date.now() / 1000);
  if (tokenRow.expires > 0 && tokenRow.expires < now) {
    return { anonymous: true };
  }

  // Get user
  const userRow = await db
    .prepare(
      "SELECT id, username, role, tier, sync_topic, created FROM users WHERE id = ?",
    )
    .bind(tokenRow.user_id)
    .first<UserRow>();

  if (!userRow) {
    return { anonymous: true };
  }

  const user: User = {
    id: userRow.id,
    username: userRow.username,
    role: userRow.role as User["role"],
    tier: userRow.tier,
    sync_topic: userRow.sync_topic,
    created: userRow.created,
  };

  const token: Token = {
    id: tokenRow.id,
    user_id: tokenRow.user_id,
    label: tokenRow.label,
    last_access: tokenRow.last_access,
    last_origin: tokenRow.last_origin,
    expires: tokenRow.expires,
  };

  // Update last access
  await db
    .prepare("UPDATE tokens SET last_access = ?, last_origin = ? WHERE id = ?")
    .bind(now, "email", tokenId)
    .run();

  return { user, token, anonymous: false };
}

/**
 * Extract topic and optional token from email recipient address.
 *
 * Supported formats:
 * - "topic@domain" -> topic
 * - "topic+tk_TOKEN@domain" -> topic with auth token
 * - "ntfy-topic@domain" -> topic (with prefix "ntfy-")
 * - "ntfy-topic+tk_TOKEN@domain" -> topic with auth token
 * - "ntfy+topic@domain" -> topic (subaddressing with prefix)
 * - "ntfy+topic+tk_TOKEN@domain" -> topic with auth token (subaddressing)
 *
 * Token format: tk_* (e.g., tk_AbC123dEf456)
 */
function extractTopicFromEmail(
  address: string,
  prefix?: string,
): EmailParseResult | null {
  // Match local part which may contain + for subaddressing/tokens
  const match = address.match(/^([a-zA-Z0-9_+.-]+)@/);
  if (!match) {
    return null;
  }

  const localPart = match[1];

  // Split on + to get parts (base, topic/token, token)
  const parts = localPart.split("+");

  // Extract any token (parts starting with tk_)
  let token: string | undefined;
  const nonTokenParts: string[] = [];

  for (const part of parts) {
    if (part.startsWith("tk_")) {
      token = part;
    } else {
      nonTokenParts.push(part);
    }
  }

  if (nonTokenParts.length === 0) {
    return null; // No topic found
  }

  let topic: string;

  if (nonTokenParts.length === 1) {
    // Single part: either "topic" or "ntfy-topic" (prefix format)
    const base = nonTokenParts[0];

    if (prefix) {
      if (!base.startsWith(prefix)) {
        return null; // Prefix required but not present
      }
      topic = base.slice(prefix.length);
    } else {
      topic = base;
    }
  } else if (nonTokenParts.length === 2) {
    // Two parts: "ntfy+topic" (subaddressing format)
    const [base, subTopic] = nonTokenParts;

    if (prefix) {
      // Strip trailing punctuation from prefix for comparison (e.g., "ntfy-" -> "ntfy")
      const basePrefix = prefix.replace(/[-_.]$/, "");
      if (base !== basePrefix) {
        return null; // Base doesn't match expected prefix
      }
    }

    topic = subTopic;
  } else {
    return null; // Too many parts
  }

  // Validate topic format
  if (!topic || !/^[a-zA-Z0-9_-]+$/.test(topic)) {
    return null;
  }

  return { topic, token };
}

/**
 * Parse the body from a raw email message.
 * This is a simplified parser that extracts the first text/plain part.
 */
function parseEmailBody(raw: string): string {
  // Find the boundary between headers and body (empty line)
  const headerBodySplit = raw.indexOf("\r\n\r\n");
  if (headerBodySplit === -1) {
    // Try with just \n\n
    const altSplit = raw.indexOf("\n\n");
    if (altSplit === -1) {
      return raw; // No clear separation, return as-is
    }
    return raw.slice(altSplit + 2).trim();
  }

  const headers = raw.slice(0, headerBodySplit);
  let body = raw.slice(headerBodySplit + 4);

  // Check if multipart
  const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
  const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : "";

  if (contentType.startsWith("multipart/")) {
    // Extract boundary
    const boundaryMatch = headers.match(/boundary="?([^"\r\n;]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      // Find first text/plain part
      const parts = body.split(`--${boundary}`);
      for (const part of parts) {
        if (
          part.includes("Content-Type: text/plain") ||
          part.includes("content-type: text/plain")
        ) {
          // Extract body from this part
          const partBodyStart = part.indexOf("\r\n\r\n");
          if (partBodyStart !== -1) {
            body = part.slice(partBodyStart + 4);
            break;
          }
        }
      }
    }
  }

  // Handle quoted-printable encoding
  if (
    headers
      .toLowerCase()
      .includes("content-transfer-encoding: quoted-printable")
  ) {
    body = decodeQuotedPrintable(body);
  }

  // Handle base64 encoding
  if (headers.toLowerCase().includes("content-transfer-encoding: base64")) {
    try {
      body = atob(body.replace(/\s/g, ""));
    } catch {
      // Keep as-is if decode fails
    }
  }

  return body.trim();
}

/**
 * Decode quoted-printable encoding.
 */
function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, "") // Remove soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/**
 * Extract priority from subject line.
 * Supports formats like "[high]", "[urgent]", "[1-5]", etc.
 */
function extractPriority(subject: string): {
  priority?: number;
  cleanSubject: string;
} {
  const priorityMatch = subject.match(
    /^\[?(urgent|high|low|min|max|default|[1-5])\]?\s*/i,
  );

  if (priorityMatch) {
    const priorityStr = priorityMatch[1].toLowerCase();
    const priority = parsePriority(priorityStr);
    return {
      priority: priority !== 3 ? priority : undefined, // Only set if not default
      cleanSubject: subject.slice(priorityMatch[0].length),
    };
  }

  return { cleanSubject: subject };
}

/**
 * Convert a ReadableStream to text.
 */
async function streamToText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}
