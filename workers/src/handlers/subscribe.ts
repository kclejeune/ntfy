import type { Context } from 'hono';
import type { AppContext } from '../router';
import type { Message } from '../types/message';
import { createOpenMessage, createKeepaliveMessage } from '../types/message';
import { getMessagesSince, getMessagesSinceId, getLatestMessages } from '../database/messages';

// Parse 'since' parameter
interface SinceMarker {
  type: 'all' | 'none' | 'time' | 'id';
  value: number | string;
}

function parseSince(since: string | null): SinceMarker {
  if (!since || since === 'all') {
    return { type: 'all', value: 0 };
  }
  if (since === 'none') {
    return { type: 'none', value: 0 };
  }

  // Check if it's a message ID (12 alphanumeric chars)
  if (/^[a-zA-Z0-9]{12}$/.test(since)) {
    return { type: 'id', value: since };
  }

  // Try to parse as timestamp
  const timestamp = parseInt(since, 10);
  if (!isNaN(timestamp)) {
    return { type: 'time', value: timestamp };
  }

  // Try to parse relative time (e.g., "10m", "1h", "1d")
  const match = since.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    const seconds = amount * (multipliers[unit] || 1);
    return { type: 'time', value: Math.floor(Date.now() / 1000) - seconds };
  }

  return { type: 'none', value: 0 };
}

// Handle WebSocket subscription
export async function handleSubscribeWS(c: Context<AppContext>, topic: string): Promise<Response> {
  // Validate WebSocket upgrade
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  // Forward to Durable Object
  const doId = c.env.TOPIC_DO.idFromName(topic);
  const stub = c.env.TOPIC_DO.get(doId);

  // Pass through the WebSocket request
  const url = new URL(c.req.url);
  return stub.fetch(`https://internal/topic/${topic}/ws${url.search}`, {
    headers: c.req.raw.headers,
  });
}

// Handle SSE subscription
export async function handleSubscribeSSE(c: Context<AppContext>, topic: string): Promise<Response> {
  const url = new URL(c.req.url);
  const since = parseSince(url.searchParams.get('since'));
  const poll = url.searchParams.get('poll') === '1';

  // Create a TransformStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Start async processing
  c.executionCtx.waitUntil(
    (async () => {
      try {
        // Send open event
        const openMsg = createOpenMessage(topic);
        await writer.write(encoder.encode(`data: ${JSON.stringify(openMsg)}\n\n`));

        // Send historical messages if requested
        if (since.type !== 'none') {
          let messages: Message[] = [];

          if (since.type === 'all') {
            messages = await getMessagesSince(c.env.DB, topic, 0);
          } else if (since.type === 'time') {
            messages = await getMessagesSince(c.env.DB, topic, since.value as number);
          } else if (since.type === 'id') {
            messages = await getMessagesSinceId(c.env.DB, topic, since.value as string);
          }

          for (const msg of messages) {
            await writer.write(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
          }
        }

        // For polling, close immediately after sending historical messages
        if (poll) {
          await writer.close();
          return;
        }

        // For streaming, connect to Durable Object for real-time updates
        // Note: This is a simplified implementation. In production, you'd want
        // to use the Durable Object's SSE endpoint directly.
        const doId = c.env.TOPIC_DO.idFromName(topic);
        const stub = c.env.TOPIC_DO.get(doId);

        // Forward to DO SSE endpoint
        const response = await stub.fetch(`https://internal/topic/${topic}/sse${url.search}`);

        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        }
      } catch (e) {
        // Connection closed
      } finally {
        try {
          await writer.close();
        } catch {
          // Already closed
        }
      }
    })()
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Handle JSON polling
export async function handleSubscribeJSON(c: Context<AppContext>, topic: string): Promise<Response> {
  const url = new URL(c.req.url);
  const since = parseSince(url.searchParams.get('since'));
  const poll = url.searchParams.get('poll') === '1';

  // Get historical messages
  let messages: Message[] = [];

  if (since.type === 'all') {
    messages = await getMessagesSince(c.env.DB, topic, 0);
  } else if (since.type === 'time') {
    messages = await getMessagesSince(c.env.DB, topic, since.value as number);
  } else if (since.type === 'id') {
    messages = await getMessagesSinceId(c.env.DB, topic, since.value as string);
  } else {
    // 'none' - just return empty for poll, or latest for stream
    if (!poll) {
      messages = await getLatestMessages(c.env.DB, topic, 10);
    }
  }

  // For simple polling, return JSON array
  if (poll) {
    return c.json(messages);
  }

  // For streaming, return NDJSON (newline-delimited JSON)
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  c.executionCtx.waitUntil(
    (async () => {
      try {
        // Send open event
        const openMsg = createOpenMessage(topic);
        await writer.write(encoder.encode(JSON.stringify(openMsg) + '\n'));

        // Send historical messages
        for (const msg of messages) {
          await writer.write(encoder.encode(JSON.stringify(msg) + '\n'));
        }

        // Connect to Durable Object for real-time updates
        const doId = c.env.TOPIC_DO.idFromName(topic);
        const stub = c.env.TOPIC_DO.get(doId);

        // Use WebSocket internally to get updates
        const wsResponse = await stub.fetch(`https://internal/topic/${topic}/ws${url.search}`, {
          headers: { Upgrade: 'websocket' },
        });

        const ws = wsResponse.webSocket;
        if (ws) {
          ws.accept();
          ws.addEventListener('message', async (event) => {
            try {
              await writer.write(encoder.encode(event.data + '\n'));
            } catch {
              ws.close();
            }
          });
          ws.addEventListener('close', async () => {
            try {
              await writer.close();
            } catch {
              // Already closed
            }
          });
        }
      } catch (e) {
        // Connection error
      }
    })()
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
