import type { Context } from "hono";
import type { AppContext } from "../router";
import { extractAuth } from "../auth/middleware";
import { isWebPushEnabled } from "../push/webpush";

// Supports both nested keys (standard) and flat structure (ntfy frontend)
interface SubscriptionRequest {
  endpoint: string;
  // Nested format (standard Web Push)
  keys?: {
    p256dh: string;
    auth: string;
  };
  // Flat format (ntfy frontend)
  p256dh?: string;
  auth?: string;
  topics?: string[];
}

interface UpdateTopicsRequest {
  endpoint: string;
  topics: string[];
}

/**
 * GET /v1/webpush/key - Get VAPID public key for client subscription
 */
export async function handleGetVapidKey(
  c: Context<AppContext>,
): Promise<Response> {
  if (!c.env.VAPID_PUBLIC_KEY) {
    return c.json(
      { code: 50001, error: "Web Push not configured on this server" },
      501,
    );
  }

  return c.json({ key: c.env.VAPID_PUBLIC_KEY });
}

/**
 * POST /v1/webpush - Register a new push subscription
 */
export async function handleSubscriptionCreate(
  c: Context<AppContext>,
): Promise<Response> {
  if (!isWebPushEnabled(c.env)) {
    return c.json(
      { code: 50001, error: "Web Push not configured on this server" },
      501,
    );
  }

  let body: SubscriptionRequest;
  try {
    body = await c.req.json<SubscriptionRequest>();
  } catch {
    return c.json({ code: 40001, error: "Invalid JSON body" }, 400);
  }

  // Support both nested keys format and flat format
  const p256dh = body.keys?.p256dh || body.p256dh;
  const authKey = body.keys?.auth || body.auth;

  if (!body.endpoint || !p256dh || !authKey) {
    return c.json(
      { code: 40001, error: "Missing required fields: endpoint, p256dh, auth" },
      400,
    );
  }

  // Validate endpoint is a valid URL
  try {
    new URL(body.endpoint);
  } catch {
    return c.json({ code: 40001, error: "Invalid endpoint URL" }, 400);
  }

  // Get user ID if authenticated
  const auth = await extractAuth(c);
  const userId = auth.user?.id || null;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const topics = JSON.stringify(body.topics || []);

  try {
    // Use INSERT OR REPLACE to update existing subscription with same endpoint
    await c.env.DB.prepare(
      `INSERT INTO web_push_subscriptions
       (id, user_id, endpoint, key_p256dh, key_auth, topics, created, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         key_p256dh = excluded.key_p256dh,
         key_auth = excluded.key_auth,
         topics = excluded.topics`,
    )
      .bind(id, userId, body.endpoint, p256dh, authKey, topics, now)
      .run();

    return c.json({ id, success: true });
  } catch (err) {
    console.error("Failed to create web push subscription:", err);
    return c.json({ code: 50000, error: "Failed to create subscription" }, 500);
  }
}

/**
 * PATCH /v1/webpush - Update subscription topics
 */
export async function handleSubscriptionUpdate(
  c: Context<AppContext>,
): Promise<Response> {
  if (!isWebPushEnabled(c.env)) {
    return c.json(
      { code: 50001, error: "Web Push not configured on this server" },
      501,
    );
  }

  let body: UpdateTopicsRequest;
  try {
    body = await c.req.json<UpdateTopicsRequest>();
  } catch {
    return c.json({ code: 40001, error: "Invalid JSON body" }, 400);
  }

  if (!body.endpoint || !Array.isArray(body.topics)) {
    return c.json(
      { code: 40001, error: "Missing required fields: endpoint, topics" },
      400,
    );
  }

  const topics = JSON.stringify(body.topics);

  try {
    const result = await c.env.DB.prepare(
      `UPDATE web_push_subscriptions SET topics = ? WHERE endpoint = ?`,
    )
      .bind(topics, body.endpoint)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ code: 40401, error: "Subscription not found" }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to update web push subscription:", err);
    return c.json({ code: 50000, error: "Failed to update subscription" }, 500);
  }
}

/**
 * DELETE /v1/webpush - Unregister a push subscription
 */
export async function handleSubscriptionDelete(
  c: Context<AppContext>,
): Promise<Response> {
  let body: { endpoint: string };
  try {
    body = await c.req.json<{ endpoint: string }>();
  } catch {
    return c.json({ code: 40001, error: "Invalid JSON body" }, 400);
  }

  if (!body.endpoint) {
    return c.json({ code: 40001, error: "Missing required field: endpoint" }, 400);
  }

  try {
    await c.env.DB.prepare(
      "DELETE FROM web_push_subscriptions WHERE endpoint = ?",
    )
      .bind(body.endpoint)
      .run();

    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to delete web push subscription:", err);
    return c.json({ code: 50000, error: "Failed to delete subscription" }, 500);
  }
}

/**
 * GET /v1/webpush - Get subscription info (for debugging/testing)
 */
export async function handleSubscriptionGet(
  c: Context<AppContext>,
): Promise<Response> {
  const endpoint = c.req.query("endpoint");

  if (!endpoint) {
    return c.json(
      { code: 40001, error: "Missing query parameter: endpoint" },
      400,
    );
  }

  try {
    const result = await c.env.DB.prepare(
      `SELECT id, endpoint, topics, created, last_success, failure_count
       FROM web_push_subscriptions WHERE endpoint = ?`,
    )
      .bind(endpoint)
      .first<{
        id: string;
        endpoint: string;
        topics: string;
        created: number;
        last_success: number | null;
        failure_count: number;
      }>();

    if (!result) {
      return c.json({ code: 40401, error: "Subscription not found" }, 404);
    }

    return c.json({
      id: result.id,
      endpoint: result.endpoint,
      topics: JSON.parse(result.topics),
      created: result.created,
      lastSuccess: result.last_success,
      failureCount: result.failure_count,
    });
  } catch (err) {
    console.error("Failed to get web push subscription:", err);
    return c.json({ code: 50000, error: "Failed to get subscription" }, 500);
  }
}
