import type { Context } from 'hono';
import type { AppContext } from '../router';
import type { AccountCreateRequest, AccountTokenIssueRequest, AccountResponse, AccountTokenResponse } from '../types/user';
import { createUser, getUserByUsername, getUserById, getUserPasswordHash, usernameExists, createToken, getUserTokens, deleteToken, updateTokenLabel, updateUserPassword } from '../database/users';
import { validateUsername, validatePassword, verifyPassword } from '../auth/password';
import { createUserToken } from '../auth/jwt';
import { extractAuth } from '../auth/middleware';
import { publishSyncEventAsync } from '../sync/notify';

// Token expiry duration in seconds (72 hours, matches original ntfy)
const TOKEN_EXPIRY_SECONDS = 72 * 60 * 60;

// POST /v1/account - Create account
export async function handleAccountCreate(c: Context<AppContext>): Promise<Response> {
  const body = (await c.req.json()) as AccountCreateRequest;

  // Validate username
  const usernameValidation = validateUsername(body.username);
  if (!usernameValidation.valid) {
    return c.json({ code: 40001, error: usernameValidation.error }, 400);
  }

  // Validate password
  const passwordValidation = validatePassword(body.password);
  if (!passwordValidation.valid) {
    return c.json({ code: 40002, error: passwordValidation.error }, 400);
  }

  // Check if username already exists
  if (await usernameExists(c.env.DB, body.username)) {
    return c.json({ code: 40901, error: 'Username already exists' }, 409);
  }

  // Create the user
  const user = await createUser(c.env.DB, body.username, body.password);

  // Create an initial token with 72-hour expiry
  const token = await createToken(c.env.DB, user.id, 'default', TOKEN_EXPIRY_SECONDS);

  return c.json({
    username: user.username,
    role: user.role,
    sync_topic: user.sync_topic,
    tokens: [
      {
        token: token.id,
        label: token.label,
        last_access: token.last_access,
        expires: token.expires,
      },
    ],
  } as AccountResponse);
}

// Default limits for free tier
const DEFAULT_LIMITS = {
  basis: 'tier',
  messages: 0, // unlimited
  messages_expiry_duration: 43200, // 12 hours
  emails: 0,
  calls: 0,
  reservations: 3,
  attachment_total_size: 0,
  attachment_file_size: 0,
  attachment_expiry_duration: 0,
  attachment_bandwidth: 0,
};

// Default stats
const DEFAULT_STATS = {
  messages: 0,
  messages_remaining: 0,
  emails: 0,
  emails_remaining: 0,
  calls: 0,
  calls_remaining: 0,
  reservations: 0,
  reservations_remaining: 3,
  attachment_total_size: 0,
  attachment_total_size_remaining: 0,
};

// GET /v1/account - Get account info
export async function handleAccountGet(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  // Get user's tokens
  const tokens = await getUserTokens(c.env.DB, auth.user.id);

  // Get user's subscriptions
  const subscriptionsResult = await c.env.DB.prepare(
    'SELECT base_url, topic, display_name FROM subscriptions WHERE user_id = ?'
  )
    .bind(auth.user.id)
    .all<{ base_url: string; topic: string; display_name: string }>();
  const subscriptions = (subscriptionsResult.results || []).map((s) => ({
    base_url: s.base_url,
    topic: s.topic,
    display_name: s.display_name || undefined,
  }));

  // Get user's reservations
  const reservationsResult = await c.env.DB.prepare(
    'SELECT topic, everyone_read, everyone_write FROM reservations WHERE user_id = ?'
  )
    .bind(auth.user.id)
    .all<{ topic: string; everyone_read: number; everyone_write: number }>();
  const reservations = (reservationsResult.results || []).map((r) => {
    let everyone = 'deny-all';
    if (r.everyone_read && r.everyone_write) everyone = 'read-write';
    else if (r.everyone_read) everyone = 'read-only';
    else if (r.everyone_write) everyone = 'write-only';
    return { topic: r.topic, everyone };
  });

  return c.json({
    username: auth.user.username,
    role: auth.user.role,
    sync_topic: auth.user.sync_topic,
    tier: {
      code: auth.user.tier,
      name: auth.user.tier === 'default' ? 'Free' : auth.user.tier,
    },
    limits: DEFAULT_LIMITS,
    stats: {
      ...DEFAULT_STATS,
      reservations: reservations.length,
      reservations_remaining: DEFAULT_LIMITS.reservations - reservations.length,
    },
    tokens: tokens.map((t) => ({
      token: t.id,
      label: t.label,
      last_access: t.last_access,
      last_origin: t.last_origin,
      expires: t.expires,
    })),
    subscriptions,
    reservations,
  });
}

// POST /v1/account/token - Create new token
export async function handleAccountTokenCreate(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as AccountTokenIssueRequest;

  // Use provided expiry or default to 72 hours
  const expiresIn = body.expires || TOKEN_EXPIRY_SECONDS;
  const token = await createToken(c.env.DB, auth.user.id, body.label || '', expiresIn);

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({
    token: token.id,
    label: token.label,
    last_access: token.last_access,
    expires: token.expires,
  } as AccountTokenResponse);
}

