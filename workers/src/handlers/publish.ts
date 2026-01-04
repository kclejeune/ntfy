import type { Context } from "hono";
import type { AppContext } from "../router";
import type {
  Message,
  InternalMessage,
  PublishRequest,
  Action,
  Attachment,
} from "../types/message";
import {
  generateMessageId,
  PRIORITY_DEFAULT,
  PRIORITY_MIN,
  PRIORITY_MAX,
  EVENT_MESSAGE,
} from "../types/message";
import { insertMessage } from "../database/messages";
import { forwardPollRequest } from "../push/upstream";
import {
  storeAttachment,
  getFilenameFromUrl,
  isBinaryContent,
} from "../storage/attachments";
import { broadcastWebPush } from "../push/webpush";

// Parse priority from string (matches Go implementation)
export function parsePriority(s: string): number {
  const lower = s.toLowerCase();
  switch (lower) {
    case "max":
    case "urgent":
    case "5":
      return 5;
    case "high":
    case "4":
      return 4;
    case "default":
    case "3":
      return 3;
    case "low":
    case "2":
      return 2;
    case "min":
    case "1":
      return 1;
    default:
      const num = parseInt(s, 10);
      if (!isNaN(num) && num >= PRIORITY_MIN && num <= PRIORITY_MAX) {
        return num;
      }
      return PRIORITY_DEFAULT;
  }
}

// Parse message from request (body + headers)
async function parseMessage(
  c: Context<AppContext>,
  topic: string,
): Promise<InternalMessage> {
  const contentType = c.req.header("Content-Type") || "";
  const now = Math.floor(Date.now() / 1000);

  let msg: InternalMessage = {
    id: generateMessageId(),
    time: now,
    event: EVENT_MESSAGE,
    topic,
  };

  // Check if body was already parsed and stored in context (for POST/PUT to /)
  // This takes priority regardless of Content-Type since it's already parsed
  const cachedBody = c.get("parsedBody") as PublishRequest | undefined;
  if (cachedBody) {
    if (cachedBody.topic) msg.topic = cachedBody.topic;
    if (cachedBody.message) msg.message = cachedBody.message;
    if (cachedBody.title) msg.title = cachedBody.title;
    if (cachedBody.priority) msg.priority = cachedBody.priority;
    if (cachedBody.tags) msg.tags = cachedBody.tags;
    if (cachedBody.click) msg.click = cachedBody.click;
    if (cachedBody.icon) msg.icon = cachedBody.icon;
    if (cachedBody.actions) msg.actions = cachedBody.actions as Action[];
    if (cachedBody.markdown) msg.content_type = "text/markdown";
  } else if (contentType.includes("application/json")) {
    // Parse from JSON body if Content-Type indicates JSON
    try {
      const body = (await c.req.json()) as PublishRequest;

      if (body.topic) msg.topic = body.topic;
      if (body.message) msg.message = body.message;
      if (body.title) msg.title = body.title;
      if (body.priority) msg.priority = body.priority;
      if (body.tags) msg.tags = body.tags;
      if (body.click) msg.click = body.click;
      if (body.icon) msg.icon = body.icon;
      if (body.actions) msg.actions = body.actions as Action[];
      if (body.markdown) msg.content_type = "text/markdown";
    } catch {
      // Fall through to text body
    }
  }

  // If no message from JSON, try text body
  if (!msg.message && !cachedBody) {
    try {
      const text = await c.req.text();
      if (text) msg.message = text;
    } catch {
      // Ignore
    }
  }

  // Override/supplement with headers AND query params
  const url = new URL(c.req.url);

  const title =
    c.req.header("X-Title") ||
    c.req.header("Title") ||
    c.req.header("t") ||
    c.req.header("ti") ||
    url.searchParams.get("title") ||
    url.searchParams.get("t");
  if (title) msg.title = title;

  const message =
    c.req.header("X-Message") ||
    c.req.header("Message") ||
    c.req.header("m") ||
    url.searchParams.get("message") ||
    url.searchParams.get("m");
  if (message) msg.message = message;

  const priority =
    c.req.header("X-Priority") ||
    c.req.header("Priority") ||
    c.req.header("prio") ||
    c.req.header("p") ||
    url.searchParams.get("priority") ||
    url.searchParams.get("prio") ||
    url.searchParams.get("p");
  if (priority) msg.priority = parsePriority(priority);

  const tags =
    c.req.header("X-Tags") ||
    c.req.header("Tags") ||
    c.req.header("tag") ||
    c.req.header("ta") ||
    url.searchParams.get("tags") ||
    url.searchParams.get("tag") ||
    url.searchParams.get("ta");
  if (tags)
    msg.tags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

  const click =
    c.req.header("X-Click") ||
    c.req.header("Click") ||
    url.searchParams.get("click");
  if (click) msg.click = click;

  const icon =
    c.req.header("X-Icon") ||
    c.req.header("Icon") ||
    url.searchParams.get("icon");
  if (icon) msg.icon = icon;

  const actions =
    c.req.header("X-Actions") ||
    c.req.header("Actions") ||
    url.searchParams.get("actions");
  if (actions) {
    try {
      msg.actions = JSON.parse(actions);
    } catch {
      // Ignore parse errors
    }
  }

  const markdown =
    c.req.header("X-Markdown") ||
    c.req.header("Markdown") ||
    c.req.header("md") ||
    url.searchParams.get("markdown") ||
    url.searchParams.get("md");
  if (markdown && ["1", "true", "yes"].includes(markdown.toLowerCase())) {
    msg.content_type = "text/markdown";
  }

  // Set sender IP
  msg.sender =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0] ||
    "";

  return msg;
}

