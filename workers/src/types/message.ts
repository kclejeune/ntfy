// Message event types
export const EVENT_OPEN = "open";
export const EVENT_KEEPALIVE = "keepalive";
export const EVENT_MESSAGE = "message";
export const EVENT_POLL_REQUEST = "poll_request";

export const MESSAGE_ID_LENGTH = 12;

// Priority levels
export const PRIORITY_MIN = 1;
export const PRIORITY_LOW = 2;
export const PRIORITY_DEFAULT = 3;
export const PRIORITY_HIGH = 4;
export const PRIORITY_MAX = 5;

export interface Attachment {
  name: string;
  type?: string;
  size?: number;
  expires?: number;
  url: string;
}

export interface Action {
  id: string;
  action: "view" | "broadcast" | "http";
  label: string;
  clear?: boolean;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  intent?: string;
  extras?: Record<string, string>;
}

export interface Message {
  id: string;
  time: number;
  expires?: number;
  event: string;
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: Action[];
  attachment?: Attachment;
  poll_id?: string;
  content_type?: string;
  encoding?: string;
}

// Internal message with sender info (not serialized to JSON)
export interface InternalMessage extends Message {
  sender?: string;
  user_id?: string;
}

// Publish request body (JSON format)
export interface PublishRequest {
  topic?: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: Action[];
  attach?: string;
  markdown?: boolean;
  filename?: string;
  delay?: string;
  cache?: string;
}

// Database row representation
export interface MessageRow {
  id: number;
  mid: string;
  time: number;
  expires: number;
  topic: string;
  message: string;
  title: string;
  priority: number;
  tags: string;
  click: string;
  icon: string;
  actions: string;
  attachment_name: string;
  attachment_type: string;
  attachment_size: number;
  attachment_expires: number;
  attachment_url: string;
  sender: string;
  user_id: string;
  content_type: string;
  encoding: string;
  published: number;
}

// Convert database row to Message
export function rowToMessage(row: MessageRow): Message {
  const msg: Message = {
    id: row.mid,
    time: row.time,
    event: EVENT_MESSAGE,
    topic: row.topic,
  };

  if (row.expires) msg.expires = row.expires;
  if (row.title) msg.title = row.title;
  if (row.message) msg.message = row.message;
  if (row.priority && row.priority !== PRIORITY_DEFAULT)
    msg.priority = row.priority;
  if (row.tags) msg.tags = row.tags.split(",").filter(Boolean);
  if (row.click) msg.click = row.click;
  if (row.icon) msg.icon = row.icon;
  if (row.actions) {
    try {
      msg.actions = JSON.parse(row.actions);
    } catch {
      // Ignore parse errors
    }
  }
  if (row.attachment_url) {
    msg.attachment = {
      name: row.attachment_name,
      type: row.attachment_type || undefined,
      size: row.attachment_size || undefined,
      expires: row.attachment_expires || undefined,
      url: row.attachment_url,
    };
  }
  if (row.content_type) msg.content_type = row.content_type;
  if (row.encoding) msg.encoding = row.encoding;

  return msg;
}

// Generate random message ID
export function generateMessageId(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < MESSAGE_ID_LENGTH; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Create an open event message
export function createOpenMessage(topic: string): Message {
  return {
    id: generateMessageId(),
    time: Math.floor(Date.now() / 1000),
    event: EVENT_OPEN,
    topic,
  };
}

// Create a keepalive event message
export function createKeepaliveMessage(topic: string): Message {
  return {
    id: generateMessageId(),
    time: Math.floor(Date.now() / 1000),
    event: EVENT_KEEPALIVE,
    topic,
  };
}
