import type { Context } from "hono";
import type { AppContext } from "../router";
import { publishMessageInternal } from "./publish";

/**
 * UnifiedPush endpoint handler.
 * UnifiedPush is a protocol that allows Android apps to receive push notifications
 * through a distributor app (like ntfy) instead of Google's Firebase.
 *
 * Endpoints:
 * - POST /UP{base64url(topic)} - Receive push from app servers
 * - POST /{topic}?up=1 - Alternative format
 * - GET /.well-known/unifiedpush - Discovery endpoint
 */

/**
 * Handle UnifiedPush message delivery.
 * App servers POST to this endpoint to send notifications.
 */
export async function handleUnifiedPush(
  c: Context<AppContext>,
): Promise<Response> {
  const encodedTopic = c.req.param("topic");

  if (!encodedTopic) {
    return c.text("Missing topic", 400);
  }

  // Decode base64url topic
  let topic: string;
  try {
    // Convert base64url to base64
    const base64 = encodedTopic.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    topic = atob(padded);
  } catch {
    return c.text("Invalid topic encoding", 400);
  }

  // Validate topic format (alphanumeric, underscore, hyphen, 1-64 chars)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
    return c.text("Invalid topic", 400);
  }

  // Get raw body (UnifiedPush sends arbitrary content, typically JSON or base64)
  const body = await c.req.text();

  // Publish the message
  try {
    await publishMessageInternal(c.env, {
      topic,
      message: body,
      tags: ["unifiedpush"],
      sender:
        c.req.header("CF-Connecting-IP") ||
        c.req.header("X-Forwarded-For")?.split(",")[0] ||
        "",
    });

    // UnifiedPush spec expects 200 OK
    return c.text("", 200);
  } catch (err) {
    console.error("Failed to publish UnifiedPush message:", err);
    return c.text("Internal error", 500);
  }
}

/**
 * Handle UnifiedPush with ?up=1 query parameter.
 * This is an alternative format: POST /{topic}?up=1
 */
export async function handleUnifiedPushQuery(
  c: Context<AppContext>,
  topic: string,
): Promise<Response> {
  // Validate topic format
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
    return c.text("Invalid topic", 400);
  }

  // Get raw body
  const body = await c.req.text();

  // Publish the message
  try {
    await publishMessageInternal(c.env, {
      topic,
      message: body,
      tags: ["unifiedpush"],
      sender:
        c.req.header("CF-Connecting-IP") ||
        c.req.header("X-Forwarded-For")?.split(",")[0] ||
        "",
    });

    return c.text("", 200);
  } catch (err) {
    console.error("Failed to publish UnifiedPush message:", err);
    return c.text("Internal error", 500);
  }
}

/**
 * UnifiedPush discovery endpoint.
 * Some apps look for /.well-known/unifiedpush to discover capabilities.
 */
export async function handleUnifiedPushDiscovery(
  c: Context<AppContext>,
): Promise<Response> {
  return c.json({
    unifiedpush: {
      version: 1,
    },
  });
}

/**
 * Generate a UnifiedPush endpoint URL for a topic.
 * This can be used by apps to register for push notifications.
 */
export async function handleUnifiedPushRegister(
  c: Context<AppContext>,
): Promise<Response> {
  let body: { topic?: string };
  try {
    body = await c.req.json<{ topic?: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const topic = body.topic;

  if (!topic || !/^[a-zA-Z0-9_-]{1,64}$/.test(topic)) {
    return c.json({ error: "Invalid or missing topic" }, 400);
  }

  const baseUrl = c.env.NTFY_BASE_URL || new URL(c.req.url).origin;

  // Base64url encode the topic
  const encodedTopic = btoa(topic)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const endpoint = `${baseUrl}/UP${encodedTopic}`;

  return c.json({ endpoint });
}