// DELETE /v1/account/token/:token - Delete a token
export async function handleAccountTokenDelete(c: Context<AppContext>, tokenId: string): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const deleted = await deleteToken(c.env.DB, tokenId, auth.user.id);

  if (!deleted) {
    return c.json({ code: 40401, error: 'Token not found' }, 404);
  }

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({ success: true });
}

// PATCH /v1/account/token - Update a token (rename/extend)
// If no body is provided, extends the token used for authentication by 72 hours
// If body contains {token, label, expires}, updates that specific token
export async function handleAccountTokenUpdate(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  // Must be authenticated with a token (not basic auth)
  if (!auth.token) {
    return c.json({ code: 40001, error: 'Bearer token authentication required' }, 400);
  }

  // Try to parse body, default to empty object
  let body: { token?: string; label?: string; expires?: number } = {};
  try {
    const text = await c.req.text();
    if (text && text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return c.json({ code: 40001, error: 'Invalid JSON body' }, 400);
  }

  // If no token in body, use the token from auth (update current token)
  const tokenId = body.token || auth.token.id;

  // If expires provided (including 0 for never), use it; otherwise extend by 72 hours
  const now = Math.floor(Date.now() / 1000);
  const expires = body.expires !== undefined ? body.expires : now + TOKEN_EXPIRY_SECONDS;

  const updated = await updateTokenLabel(c.env.DB, tokenId, auth.user.id, body.label ?? auth.token.label, expires);

  if (!updated) {
    return c.json({ code: 40401, error: 'Token not found' }, 404);
  }

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({
    token: updated.id,
    label: updated.label,
    last_access: updated.last_access,
    expires: updated.expires,
  } as AccountTokenResponse);
}

// POST /v1/account/password - Change password
export async function handleAccountPasswordChange(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const body = (await c.req.json()) as { password: string; new_password: string };

  // Validate new password
  const passwordValidation = validatePassword(body.new_password);
  if (!passwordValidation.valid) {
    return c.json({ code: 40002, error: passwordValidation.error }, 400);
  }

  // Verify current password
  const currentHash = await getUserPasswordHash(c.env.DB, auth.user.id);
  if (!currentHash) {
    return c.json({ code: 50001, error: 'Internal error' }, 500);
  }

  const valid = await verifyPassword(body.password, currentHash);
  if (!valid) {
    return c.json({ code: 40101, error: 'Invalid password' }, 401);
  }

  // Update password
  await updateUserPassword(c.env.DB, auth.user.id, body.new_password);

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({ success: true });
}

// DELETE /v1/account - Delete account
export async function handleAccountDelete(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const body = (await c.req.json()) as { password: string };

  // Verify password
  const currentHash = await getUserPasswordHash(c.env.DB, auth.user.id);
  if (!currentHash) {
    return c.json({ code: 50001, error: 'Internal error' }, 500);
  }

  const valid = await verifyPassword(body.password, currentHash);
  if (!valid) {
    return c.json({ code: 40101, error: 'Invalid password' }, 401);
  }

  // Delete user (cascades to tokens and access)
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(auth.user.id).run();

  return c.json({ success: true });
}

// POST /auth - Login and get token (for ntfy compatibility)
export async function handleAuth(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  // Return success if already authenticated
  return c.json({ success: true });
}

// ==================== Subscription endpoints ====================

interface SubscriptionRequest {
  base_url: string;
  topic: string;
  display_name?: string;
}

// POST /v1/account/subscription - Add subscription (sync across devices)
export async function handleAccountSubscriptionAdd(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  let body: SubscriptionRequest;
  try {
    body = (await c.req.json()) as SubscriptionRequest;
  } catch {
    return c.json({ code: 40001, error: 'Invalid JSON body' }, 400);
  }

  if (!body.base_url || !body.topic) {
    return c.json({ code: 40001, error: 'base_url and topic are required' }, 400);
  }

  try {
    await c.env.DB.prepare(
      'INSERT INTO subscriptions (user_id, base_url, topic, display_name) VALUES (?, ?, ?, ?)'
    )
      .bind(auth.user.id, body.base_url, body.topic, body.display_name || '')
      .run();
  } catch (e: unknown) {
    // Check for unique constraint violation
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return c.json({ code: 40901, error: 'Subscription already exists' }, 409);
    }
    throw e;
  }

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({
    base_url: body.base_url,
    topic: body.topic,
    display_name: body.display_name || '',
  });
}

// GET /v1/account/subscription - Get all subscriptions
export async function handleAccountSubscriptionList(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const result = await c.env.DB.prepare(
    'SELECT base_url, topic, display_name FROM subscriptions WHERE user_id = ?'
  )
    .bind(auth.user.id)
    .all<{ base_url: string; topic: string; display_name: string }>();

  return c.json(result.results || []);
}

