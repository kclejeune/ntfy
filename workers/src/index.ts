import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types/env';
import type { AuthContext } from './types/user';
import { handlePublish } from './handlers/publish';
import { handleSubscribeWS, handleSubscribeSSE, handleSubscribeJSON } from './handlers/subscribe';
import {
  handleAccountCreate,
  handleAccountGet,
  handleAccountTokenCreate,
  handleAccountTokenDelete,
  handleAccountPasswordChange,
  handleAccountDelete,
  handleAuth,
} from './handlers/account';
import { extractAuth } from './auth/middleware';
import { checkTopicAccess, type AccessCheckResult } from './auth/access';

// Helper to return access denied response
function accessDeniedResponse(access: AccessCheckResult): Response {
  return new Response(JSON.stringify({ code: access.code, error: access.error }), {
    status: access.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Re-export Durable Object
export { TopicDO } from './durable-objects/TopicDO';

// Extended context with auth
type Variables = {
  auth: AuthContext;
};

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};

// Topic name validation regex
const TOPIC_REGEX = /^[-_A-Za-z0-9]{1,64}$/;

function isValidTopic(topic: string): boolean {
  return TOPIC_REGEX.test(topic);
}

// Reserved paths that should not be treated as topics
const RESERVED_PATHS = new Set(['v1', 'config.js', 'docs', 'static', 'app', 'sw.js', 'manifest.webmanifest', '_app', 'auth', 'settings', 'account', 'login', 'signup']);

// SPA routes that should serve index.html
const SPA_ROUTES = new Set(['', 'app', 'settings', 'account', 'login', 'signup']);

// Create the main Hono app
const app = new Hono<AppContext>();

// CORS middleware
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Title', 'X-Message', 'X-Priority', 'X-Tags', 'X-Click', 'X-Icon', 'X-Actions', 'X-Delay', 'X-Cache', 'X-Poll-ID', 'X-Markdown'],
    exposeHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

// Root path - serve SPA
app.get('/', async (c) => {
  // In Pages, the static assets are served automatically
  // Return a redirect to /app or serve index.html via ASSETS binding
  const env = c.env as Env & { ASSETS?: { fetch: typeof fetch } };
  if (env.ASSETS) {
    return env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  }
  // Fallback for standalone worker
  return c.redirect('/app');
});

// Web manifest for PWA
app.get('/manifest.webmanifest', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  const manifest = {
    name: 'ntfy',
    short_name: 'ntfy',
    description: 'ntfy lets you send push notifications via scripts using simple HTTP requests',
    start_url: `${baseUrl}/app`,
    scope: `${baseUrl}/`,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#317f6f',
    icons: [
      {
        src: '/static/images/pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/static/images/pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
  return c.json(manifest, 200, {
    'Content-Type': 'application/manifest+json',
  });
});

// Docs redirect (ensure trailing slash)
app.get('/docs', (c) => {
  return c.redirect('/docs/');
});

// Health check
app.get('/v1/health', (c) => {
  return c.json({ healthy: true });
});

// Stats endpoint
app.get('/v1/stats', async (c) => {
  const result = await c.env.DB.prepare("SELECT value FROM stats WHERE key = 'messages'").first<{ value: number }>();
  return c.json({
    messages: result?.value ?? 0,
    messages_rate: 0,
  });
});

// Config endpoint (for web UI)
app.get('/config.js', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  const config = {
    base_url: baseUrl,
    app_root: '/',
    enable_login: true,
    require_login: false,
    enable_signup: true,
    enable_payments: false,
    enable_calls: false,
    enable_emails: false,
    enable_reservations: true,
    enable_web_push: false,
    billing_contact: '',
    web_push_public_key: '',
    disallowed_topics: [],
  };
  return c.text(`var config = ${JSON.stringify(config, null, 2)};`, 200, {
    'Content-Type': 'application/javascript',
  });
});

// ==================== Account endpoints ====================

// POST /v1/account - Create account
app.post('/v1/account', handleAccountCreate);

// GET /v1/account - Get account info
app.get('/v1/account', handleAccountGet);

// POST /v1/account/token - Create new token
app.post('/v1/account/token', handleAccountTokenCreate);

// DELETE /v1/account/token/:token - Delete token
app.delete('/v1/account/token/:token', async (c) => {
  return handleAccountTokenDelete(c, c.req.param('token'));
});

// POST /v1/account/password - Change password
app.post('/v1/account/password', handleAccountPasswordChange);

// DELETE /v1/account - Delete account
app.delete('/v1/account', handleAccountDelete);

// POST /auth - Login check (for ntfy compatibility)
app.post('/auth', handleAuth);

// ==================== Publish endpoints ====================

// POST/PUT /{topic} - Publish message
app.post('/:topic', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic) || RESERVED_PATHS.has(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  // Check write access
  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'write');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handlePublish(c, topic);
});

app.put('/:topic', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic) || RESERVED_PATHS.has(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  // Check write access
  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'write');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handlePublish(c, topic);
});

