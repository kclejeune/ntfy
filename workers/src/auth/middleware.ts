import type { Context, Next } from 'hono';
import type { AppContext } from '../router';
import type { AuthContext, User, Token, UserRow, TokenRow } from '../types/user';
import { verifyJWT } from './jwt';
import { verifyPassword } from './password';

// Extract auth context from request
// Supports:
// - Authorization header (Bearer token or Basic auth)
// - Query parameter: ?auth=<base64> (base64-encoded "Bearer token" or "Basic base64")
//   (needed for WebSocket connections which can't set headers)
export async function extractAuth(c: Context<AppContext>): Promise<AuthContext> {
  // First check Authorization header
  let authValue = c.req.header('Authorization');

  // If no header, check query parameter (for WebSocket connections)
  if (!authValue) {
    const url = new URL(c.req.url);
    const authParam = url.searchParams.get('auth');
    if (authParam) {
      // The web UI sends auth as base64-encoded string
      // Try base64 decode first, fall back to URL decode
      try {
        authValue = atob(authParam);
      } catch {
        // Not valid base64, try URL decode
        try {
          authValue = decodeURIComponent(authParam);
        } catch {
          authValue = authParam;
        }
      }
    }
  }

  if (!authValue) {
    return { anonymous: true };
  }

  // Bearer token authentication
  if (authValue.startsWith('Bearer ')) {
    const token = authValue.slice(7);
    return await authenticateBearerToken(c, token);
  }

  // Basic authentication
  if (authValue.startsWith('Basic ')) {
    const credentials = authValue.slice(6);
    return await authenticateBasic(c, credentials);
  }

  return { anonymous: true };
}

// Authenticate with Bearer token (JWT or database token)
async function authenticateBearerToken(c: Context<AppContext>, token: string): Promise<AuthContext> {
  const secret = c.env.JWT_SECRET;

  // First try JWT verification
  if (secret) {
    const payload = await verifyJWT(token, secret);
    if (payload) {
      // Look up user from database
      const user = await getUserById(c.env.DB, payload.sub);
      if (user) {
        return { user, anonymous: false };
      }
    }
  }

  // Try database token lookup
  const dbToken = await getTokenById(c.env.DB, token);
  if (dbToken) {
    // Check if token is expired
    if (dbToken.expires > 0 && dbToken.expires < Math.floor(Date.now() / 1000)) {
      return { anonymous: true };
    }

    // Update last access
    await updateTokenAccess(c.env.DB, token, c.req.header('CF-Connecting-IP') || '');

    // Get user
    const user = await getUserById(c.env.DB, dbToken.user_id);
    if (user) {
      return { user, token: dbToken, anonymous: false };
    }
  }

  return { anonymous: true };
}

// Authenticate with Basic auth (username:password)
async function authenticateBasic(c: Context<AppContext>, credentials: string): Promise<AuthContext> {
  try {
    const decoded = atob(credentials);
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      return { anonymous: true };
    }

    const username = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    // Check if password looks like a token (try token auth first)
    if (password.length > 32) {
      const tokenAuth = await authenticateBearerToken(c, password);
      if (!tokenAuth.anonymous) {
        return tokenAuth;
      }
    }

    // Try username/password auth
    const user = await getUserByUsername(c.env.DB, username);
    if (!user) {
      return { anonymous: true };
    }

    // Get password hash
    const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();

    if (!row) {
      return { anonymous: true };
    }

    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) {
      return { anonymous: true };
    }

    return { user, anonymous: false };
  } catch {
    return { anonymous: true };
  }
}

// Database helpers
async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare('SELECT id, username, role, tier, sync_topic, created FROM users WHERE id = ?').bind(id).first<UserRow>();

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    role: row.role as User['role'],
    tier: row.tier,
    sync_topic: row.sync_topic,
    created: row.created,
  };
}

async function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  const row = await db
    .prepare('SELECT id, username, role, tier, sync_topic, created FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first<UserRow>();

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    role: row.role as User['role'],
    tier: row.tier,
    sync_topic: row.sync_topic,
    created: row.created,
  };
}

async function getTokenById(db: D1Database, id: string): Promise<Token | null> {
  const row = await db
    .prepare('SELECT id, user_id, label, last_access, last_origin, expires FROM tokens WHERE id = ?')
    .bind(id)
    .first<TokenRow>();

  if (!row) return null;

  return {
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    last_access: row.last_access,
    last_origin: row.last_origin,
    expires: row.expires,
  };
}

async function updateTokenAccess(db: D1Database, tokenId: string, origin: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('UPDATE tokens SET last_access = ?, last_origin = ? WHERE id = ?').bind(now, origin, tokenId).run();
}

// Auth middleware - sets auth context on request
export async function authMiddleware(c: Context<AppContext>, next: Next): Promise<Response | void> {
  const auth = await extractAuth(c);
  c.set('auth', auth);
  return next();
}

// Require authentication middleware
export async function requireAuth(c: Context<AppContext>, next: Next): Promise<Response | void> {
  const auth = await extractAuth(c);
  c.set('auth', auth);

  if (auth.anonymous) {
    return c.json({ code: 40101, error: 'Unauthorized' }, 401);
  }

  return next();
}

// Require admin middleware
export async function requireAdmin(c: Context<AppContext>, next: Next): Promise<Response | void> {
  const auth = await extractAuth(c);
  c.set('auth', auth);

  if (auth.anonymous || auth.user?.role !== 'admin') {
    return c.json({ code: 40301, error: 'Forbidden' }, 403);
  }

  return next();
}
