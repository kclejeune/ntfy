import type { Message, MessageRow, InternalMessage } from '../types/message';
import { rowToMessage, PRIORITY_DEFAULT, EVENT_MESSAGE } from '../types/message';

export async function insertMessage(db: D1Database, msg: InternalMessage, expires: number): Promise<void> {
  const tags = msg.tags?.join(',') || '';
  const actions = msg.actions ? JSON.stringify(msg.actions) : '';

  await db
    .prepare(
      `INSERT INTO messages (
      mid, time, expires, topic, message, title, priority, tags, click, icon, actions,
      attachment_name, attachment_type, attachment_size, attachment_expires, attachment_url,
      sender, user_id, content_type, encoding, published
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .bind(
      msg.id,
      msg.time,
      expires,
      msg.topic,
      msg.message || '',
      msg.title || '',
      msg.priority || PRIORITY_DEFAULT,
      tags,
      msg.click || '',
      msg.icon || '',
      actions,
      msg.attachment?.name || '',
      msg.attachment?.type || '',
      msg.attachment?.size || 0,
      msg.attachment?.expires || 0,
      msg.attachment?.url || '',
      msg.sender || '',
      msg.user_id || '',
      msg.content_type || '',
      msg.encoding || ''
    )
    .run();

  // Update stats counter
  await db.prepare("UPDATE stats SET value = value + 1 WHERE key = 'messages'").run();
}

export async function getMessagesSince(db: D1Database, topic: string, since: number, limit: number = 100): Promise<Message[]> {
  const result = await db
    .prepare(
      `SELECT * FROM messages
       WHERE topic = ? AND time > ? AND published = 1 AND expires > ?
       ORDER BY time ASC
       LIMIT ?`
    )
    .bind(topic, since, Math.floor(Date.now() / 1000), limit)
    .all<MessageRow>();

  return (result.results || []).map(rowToMessage);
}

export async function getMessagesSinceId(db: D1Database, topic: string, sinceId: string, limit: number = 100): Promise<Message[]> {
  // First find the message with the given ID to get its time
  const sinceMsg = await db.prepare(`SELECT time FROM messages WHERE mid = ?`).bind(sinceId).first<{ time: number }>();

  if (!sinceMsg) {
    // If message not found, return all messages
    return getMessagesSince(db, topic, 0, limit);
  }

  const result = await db
    .prepare(
      `SELECT * FROM messages
       WHERE topic = ? AND time > ? AND published = 1 AND expires > ?
       ORDER BY time ASC
       LIMIT ?`
    )
    .bind(topic, sinceMsg.time, Math.floor(Date.now() / 1000), limit)
    .all<MessageRow>();

  return (result.results || []).map(rowToMessage);
}

export async function getLatestMessages(db: D1Database, topic: string, limit: number = 100): Promise<Message[]> {
  const result = await db
    .prepare(
      `SELECT * FROM messages
       WHERE topic = ? AND published = 1 AND expires > ?
       ORDER BY time DESC
       LIMIT ?`
    )
    .bind(topic, Math.floor(Date.now() / 1000), limit)
    .all<MessageRow>();

  // Reverse to get chronological order
  return (result.results || []).map(rowToMessage).reverse();
}

export async function deleteExpiredMessages(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(`DELETE FROM messages WHERE expires <= ?`).bind(now).run();

  return result.meta.changes || 0;
}

export async function getMessageById(db: D1Database, mid: string): Promise<Message | null> {
  const result = await db.prepare(`SELECT * FROM messages WHERE mid = ?`).bind(mid).first<MessageRow>();

  return result ? rowToMessage(result) : null;
}