// Alternative publish paths (for compatibility)
app.post('/:topic/publish', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'write');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handlePublish(c, topic);
});

app.post('/:topic/send', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'write');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handlePublish(c, topic);
});

// ==================== Subscribe endpoints ====================

// WebSocket subscription: GET /{topic}/ws
app.get('/:topic/ws', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  // Check read access
  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'read');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handleSubscribeWS(c, topic);
});

// SSE subscription: GET /{topic}/sse
app.get('/:topic/sse', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'read');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handleSubscribeSSE(c, topic);
});

// JSON subscription: GET /{topic}/json
app.get('/:topic/json', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  const auth = await extractAuth(c);
  const access = await checkTopicAccess(c.env.DB, topic, auth, 'read');
  if (!access.allowed) {
    return accessDeniedResponse(access);
  }

  return handleSubscribeJSON(c, topic);
});

// Handle .json and .sse extensions
app.get('/:topicExt', async (c) => {
  const topicExt = c.req.param('topicExt');

  // Check for .json extension
  if (topicExt.endsWith('.json')) {
    const topic = topicExt.slice(0, -5);
    if (isValidTopic(topic)) {
      const auth = await extractAuth(c);
      const access = await checkTopicAccess(c.env.DB, topic, auth, 'read');
      if (!access.allowed) {
        return accessDeniedResponse(access);
      }
      return handleSubscribeJSON(c, topic);
    }
  }

  // Check for .sse extension
  if (topicExt.endsWith('.sse')) {
    const topic = topicExt.slice(0, -4);
    if (isValidTopic(topic)) {
      const auth = await extractAuth(c);
      const access = await checkTopicAccess(c.env.DB, topic, auth, 'read');
      if (!access.allowed) {
        return accessDeniedResponse(access);
      }
      return handleSubscribeSSE(c, topic);
    }
  }

  // Check if this is a SPA route
  if (SPA_ROUTES.has(topicExt)) {
    const env = c.env as Env & { ASSETS?: { fetch: typeof fetch } };
    if (env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
    }
    return c.redirect('/');
  }

  // Not a subscription request, return 404
  return c.json({ error: 'Not found' }, 404);
});

// Topic auth check: GET /{topic}/auth
app.get('/:topic/auth', async (c) => {
  const topic = c.req.param('topic');

  if (!isValidTopic(topic)) {
    return c.json({ error: 'Invalid topic' }, 400);
  }

  const auth = await extractAuth(c);
  const readAccess = await checkTopicAccess(c.env.DB, topic, auth, 'read');
  const writeAccess = await checkTopicAccess(c.env.DB, topic, auth, 'write');

  return c.json({
    success: true,
    read: readAccess.allowed,
    write: writeAccess.allowed,
  });
});

// Export the app
export default {
  fetch: app.fetch,
};