// Get attach URL from headers or query params
function getAttachUrl(c: Context<AppContext>): string | null {
  const url = new URL(c.req.url);
  return (
    c.req.header("X-Attach") ||
    c.req.header("Attach") ||
    c.req.header("a") ||
    url.searchParams.get("attach") ||
    url.searchParams.get("a") ||
    null
  );
}

// Get filename from headers or query params
function getFilename(c: Context<AppContext>): string | null {
  const url = new URL(c.req.url);
  return (
    c.req.header("X-Filename") ||
    c.req.header("Filename") ||
    c.req.header("file") ||
    url.searchParams.get("filename") ||
    url.searchParams.get("file") ||
    null
  );
}

// Check if we should treat the request body as an attachment
function shouldTreatAsAttachment(c: Context<AppContext>): boolean {
  // Check for explicit attachment headers or query params
  const filename = getFilename(c);
  const attach = getAttachUrl(c);

  if (filename || attach) {
    return true;
  }

  // Check content type for binary
  const contentType = c.req.header("Content-Type") || "";
  if (isBinaryContent(contentType)) {
    return true;
  }

  return false;
}

// Parse external URL attachment (X-Attach header or ?attach= query param)
function parseExternalAttachment(c: Context<AppContext>): Attachment | null {
  const attach = getAttachUrl(c);

  if (!attach) {
    return null;
  }

  // Validate it's a URL
  try {
    new URL(attach);
  } catch {
    return null;
  }

  const filename = getFilename(c) || getFilenameFromUrl(attach);

  return {
    name: filename,
    url: attach,
  };
}

// Convert internal message to external format
function toExternalMessage(msg: InternalMessage, expires: number): Message {
  const external: Message = {
    id: msg.id,
    time: msg.time,
    expires,
    event: msg.event,
    topic: msg.topic,
  };

  if (msg.title) external.title = msg.title;
  if (msg.message) external.message = msg.message;
  if (msg.priority && msg.priority !== PRIORITY_DEFAULT)
    external.priority = msg.priority;
  if (msg.tags && msg.tags.length > 0) external.tags = msg.tags;
  if (msg.click) external.click = msg.click;
  if (msg.icon) external.icon = msg.icon;
  if (msg.actions && msg.actions.length > 0) external.actions = msg.actions;
  if (msg.attachment) external.attachment = msg.attachment;
  if (msg.content_type) external.content_type = msg.content_type;

  return external;
}

