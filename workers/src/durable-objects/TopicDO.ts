import type { Env } from '../types/env';
import { type Message, createOpenMessage, createKeepaliveMessage, EVENT_MESSAGE } from '../types/message';

interface SessionInfo {
  connectedAt: number;
  userId?: string;
  filters?: {
    id?: string;
    message?: string;
    title?: string;
    tags?: string[];
    priority?: number[];
  };
}

export class TopicDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private topic: string;
  private keepaliveInterval: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.topic = '';
    this.keepaliveInterval = parseInt(env.NTFY_KEEPALIVE_INTERVAL || '45', 10) * 1000;

    // Set up alarm for keepalive messages
    this.state.storage.setAlarm(Date.now() + this.keepaliveInterval);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract topic from the DO name (passed in the path)
    if (url.pathname.startsWith('/topic/')) {
      this.topic = url.pathname.split('/')[2];
    }

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // Handle publish (internal call from main worker)
    if (url.pathname.endsWith('/publish') && request.method === 'POST') {
      return this.handlePublish(request);
    }

    // Handle SSE subscription
    if (url.pathname.endsWith('/sse')) {
      return this.handleSSE(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Parse query filters
    const url = new URL(request.url);
    const filters = this.parseFilters(url.searchParams);

    // Store session info as attachment (survives hibernation)
    const sessionInfo: SessionInfo = {
      connectedAt: Date.now(),
      filters,
    };

    // Accept the WebSocket connection with session attachment
    this.state.acceptWebSocket(server);
    server.serializeAttachment(sessionInfo);

    // Send open event
    const openMsg = createOpenMessage(this.topic);
    server.send(JSON.stringify(openMsg));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handlePublish(request: Request): Promise<Response> {
    const message = (await request.json()) as Message;

    // Broadcast to all connected WebSockets
    for (const ws of this.state.getWebSockets()) {
      // Get session info from attachment (survives hibernation)
      const session = ws.deserializeAttachment() as SessionInfo | null;
      if (this.passesFilters(message, session?.filters)) {
        try {
          ws.send(JSON.stringify(message));
        } catch {
          // WebSocket may have closed
        }
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleSSE(request: Request): Response {
    const url = new URL(request.url);
    const filters = this.parseFilters(url.searchParams);

    // Create a TransformStream for SSE
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Send open event immediately
    const openMsg = createOpenMessage(this.topic);
    writer.write(encoder.encode(`data: ${JSON.stringify(openMsg)}\n\n`));

    // Store the writer for broadcasting
    // Note: SSE connections in Durable Objects need special handling
    // For now, we'll just return the stream and handle keepalives via alarm

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Handle incoming WebSocket messages
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Handle ping/pong or other client messages
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message);
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Handle WebSocket close
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // WebSocket automatically removed from getWebSockets() when closed
  }

  // Handle WebSocket error
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // WebSocket automatically removed from getWebSockets() when closed
  }

  // Alarm handler for keepalive messages
  async alarm(): Promise<void> {
    const keepaliveMsg = createKeepaliveMessage(this.topic);
    const msgStr = JSON.stringify(keepaliveMsg);

    // Send keepalive to all connected WebSockets
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msgStr);
      } catch {
        // WebSocket may have closed
      }
    }

    // Schedule next keepalive
    this.state.storage.setAlarm(Date.now() + this.keepaliveInterval);
  }

  private parseFilters(params: URLSearchParams): SessionInfo['filters'] {
    const filters: SessionInfo['filters'] = {};

    const id = params.get('id');
    if (id) filters.id = id;

    const message = params.get('message') || params.get('m');
    if (message) filters.message = message;

    const title = params.get('title') || params.get('t');
    if (title) filters.title = title;

    const tags = params.get('tags') || params.get('tag');
    if (tags) filters.tags = tags.split(',').filter(Boolean);

    const priority = params.get('priority') || params.get('prio') || params.get('p');
    if (priority) {
      filters.priority = priority
        .split(',')
        .map((p) => parseInt(p, 10))
        .filter((p) => !isNaN(p));
    }

    return Object.keys(filters).length > 0 ? filters : undefined;
  }

  private passesFilters(msg: Message, filters?: SessionInfo['filters']): boolean {
    if (!filters) return true;
    if (msg.event !== EVENT_MESSAGE) return true; // Filters only apply to messages

    if (filters.id && msg.id !== filters.id) return false;
    if (filters.message && msg.message !== filters.message) return false;
    if (filters.title && msg.title !== filters.title) return false;

    if (filters.priority && filters.priority.length > 0) {
      const msgPriority = msg.priority || 3; // Default priority is 3
      if (!filters.priority.includes(msgPriority)) return false;
    }

    if (filters.tags && filters.tags.length > 0) {
      const msgTags = msg.tags || [];
      if (!filters.tags.every((tag) => msgTags.includes(tag))) return false;
    }

    return true;
  }
}
