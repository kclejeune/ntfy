import type { Context } from 'hono';
import type { AppContext } from '../router';
import type { AccountCreateRequest, AccountTokenIssueRequest, AccountResponse, AccountTokenResponse } from '../types/user';
import { createUser, getUserByUsername, getUserById, getUserPasswordHash, usernameExists, createToken, getUserTokens, deleteToken, updateUserPassword } from '../database/users';
import { validateUsername, validatePassword, verifyPassword } from '../auth/password';
import { createUserToken } from '../auth/jwt';
import { extractAuth } from '../auth/middleware';

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

  // Create an initial token
  const token = await createToken(c.env.DB, user.id, 'default');

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

// GET /v1/account - Get account info
export async function handleAccountGet(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  // Get user's tokens
  const tokens = await getUserTokens(c.env.DB, auth.user.id);

  return c.json({
    username: auth.user.username,
    role: auth.user.role,
    sync_topic: auth.user.sync_topic,
    tier: {
      code: auth.user.tier,
      name: auth.user.tier === 'default' ? 'Free' : auth.user.tier,
    },
    tokens: tokens.map((t) => ({
      token: t.id,
      label: t.label,
      last_access: t.last_access,
      last_origin: t.last_origin,
      expires: t.expires,
    })),
  } as AccountResponse);
}

// POST /v1/account/token - Create new token
export async function handleAccountTokenCreate(c: Context<AppContext>): Promise<Response> {
  const auth = await extractAuth(c);

  if (auth.anonymous || !auth.user) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as AccountTokenIssueRequest;

  const token = await createToken(c.env.DB, auth.user.id, body.label || '', body.expires || 0);

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

  return c.json({ success: true });
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
