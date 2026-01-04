-- ntfy D1 Database Schema
-- Version: 1

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mid TEXT NOT NULL UNIQUE,
    time INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    topic TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 3,
    tags TEXT NOT NULL DEFAULT '',
    click TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '',
    attachment_name TEXT NOT NULL DEFAULT '',
    attachment_type TEXT NOT NULL DEFAULT '',
    attachment_size INTEGER NOT NULL DEFAULT 0,
    attachment_expires INTEGER NOT NULL DEFAULT 0,
    attachment_url TEXT NOT NULL DEFAULT '',
    sender TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT '',
    encoding TEXT NOT NULL DEFAULT '',
    published INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_messages_mid ON messages(mid);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
CREATE INDEX IF NOT EXISTS idx_messages_topic_time ON messages(topic, time);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    tier TEXT NOT NULL DEFAULT 'default',
    sync_topic TEXT NOT NULL,
    created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Tokens table
CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    last_access INTEGER NOT NULL,
    last_origin TEXT NOT NULL DEFAULT '',
    expires INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id);

-- Access control table
CREATE TABLE IF NOT EXISTS user_access (
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    write INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT,
    PRIMARY KEY (user_id, topic),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_access_topic ON user_access(topic);

-- Topic reservations (topics owned by users)
CREATE TABLE IF NOT EXISTS reservations (
    topic TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    everyone_read INTEGER NOT NULL DEFAULT 0,
    everyone_write INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- User subscriptions (synced across devices)
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    base_url TEXT NOT NULL,
    topic TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    UNIQUE(user_id, base_url, topic),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

-- Stats table
CREATE TABLE IF NOT EXISTS stats (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

-- Initialize stats
INSERT OR IGNORE INTO stats (key, value) VALUES ('messages', 0);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 1);

-- Web Push subscriptions
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT,                           -- Optional: link to user account
    endpoint TEXT NOT NULL UNIQUE,          -- Push service endpoint URL
    key_p256dh TEXT NOT NULL,               -- Client public key (base64url)
    key_auth TEXT NOT NULL,                 -- Client auth secret (base64url)
    topics TEXT NOT NULL DEFAULT '[]',      -- JSON array of subscribed topics
    created INTEGER NOT NULL,
    last_success INTEGER,                   -- Last successful push timestamp
    failure_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_push_endpoint ON web_push_subscriptions(endpoint);
CREATE INDEX IF NOT EXISTS idx_web_push_user ON web_push_subscriptions(user_id);
