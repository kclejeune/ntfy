import type { Env } from '../types/env';
import type { User } from '../types/user';
import { generateMessageId, EVENT_MESSAGE } from '../types/message';

/**
 * Publish a sync event to a user's sync topic.
 * This notifies all connected clients (web UI, other tabs) to refresh account data.
 */
export async function publishSyncEvent(env: Env, user: User): Promise<void> {
  if (!user.sync_topic) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const syncMessage = {
    id: generateMessageId(),
    time: now,
    event: EVENT_MESSAGE,
    topic: user.sync_topic,
    message: JSON.stringify({ event: 'sync' }),
  };

  // Broadcast via Durable Object
  try {
    const doId = env.TOPIC_DO.idFromName(user.sync_topic);
    const stub = env.TOPIC_DO.get(doId);

    await stub.fetch(`https://internal/topic/${user.sync_topic}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncMessage),
    });

    console.log(`[Sync] Published sync event to ${user.sync_topic}`);
  } catch (err) {
    console.error(`[Sync] Failed to publish sync event:`, err);
  }
}

/**
 * Publish sync event in background (non-blocking).
 * Use this from handlers to avoid slowing down the response.
 */
export function publishSyncEventAsync(ctx: ExecutionContext, env: Env, user: User): void {
  ctx.waitUntil(publishSyncEvent(env, user));
}
