import type { Env } from "./types/env";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import type { AuthContext, Token, User, TokenRow, UserRow } from "./types/user";
import type { Attachment } from "./types/message";
import { publishMessageInternal, parsePriority } from "./handlers/publish";
import { checkTopicAccess } from "./auth/access";
import { storeAttachment } from "./storage/attachments";
import { generateMessageId } from "./types/message";

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

  // Read and parse email (body + attachments)
  let body = "";
  let attachment: Attachment | undefined;
  let attachmentWarning = "";

  try {
    const rawEmail = await streamToText(message.raw);
    const parsed = parseEmailContent(rawEmail);
    body = parsed.body;

    // If there's an attachment and R2 is configured, try to upload it
    // Attachment upload failures should not prevent the message from being delivered
    if (parsed.attachment && env.ATTACHMENTS) {
      try {
        const messageId = generateMessageId();
        const attachmentData = parsed.attachment;

        // Convert base64 data to binary
        const binaryData = base64ToUint8Array(attachmentData.data);

        // Create a stream for R2 upload
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(binaryData);
            controller.close();
          },
        });

        attachment = await storeAttachment(
          env,
          messageId,
          stream,
          attachmentData.filename,
          attachmentData.contentType,
          binaryData.byteLength,
        );
      } catch (attachErr) {
        // Log but don't fail the message - deliver without attachment
        console.error("Failed to process email attachment:", attachErr);
        const filename = parsed.attachment.filename || "unknown";
        attachmentWarning = `\n\n[Warning: Failed to process attachment "${filename}"]`;
      }
    } else if (parsed.attachment && !env.ATTACHMENTS) {
      // R2 not configured but email had an attachment
      const filename = parsed.attachment.filename || "unknown";
      attachmentWarning = `\n\n[Warning: Attachment "${filename}" not saved - attachments not enabled on this server]`;
    }
  } catch (err) {
    console.error("Failed to read email body:", err);
    body = "";
  }

  // Extract priority from subject (e.g., "[high]" or "[urgent]" prefix)
  const { priority, cleanSubject } = extractPriority(subject);

  // Redact any tokens that appear in plaintext (security measure)
  const safeSubject = redactTokens(cleanSubject);
  const safeBody = redactTokens(body);

  // Publish the message
  try {
    const messageBody = (safeBody || "(no content)") + attachmentWarning;
    await publishMessageInternal(env, {
      topic,
      title: safeSubject || undefined,
      message: messageBody,
      priority,
      tags: ["email"],
      sender: from,
      attachment,
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
 * Parsed email attachment data
 */
interface ParsedAttachment {
  filename: string;
  contentType: string;
  data: string; // Base64 encoded data
}

/**
 * Result of parsing email content
 */
interface ParsedEmailContent {
  body: string;
  attachment?: ParsedAttachment;
}

/**
 * Parse email content including body and attachments.
 * Returns the text body and the first attachment (if any).
 */
function parseEmailContent(raw: string): ParsedEmailContent {
  // Normalize line endings to \r\n
  const normalized = raw.replace(/\r?\n/g, "\r\n");

  // Find the boundary between headers and body (empty line)
  const headerBodySplit = normalized.indexOf("\r\n\r\n");
  if (headerBodySplit === -1) {
    return { body: normalized.trim() }; // No clear separation, return as-is
  }

  // Unfold headers (join continuation lines)
  const rawHeaders = normalized.slice(0, headerBodySplit);
  const headers = unfoldHeaders(rawHeaders);
  let bodySection = normalized.slice(headerBodySplit + 4);

  // Get full Content-Type header value
  const contentTypeHeader = getHeaderValue(headers, "Content-Type");

  let textBody = "";
  let attachment: ParsedAttachment | undefined;

  if (contentTypeHeader && contentTypeHeader.toLowerCase().includes("multipart/")) {
    // Extract boundary from Content-Type header
    const boundaryMatch = contentTypeHeader.match(/boundary=["']?([^"';\s]+)["']?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = bodySection.split(`--${boundary}`);

      for (const part of parts) {
        // Skip empty parts and closing boundary
        const trimmed = part.trim();
        if (!trimmed || trimmed === "--" || trimmed.startsWith("--")) continue;

        const partResult = parseMimePart(part);
        if (partResult) {
          if (partResult.type === "text" && !textBody) {
            textBody = partResult.content;
          } else if (partResult.type === "attachment" && !attachment) {
            attachment = {
              filename: partResult.filename || "attachment",
              contentType: partResult.contentType,
              data: partResult.content,
            };
          }
        }
      }
    }
  } else {
    // Single part - extract text body
    textBody = decodePartBody(bodySection, headers);
  }

  return { body: textBody.trim(), attachment };
}

/**
 * Unfold headers by joining continuation lines (lines starting with whitespace)
 */
function unfoldHeaders(headers: string): string {
  return headers.replace(/\r\n[ \t]+/g, " ");
}

/**
 * Get a header value by name (case-insensitive)
 */
function getHeaderValue(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+?)$`, "im");
  const match = headers.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Parse a single MIME part and determine its type
 * Recursively handles nested multipart structures
 */
function parseMimePart(
  part: string,
): {
  type: "text" | "attachment";
  content: string;
  contentType: string;
  filename?: string;
} | null {
  // Normalize and find headers/body split
  const normalized = part.replace(/\r?\n/g, "\r\n");

  // Find first blank line (headers end)
  const splitIndex = normalized.indexOf("\r\n\r\n");
  if (splitIndex === -1) {
    // No headers, might be plain text content
    return {
      type: "text",
      content: normalized.trim(),
      contentType: "text/plain",
    };
  }

  const rawHeaders = normalized.slice(0, splitIndex);
  const headers = unfoldHeaders(rawHeaders);
  let partBody = normalized.slice(splitIndex + 4);

  // Get content type (full header value)
  const contentTypeHeader = getHeaderValue(headers, "Content-Type") || "";
  const partContentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

  // Get content disposition
  const dispositionHeader = getHeaderValue(headers, "Content-Disposition") || "";
  const disposition = dispositionHeader.split(";")[0].trim().toLowerCase();

  // Get filename from Content-Disposition or Content-Type
  let filename: string | undefined;
  const filenameMatch =
    dispositionHeader.match(/filename=["']?([^"';\r\n]+)["']?/i) ||
    contentTypeHeader.match(/name=["']?([^"';\r\n]+)["']?/i);
  if (filenameMatch) {
    filename = filenameMatch[1].trim();
  }

  // Get content transfer encoding
  const encoding = (getHeaderValue(headers, "Content-Transfer-Encoding") || "").toLowerCase();

  // Handle nested multipart (e.g., multipart/alternative inside multipart/mixed)
  if (partContentType.startsWith("multipart/")) {
    const boundaryMatch = contentTypeHeader.match(/boundary=["']?([^"';\s]+)["']?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const subParts = partBody.split(`--${boundary}`);

      // Look for text/plain in nested parts
      for (const subPart of subParts) {
        const trimmed = subPart.trim();
        if (!trimmed || trimmed === "--" || trimmed.startsWith("--")) continue;

        const subResult = parseMimePart(subPart);
        if (subResult && subResult.type === "text") {
          return subResult;
        }
      }
    }
    return null;
  }

  // Determine if this is an attachment or text
  const isAttachment =
    disposition === "attachment" ||
    (filename && disposition !== "inline") ||
    (!partContentType.startsWith("text/") &&
      partContentType !== "" &&
      filename);

  if (isAttachment && filename) {
    // This is an attachment - keep as base64 or convert to base64
    let base64Data: string;
    if (encoding === "base64") {
      base64Data = partBody.replace(/\s/g, "");
    } else if (encoding === "quoted-printable") {
      // Decode QP then re-encode as base64
      const decoded = decodeQuotedPrintable(partBody);
      base64Data = btoa(decoded);
    } else {
      // Raw binary or 7bit/8bit - encode as base64
      try {
        base64Data = btoa(partBody);
      } catch {
        // If btoa fails (non-ASCII), treat as UTF-8 and encode
        base64Data = btoa(unescape(encodeURIComponent(partBody)));
      }
    }

    return {
      type: "attachment",
      content: base64Data,
      contentType: partContentType || "application/octet-stream",
      filename,
    };
  } else if (partContentType.startsWith("text/plain") || !partContentType) {
    // This is text content
    let textContent = partBody;

    if (encoding === "quoted-printable") {
      textContent = decodeQuotedPrintable(partBody);
    } else if (encoding === "base64") {
      try {
        textContent = atob(partBody.replace(/\s/g, ""));
      } catch {
        // Keep as-is if decode fails
      }
    }

    return {
      type: "text",
      content: textContent.trim(),
      contentType: partContentType || "text/plain",
    };
  }

  return null;
}

/**
 * Decode a MIME part body based on its transfer encoding
 */
function decodePartBody(body: string, headers: string): string {
  const encoding = (getHeaderValue(headers, "Content-Transfer-Encoding") || "").toLowerCase();

  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body);
  } else if (encoding === "base64") {
    try {
      return atob(body.replace(/\s/g, ""));
    } catch {
      return body;
    }
  }

  return body;
}

/**
 * Convert base64 string to Uint8Array
 * Handles common base64 issues like padding and invalid characters
 */
function base64ToUint8Array(base64: string): Uint8Array {
  // Clean the base64 string: remove whitespace and any trailing garbage
  let cleaned = base64.replace(/\s/g, "");

  // Remove any non-base64 characters that might have snuck in
  cleaned = cleaned.replace(/[^A-Za-z0-9+/=]/g, "");

  // Fix padding if needed
  const padLength = (4 - (cleaned.length % 4)) % 4;
  cleaned += "=".repeat(padLength);

  try {
    const binaryString = atob(cleaned);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (err) {
    console.error("Base64 decode failed, attempting recovery:", err);
    // If still failing, try truncating to valid length
    const validLength = Math.floor(cleaned.length / 4) * 4;
    const truncated = cleaned.slice(0, validLength);
    const binaryString = atob(truncated);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }
}

/**
 * Redact tokens (tk_*) from text to prevent accidental exposure.
 * Replaces the token value with asterisks while keeping the tk_ prefix visible
 * and preserving the original token length.
 * Also handles URL-encoded tokens (e.g., in mailto: links).
 */
function redactTokens(text: string): string {
  // First, URL-decode the text to catch encoded tokens
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // If decoding fails (malformed %), just use original
    decoded = text;
  }

  // Match token pattern: tk_ followed by alphanumeric characters
  // Replace with tk_ followed by asterisks matching the original length
  return decoded.replace(/\btk_([A-Za-z0-9]+)\b/g, (_, tokenValue) => {
    return "tk_" + "*".repeat(tokenValue.length);
  });
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
