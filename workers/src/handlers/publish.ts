import type { Context } from "hono";
import type { AppContext } from "../router";
import type {
  Message,
  InternalMessage,
  PublishRequest,
  Action,
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

// Parse priority from string (matches Go implementation)
function parsePriority(s: string): number {
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

  // Override/supplement with headers
  const headerTitle =
    c.req.header("X-Title") ||
    c.req.header("Title") ||
    c.req.header("t") ||
    c.req.header("ti");
  if (headerTitle) msg.title = headerTitle;

  const headerMessage =
    c.req.header("X-Message") || c.req.header("Message") || c.req.header("m");
  if (headerMessage) msg.message = headerMessage;

  const headerPriority =
    c.req.header("X-Priority") ||
    c.req.header("Priority") ||
    c.req.header("prio") ||
    c.req.header("p");
  if (headerPriority) msg.priority = parsePriority(headerPriority);

  const headerTags =
    c.req.header("X-Tags") ||
    c.req.header("Tags") ||
    c.req.header("tag") ||
    c.req.header("ta");
  if (headerTags)
    msg.tags = headerTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

  const headerClick = c.req.header("X-Click") || c.req.header("Click");
  if (headerClick) msg.click = headerClick;

  const headerIcon = c.req.header("X-Icon") || c.req.header("Icon");
  if (headerIcon) msg.icon = headerIcon;

  const headerActions = c.req.header("X-Actions") || c.req.header("Actions");
  if (headerActions) {
    try {
      msg.actions = JSON.parse(headerActions);
    } catch {
      // Ignore parse errors
    }
  }

  const headerMarkdown =
    c.req.header("X-Markdown") ||
    c.req.header("Markdown") ||
    c.req.header("md");
  if (
    headerMarkdown &&
    ["1", "true", "yes"].includes(headerMarkdown.toLowerCase())
  ) {
    msg.content_type = "text/markdown";
  }

  // Set sender IP
  msg.sender =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0] ||
    "";

  return msg;
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
  if (msg.content_type) external.content_type = msg.content_type;

  return external;
}

export async function handlePublish(
  c: Context<AppContext>,
  topic: string,
): Promise<Response> {
  // Parse message from request
  const msg = await parseMessage(c, topic);

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

  // Return the message
  return c.json(externalMsg);
}
