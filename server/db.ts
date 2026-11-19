/**
 * ORBIT veritabanı katmanı — kalıcı SQLite (WAL).
 * Şema, migration kayıtları, indeksler ve kısıtlar burada tanımlanır.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, 'orbit.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

export const now = () => Date.now();

export function newId(prefix = ''): string {
  const raw = crypto.randomBytes(9).toString('base64url');
  return prefix ? `${prefix}_${raw}` : raw;
}

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#7c5cff',
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','idle','dnd','offline','invisible')),
  custom_status TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dm_privacy TEXT NOT NULL DEFAULT 'everyone' CHECK (dm_privacy IN ('everyone','friends')),
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  sounds_enabled INTEGER NOT NULL DEFAULT 1,
  push_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_color TEXT NOT NULL DEFAULT '#7c5cff',
  icon_url TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);
CREATE INDEX IF NOT EXISTS idx_servers_public ON servers(is_public);

CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  timeout_until INTEGER,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9aa0b4',
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id, position);

CREATE TABLE IF NOT EXISTS member_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_server ON member_roles(server_id);

CREATE TABLE IF NOT EXISTS channel_categories (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_categories_server ON channel_categories(server_id, position);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','voice','forum','announcement')),
  position INTEGER NOT NULL DEFAULT 0,
  slowmode_seconds INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member')),
  target_id TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS dm_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct','group')),
  name TEXT,
  icon_color TEXT NOT NULL DEFAULT '#3b82f6',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_members (
  dm_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  last_read_at INTEGER,
  PRIMARY KEY (dm_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  dm_id TEXT REFERENCES dm_channels(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '',
  title TEXT,
  parent_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','system')),
  pinned INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((channel_id IS NOT NULL) <> (dm_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(dm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(channel_id, pinned);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_files (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, file_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS message_edits (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  old_content TEXT NOT NULL,
  edited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_edits ON message_edits(message_id, edited_at);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  UNIQUE (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_id, status);

CREATE TABLE IF NOT EXISTS friendships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  server_id TEXT,
  channel_id TEXT,
  dm_id TEXT,
  message_id TEXT,
  actor_id TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_server ON reports(server_id, status);

CREATE TABLE IF NOT EXISTS mod_actions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_server ON mod_actions(server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bans (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  banned_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS server_events (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_server ON server_events(server_id, starts_at);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'going' CHECK (status IN ('going','interested')),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  closes_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (poll_id, option_id, user_id)
);

CREATE TABLE IF NOT EXISTS read_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('channel','dm')),
  scope_id TEXT NOT NULL,
  last_read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'push_subscriptions',
    sql: `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`,
  },
];

export function runMigrations(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id, migration.name, now());
    });
    tx();
  }
}

runMigrations();

/** Yavaş sorguları ve hataları teşhis etmek için basit yardımcı. */
export function timed<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  if (elapsed > 200) console.warn(`[db] yavaş sorgu (${label}): ${elapsed.toFixed(0)}ms`);
  return result;
}