// DELETE /v1/account/subscription - Delete subscription
// Supports both JSON body and headers (X-BaseUrl, X-Topic) for compatibility with web UI
export async function handleAccountSubscriptionDelete(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  let baseUrl: string | undefined;
  let topic: string | undefined;

  // Try headers first (web UI sends these for DELETE requests)
  const headerBaseUrl = c.req.header('X-BaseUrl');
  const headerTopic = c.req.header('X-Topic');

  if (headerBaseUrl && headerTopic) {
    baseUrl = headerBaseUrl;
    topic = headerTopic;
  } else {
    // Fall back to JSON body
    try {
      const body = (await c.req.json()) as { base_url: string; topic: string };
      baseUrl = body.base_url;
      topic = body.topic;
    } catch {
      // No valid JSON body
    }
  }

  if (!baseUrl || !topic) {
    return c.json({ code: 40001, error: 'base_url and topic are required (via headers or JSON body)' }, 400);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM subscriptions WHERE user_id = ? AND base_url = ? AND topic = ?'
  )
    .bind(auth.user.id, baseUrl, topic)
    .run();

  if ((result.meta.changes || 0) === 0) {
    return c.json({ code: 40401, error: 'Subscription not found' }, 404);
  }

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({ success: true });
}

// ==================== Reservation endpoints ====================

interface ReservationRequest {
  topic: string;
  everyone?: string; // "read-write", "read-only", "write-only", "deny-all"
}

// POST /v1/account/reservation - Reserve a topic
export async function handleAccountReservationAdd(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  let body: ReservationRequest;
  try {
    body = (await c.req.json()) as ReservationRequest;
  } catch {
    return c.json({ code: 40001, error: 'Invalid JSON body' }, 400);
  }

  if (!body.topic) {
    return c.json({ code: 40001, error: 'topic is required' }, 400);
  }

  // Validate topic format
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(body.topic)) {
    return c.json({ code: 40001, error: 'Invalid topic format' }, 400);
  }

  // Parse permissions
  let everyoneRead = 0;
  let everyoneWrite = 0;
  switch (body.everyone) {
    case 'read-write':
      everyoneRead = 1;
      everyoneWrite = 1;
      break;
    case 'read-only':
      everyoneRead = 1;
      break;
    case 'write-only':
      everyoneWrite = 1;
      break;
    case 'deny-all':
    default:
      // Both stay 0
      break;
  }

  // Check if already reserved
  const existing = await c.env.DB.prepare('SELECT user_id FROM reservations WHERE topic = ?')
    .bind(body.topic)
    .first<{ user_id: string }>();

  if (existing) {
    if (existing.user_id === auth.user.id) {
      // Update existing reservation
      await c.env.DB.prepare(
        'UPDATE reservations SET everyone_read = ?, everyone_write = ? WHERE topic = ?'
      )
        .bind(everyoneRead, everyoneWrite, body.topic)
        .run();
    } else {
      return c.json({ code: 40901, error: 'Topic already reserved by another user' }, 409);
    }
  } else {
    // Create new reservation
    await c.env.DB.prepare(
      'INSERT INTO reservations (topic, user_id, everyone_read, everyone_write) VALUES (?, ?, ?, ?)'
    )
      .bind(body.topic, auth.user.id, everyoneRead, everyoneWrite)
      .run();

    // Grant owner full access
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO user_access (user_id, topic, read, write, owner_user_id) VALUES (?, ?, 1, 1, ?)'
    )
      .bind(auth.user.id, body.topic, auth.user.id)
      .run();
  }

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({
    topic: body.topic,
    everyone: body.everyone || 'deny-all',
  });
}

// GET /v1/account/reservation - Get all reservations
export async function handleAccountReservationList(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const result = await c.env.DB.prepare(
    'SELECT topic, everyone_read, everyone_write FROM reservations WHERE user_id = ?'
  )
    .bind(auth.user.id)
    .all<{ topic: string; everyone_read: number; everyone_write: number }>();

  const reservations = (result.results || []).map((r) => {
    let everyone = 'deny-all';
    if (r.everyone_read && r.everyone_write) everyone = 'read-write';
    else if (r.everyone_read) everyone = 'read-only';
    else if (r.everyone_write) everyone = 'write-only';

    return { topic: r.topic, everyone };
  });

  return c.json(reservations);
}

// DELETE /v1/account/reservation/:topic - Delete reservation
export async function handleAccountReservationDelete(c: Context<AppContext>, topic: string): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const result = await c.env.DB.prepare(
    'DELETE FROM reservations WHERE topic = ? AND user_id = ?'
  )
    .bind(topic, auth.user.id)
    .run();

  if ((result.meta.changes || 0) === 0) {
    return c.json({ code: 40401, error: 'Reservation not found' }, 404);
  }

  // Also remove owner access
  await c.env.DB.prepare('DELETE FROM user_access WHERE topic = ? AND owner_user_id = ?')
    .bind(topic, auth.user.id)
    .run();

  // Notify other clients
  publishSyncEventAsync(c.executionCtx, c.env, auth.user);

  return c.json({ success: true });
}
