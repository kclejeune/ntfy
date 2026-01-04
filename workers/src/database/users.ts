import type {
  User,
  UserRow,
  Token,
  TokenRow,
  UserAccess,
  UserAccessRow,
} from "../types/user";
import { hashPassword } from "../auth/password";
import { generateMessageId } from "../types/message";

// Generate a unique user ID
function generateUserId(): string {
  return "u_" + generateMessageId() + generateMessageId();
}

// Generate a unique token ID
function generateTokenId(): string {
  return (
    "tk_" + generateMessageId() + generateMessageId() + generateMessageId()
  );
}

// Generate a sync topic for a user
function generateSyncTopic(): string {
  return "st_" + generateMessageId() + generateMessageId();
}

// Create a new user
export async function createUser(
  db: D1Database,
  username: string,
  password: string,
  role: User["role"] = "user",
): Promise<User> {
  const id = generateUserId();
  const passwordHash = await hashPassword(password);
  const syncTopic = generateSyncTopic();
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, tier, sync_topic, created)
       VALUES (?, ?, ?, ?, 'default', ?, ?)`,
    )
    .bind(id, username, passwordHash, role, syncTopic, now)
    .run();

  return {
    id,
    username,
    role,
    tier: "default",
    sync_topic: syncTopic,
    created: now,
  };
}

// Get user by ID
export async function getUserById(
  db: D1Database,
  id: string,
): Promise<User | null> {
  const row = await db
    .prepare(
      "SELECT id, username, role, tier, sync_topic, created FROM users WHERE id = ?",
    )
    .bind(id)
    .first<UserRow>();

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    role: row.role as User["role"],
    tier: row.tier,
    sync_topic: row.sync_topic,
    created: row.created,
  };
}

// Get user by username
export async function getUserByUsername(
  db: D1Database,
  username: string,
): Promise<User | null> {
  const row = await db
    .prepare(
      "SELECT id, username, role, tier, sync_topic, created FROM users WHERE username = ? COLLATE NOCASE",
    )
    .bind(username)
    .first<UserRow>();

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    role: row.role as User["role"],
    tier: row.tier,
    sync_topic: row.sync_topic,
    created: row.created,
  };
}

// Get user password hash
export async function getUserPasswordHash(
  db: D1Database,
  id: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(id)
    .first<{ password_hash: string }>();

  return row?.password_hash ?? null;
}

// Update user password
export async function updateUserPassword(
  db: D1Database,
  id: string,
  newPassword: string,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(passwordHash, id)
    .run();
}

// Delete user
export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

// Check if username exists
export async function usernameExists(
  db: D1Database,
  username: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first();

  return row !== null;
}

// Create a new token for a user
export async function createToken(
  db: D1Database,
  userId: string,
  label: string = "",
  expiresIn: number = 0,
): Promise<Token> {
  const id = generateTokenId();
  const now = Math.floor(Date.now() / 1000);
  const expires = expiresIn > 0 ? now + expiresIn : 0;

  await db
    .prepare(
      `INSERT INTO tokens (id, user_id, label, last_access, last_origin, expires) VALUES (?, ?, ?, ?, '', ?)`,
    )
    .bind(id, userId, label, now, expires)
    .run();

  return {
    id,
    user_id: userId,
    label,
    last_access: now,
    last_origin: "",
    expires,
  };
}

// Get tokens for a user
export async function getUserTokens(
  db: D1Database,
  userId: string,
): Promise<Token[]> {
  const result = await db
    .prepare(
      "SELECT id, user_id, label, last_access, last_origin, expires FROM tokens WHERE user_id = ?",
    )
    .bind(userId)
    .all<TokenRow>();

  return (result.results || []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    last_access: row.last_access,
    last_origin: row.last_origin,
    expires: row.expires,
  }));
}

// Delete a token
export async function deleteToken(
  db: D1Database,
  tokenId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM tokens WHERE id = ? AND user_id = ?")
    .bind(tokenId, userId)
    .run();

  return (result.meta.changes || 0) > 0;
}

// Delete expired tokens (called by scheduled cleanup)
export async function deleteExpiredTokens(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // Delete tokens where expires > 0 (has expiry set) AND expires < now (expired)
  const result = await db
    .prepare("DELETE FROM tokens WHERE expires > 0 AND expires < ?")
    .bind(now)
    .run();
  return result.meta.changes || 0;
}

// Update a token's label and/or expires
export async function updateTokenLabel(
  db: D1Database,
  tokenId: string,
  userId: string,
  label: string,
  expires?: number,
): Promise<Token | null> {
  let result;
  if (expires !== undefined) {
    result = await db
      .prepare(
        "UPDATE tokens SET label = ?, expires = ? WHERE id = ? AND user_id = ?",
      )
      .bind(label, expires, tokenId, userId)
      .run();
  } else {
    result = await db
      .prepare("UPDATE tokens SET label = ? WHERE id = ? AND user_id = ?")
      .bind(label, tokenId, userId)
      .run();
  }

  if ((result.meta.changes || 0) === 0) {
    return null;
  }

  // Fetch and return the updated token
  const row = await db
    .prepare(
      "SELECT id, user_id, label, last_access, last_origin, expires FROM tokens WHERE id = ?",
    )
    .bind(tokenId)
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

// Get user access for a topic
export async function getUserAccess(
  db: D1Database,
  userId: string,
  topic: string,
): Promise<UserAccess | null> {
  const row = await db
    .prepare(
      "SELECT user_id, topic, read, write, owner_user_id FROM user_access WHERE user_id = ? AND topic = ?",
    )
    .bind(userId, topic)
    .first<UserAccessRow>();

  if (!row) return null;

  return {
    user_id: row.user_id,
    topic: row.topic,
    read: row.read === 1,
    write: row.write === 1,
    owner_user_id: row.owner_user_id || undefined,
  };
}

// Set user access for a topic
export async function setUserAccess(
  db: D1Database,
  userId: string,
  topic: string,
  read: boolean,
  write: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_access (user_id, topic, read, write)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, topic) DO UPDATE SET read = ?, write = ?`,
    )
    .bind(
      userId,
      topic,
      read ? 1 : 0,
      write ? 1 : 0,
      read ? 1 : 0,
      write ? 1 : 0,
    )
    .run();
}

// Delete user access for a topic
export async function deleteUserAccess(
  db: D1Database,
  userId: string,
  topic: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM user_access WHERE user_id = ? AND topic = ?")
    .bind(userId, topic)
    .run();
}

// Check if a topic is reserved
export async function isTopicReserved(
  db: D1Database,
  topic: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM reservations WHERE topic = ?")
    .bind(topic)
    .first();

  return row !== null;
}

// Get topic reservation owner
export async function getTopicOwner(
  db: D1Database,
  topic: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM reservations WHERE topic = ?")
    .bind(topic)
    .first<{ user_id: string }>();

  return row?.user_id ?? null;
}