export async function handlePublish(
  c: Context<AppContext>,
  topic: string,
): Promise<Response> {
  // Check if this is an attachment upload
  const isAttachment = shouldTreatAsAttachment(c);

  // For attachments, we need to handle the body before parseMessage consumes it
  let attachment: Attachment | undefined;

  if (isAttachment) {
    // Check for external URL attachment first
    const externalAttachment = parseExternalAttachment(c);
    if (externalAttachment) {
      attachment = externalAttachment;
    } else if (c.env.ATTACHMENTS) {
      // Upload body as attachment to R2 using streaming
      const filename = getFilename(c) || "attachment";
      const contentType =
        c.req.header("Content-Type") || "application/octet-stream";

      // Get Content-Length for early size check (if available)
      const contentLengthHeader = c.req.header("Content-Length");
      const contentLength = contentLengthHeader
        ? parseInt(contentLengthHeader, 10)
        : undefined;

      // Generate message ID early for attachment storage
      const messageId = generateMessageId();

      try {
        // Get the raw body stream - no buffering
        const bodyStream = c.req.raw.body;
        if (!bodyStream) {
          return c.json({ code: 40001, error: "No body provided" }, 400);
        }

        // Stream directly to R2
        attachment = await storeAttachment(
          c.env,
          messageId,
          bodyStream,
          filename,
          contentType,
          contentLength,
        );

        // Create message manually since we consumed the body
        const now = Math.floor(Date.now() / 1000);
        const reqUrl = new URL(c.req.url);
        const msg: InternalMessage = {
          id: messageId,
          time: now,
          event: EVENT_MESSAGE,
          topic,
          attachment,
          message: `You received a file: ${filename}`,
          sender:
            c.req.header("CF-Connecting-IP") ||
            c.req.header("X-Forwarded-For")?.split(",")[0] ||
            "",
        };

        // Apply headers/query params for title, priority, tags, etc.
        const msgTitle =
          c.req.header("X-Title") ||
          c.req.header("Title") ||
          c.req.header("t") ||
          c.req.header("ti") ||
          reqUrl.searchParams.get("title") ||
          reqUrl.searchParams.get("t");
        if (msgTitle) msg.title = msgTitle;

        const msgMessage =
          c.req.header("X-Message") ||
          c.req.header("Message") ||
          c.req.header("m") ||
          reqUrl.searchParams.get("message") ||
          reqUrl.searchParams.get("m");
        if (msgMessage) msg.message = msgMessage;

        const msgPriority =
          c.req.header("X-Priority") ||
          c.req.header("Priority") ||
          c.req.header("prio") ||
          c.req.header("p") ||
          reqUrl.searchParams.get("priority") ||
          reqUrl.searchParams.get("prio") ||
          reqUrl.searchParams.get("p");
        if (msgPriority) msg.priority = parsePriority(msgPriority);

        const msgTags =
          c.req.header("X-Tags") ||
          c.req.header("Tags") ||
          c.req.header("tag") ||
          c.req.header("ta") ||
          reqUrl.searchParams.get("tags") ||
          reqUrl.searchParams.get("tag") ||
          reqUrl.searchParams.get("ta");
        if (msgTags)
          msg.tags = msgTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);

        const msgClick =
          c.req.header("X-Click") ||
          c.req.header("Click") ||
          reqUrl.searchParams.get("click");
        if (msgClick) msg.click = msgClick;

        const msgIcon =
          c.req.header("X-Icon") ||
          c.req.header("Icon") ||
          reqUrl.searchParams.get("icon");
        if (msgIcon) msg.icon = msgIcon;

        // Calculate expiry time
        const defaultExpiry = parseInt(
          c.env.NTFY_CACHE_DURATION || "43200",
          10,
        );
        const expires = msg.time + defaultExpiry;
        msg.expires = expires;

        // Store in database
        await insertMessage(c.env.DB, msg, expires);

        // Broadcast to subscribers via Durable Object
        const doId = c.env.TOPIC_DO.idFromName(topic);
        const stub = c.env.TOPIC_DO.get(doId);

        const externalMsg = toExternalMessage(msg, expires);

        await stub.fetch(`https://internal/topic/${topic}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(externalMsg),
        });

        // Forward poll request to upstream for iOS push notifications (non-blocking)
        c.executionCtx.waitUntil(forwardPollRequest(c.env, externalMsg));

        // Send Web Push notifications (non-blocking)
        c.executionCtx.waitUntil(broadcastWebPush(c.env, externalMsg));

        // Return the message
        return c.json(externalMsg);
      } catch (err) {
        const error = err instanceof Error ? err.message : "Upload failed";
        return c.json({ code: 40001, error }, 400);
      }
    } else {
      // R2 not configured, reject attachment upload
      return c.json(
        { code: 40001, error: "Attachments not enabled on this server" },
        400,
      );
    }
  }

  // Parse message from request (non-attachment path)
  const msg = await parseMessage(c, topic);

  // Add external attachment if present
  if (attachment) {
    msg.attachment = attachment;
    if (!msg.message) {
      msg.message = `You received a file: ${attachment.name}`;
    }
  }

  // Calculate expiry time
  const defaultExpiry = parseInt(c.env.NTFY_CACHE_DURATION || "43200", 10);
  const expires = msg.time + defaultExpiry;
  msg.expires = expires;

  // Store in database
  await insertMessage(c.env.DB, msg, expires);

  // Broadcast to subscribers via Durable Object
  const doId = c.env.TOPIC_DO.idFromName(topic);
  const stub = c.env.TOPIC_DO.get(doId);

  const externalMsg = toExternalMessage(msg, expires);

  await stub.fetch(`https://internal/topic/${topic}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(externalMsg),
  });

  // Forward poll request to upstream for iOS push notifications (non-blocking)
  c.executionCtx.waitUntil(forwardPollRequest(c.env, externalMsg));

  // Send Web Push notifications (non-blocking)
  c.executionCtx.waitUntil(broadcastWebPush(c.env, externalMsg));

  // Return the message
  return c.json(externalMsg);
}

/**
 * Internal publish request for programmatic use (email, scheduled, etc.)
 */
export interface InternalPublishRequest {
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  sender?: string;
  click?: string;
  icon?: string;
}

/**
 * Publish a message internally (for email, scheduled, etc.)
 * Bypasses HTTP request parsing.
 */
export async function publishMessageInternal(
  env: {
    DB: D1Database;
    TOPIC_DO: DurableObjectNamespace;
    NTFY_CACHE_DURATION?: string;
    NTFY_BASE_URL?: string;
    NTFY_UPSTREAM_BASE_URL?: string;
    NTFY_UPSTREAM_ACCESS_TOKEN?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
  },
  request: InternalPublishRequest,
): Promise<Message> {
  const now = Math.floor(Date.now() / 1000);
  const defaultExpiry = parseInt(env.NTFY_CACHE_DURATION || "43200", 10);
  const expires = now + defaultExpiry;

  const msg: InternalMessage = {
    id: generateMessageId(),
    time: now,
    expires,
    event: EVENT_MESSAGE,
    topic: request.topic,
    title: request.title,
    message: request.message,
    priority: request.priority,
    tags: request.tags,
    click: request.click,
    icon: request.icon,
    sender: request.sender || "internal",
  };

  // Store in database
  await insertMessage(env.DB, msg, expires);

  // Broadcast to subscribers via Durable Object
  const doId = env.TOPIC_DO.idFromName(request.topic);
  const stub = env.TOPIC_DO.get(doId);

  const externalMsg: Message = {
    id: msg.id,
    time: msg.time,
    expires,
    event: msg.event,
    topic: msg.topic,
  };

  if (msg.title) externalMsg.title = msg.title;
  if (msg.message) externalMsg.message = msg.message;
  if (msg.priority && msg.priority !== PRIORITY_DEFAULT)
    externalMsg.priority = msg.priority;
  if (msg.tags && msg.tags.length > 0) externalMsg.tags = msg.tags;
  if (msg.click) externalMsg.click = msg.click;
  if (msg.icon) externalMsg.icon = msg.icon;

  await stub.fetch(`https://internal/topic/${request.topic}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(externalMsg),
  });

  // Forward to upstream for iOS push (non-blocking)
  forwardPollRequest(env, externalMsg).catch((err) =>
    console.error("Failed to forward poll request:", err),
  );

  // Send Web Push notifications (non-blocking)
  broadcastWebPush(env, externalMsg).catch((err) =>
    console.error("Failed to broadcast web push:", err),
  );

  return externalMsg;
}
