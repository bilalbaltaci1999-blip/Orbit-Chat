/** Veritabanı satırlarını API nesnelerine dönüştürür. */
import { db } from './db';
import type {
  Category,
  Channel,
  DmChannel,
  FileAttachment,
  Message,
  ModLogEntry,
  Notification,
  Poll,
  PublicUser,
  Role,
  Server,
  ServerDetail,
  ServerEvent,
  ServerMember,
  UserStatus,
} from '../shared/types';
import type { ChannelRow, MemberContext, RoleRow, ServerRow } from './permissions';
import { canViewChannel, channelPermissions } from './permissions';
import { DEFAULT_BANNER } from '../shared/badges';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url: string | null;
  bio: string;
  status: string;
  custom_status: string;
  created_at: number;
  banner_color?: string | null;
}

const qUser = db.prepare(
  'SELECT id, username, display_name, avatar_color, avatar_url, bio, status, custom_status, created_at FROM users WHERE id = ?',
);

export function publicUser(row: UserRow | null | undefined): PublicUser | null {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    status: row.status as UserStatus,
    customStatus: row.custom_status,
    createdAt: row.created_at,
    bannerColor: row.banner_color ?? DEFAULT_BANNER,
  };
}

export function getUser(id: string | null | undefined): PublicUser | null {
  if (!id) return null;
  return publicUser(qUser.get(id) as UserRow | undefined);
}

export function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    serverId: row.server_id,
    categoryId: row.category_id,
    name: row.name,
    topic: row.topic,
    type: row.type,
    position: row.position,
    slowmodeSeconds: row.slowmode_seconds,
    isPrivate: row.is_private === 1,
  };
}

export function mapRole(row: RoleRow): Role {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    position: row.position,
    permissions: row.permissions,
    isDefault: row.is_default === 1,
  };
}

export function mapServer(row: ServerRow): Server {
  const count = db.prepare('SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?').get(row.id) as { c: number };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    iconColor: row.icon_color,
    iconUrl: row.icon_url,
    ownerId: row.owner_id,
    isPublic: row.is_public === 1,
    createdAt: row.created_at,
    memberCount: count.c,
  };
}

export function getServerMembers(serverId: string): ServerMember[] {
  const rows = db
    .prepare(
      `SELECT sm.user_id, sm.nickname, sm.joined_at, sm.timeout_until,
              u.username, u.display_name, u.avatar_color, u.avatar_url, u.status, u.custom_status
       FROM server_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.server_id = ?`,
    )
    .all(serverId) as {
    user_id: string;
    nickname: string | null;
    joined_at: number;
    timeout_until: number | null;
    username: string;
    display_name: string;
    avatar_color: string;
    avatar_url: string | null;
    status: string;
    custom_status: string;
  }[];

  const roleRows = db
    .prepare('SELECT user_id, role_id FROM member_roles WHERE server_id = ?')
    .all(serverId) as { user_id: string; role_id: string }[];
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push(r.role_id);
    rolesByUser.set(r.user_id, list);
  }

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    nickname: r.nickname,
    avatarColor: r.avatar_color,
    avatarUrl: r.avatar_url,
    status: r.status as UserStatus,
    customStatus: r.custom_status,
    roleIds: rolesByUser.get(r.user_id) ?? [],
    joinedAt: r.joined_at,
    timeoutUntil: r.timeout_until,
  }));
}

export function serverDetail(ctx: MemberContext): ServerDetail {
  const channels = (db
    .prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC')
    .all(ctx.server.id) as ChannelRow[]).filter((c) => canViewChannel(ctx, c));

  const categories = (db
    .prepare('SELECT * FROM channel_categories WHERE server_id = ? ORDER BY position ASC')
    .all(ctx.server.id) as { id: string; server_id: string; name: string; position: number }[]).map(
    (c): Category => ({ id: c.id, serverId: c.server_id, name: c.name, position: c.position }),
  );

  const roles = (db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC').all(ctx.server.id) as RoleRow[]).map(mapRole);

  return {
    ...mapServer(ctx.server),
    channels: channels.map(mapChannel),
    categories,
    roles,
    members: getServerMembers(ctx.server.id),
    myPermissions: ctx.permissions,
  };
}

/* ---------------------------------- mesajlar --------------------------------- */

interface MessageRow {
  id: string;
  channel_id: string | null;
  dm_id: string | null;
  author_id: string | null;
  content: string;
  title: string | null;
  parent_id: string | null;
  type: 'text' | 'system';
  pinned: number;
  edited_at: number | null;
  created_at: number;
}

const qReactions = db.prepare(
  `SELECT emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS users
   FROM message_reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(created_at) ASC`,
);
const qFiles = db.prepare(
  `SELECT f.id, f.name, f.mime, f.size FROM message_files mf JOIN files f ON f.id = mf.file_id
   WHERE mf.message_id = ? ORDER BY f.created_at ASC`,
);
const qPoll = db.prepare('SELECT * FROM polls WHERE message_id = ?');
const qPollOptions = db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC');
const qPollVotes = db.prepare('SELECT option_id, user_id FROM poll_votes WHERE poll_id = ?');
const qParent = db.prepare(
  `SELECT m.id, m.content, u.display_name FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
);
const qReplyCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE parent_id = ?');

function buildPoll(messageId: string, viewerId: string): Poll | null {
  const poll = qPoll.get(messageId) as
    | { id: string; question: string; allow_multiple: number; anonymous: number; closes_at: number | null }
    | undefined;
  if (!poll) return null;
  const options = qPollOptions.all(poll.id) as { id: string; label: string }[];
  const votes = qPollVotes.all(poll.id) as { option_id: string; user_id: string }[];
  const myVotes = votes.filter((v) => v.user_id === viewerId).map((v) => v.option_id);
  return {
    id: poll.id,
    question: poll.question,
    allowMultiple: poll.allow_multiple === 1,
    closesAt: poll.closes_at,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: votes.filter((v) => v.option_id === o.id).length,
      voters: votes.filter((v) => v.option_id === o.id).map((v) => v.user_id),
    })),
    myVotes,
  };
}

export function mapMessage(row: MessageRow, viewerId: string): Message {
  const reactions = (qReactions.all(row.id) as { emoji: string; count: number; users: string }[]).map((r) => {
    const users = r.users ? r.users.split(',') : [];
    return { emoji: r.emoji, count: r.count, me: users.includes(viewerId), users };
  });
  const files = (qFiles.all(row.id) as { id: string; name: string; mime: string; size: number }[]).map(
    (f): FileAttachment => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.id}` }),
  );
  const parent = row.parent_id ? (qParent.get(row.parent_id) as { id: string; content: string; display_name: string | null } | undefined) : undefined;
  const replyCount = (qReplyCount.get(row.id) as { c: number }).c;

  return {
    id: row.id,
    channelId: row.channel_id,
    dmId: row.dm_id,
    author: getUser(row.author_id),
    content: row.content,
    title: row.title,
    parentId: row.parent_id,
    parentPreview: parent
      ? { id: parent.id, authorName: parent.display_name ?? 'Bilinmeyen', content: parent.content.slice(0, 140) }
      : null,
    type: row.type,
    pinned: row.pinned === 1,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    reactions,
    files,
    poll: buildPoll(row.id, viewerId),
    replyCount,
  };
}

export const messageColumns =
  'id, channel_id, dm_id, author_id, content, title, parent_id, type, pinned, edited_at, created_at';

export function dmChannelFor(dmId: string, viewerId: string): DmChannel | null {
  const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId) as
    | { id: string; type: 'direct' | 'group'; name: string | null; icon_color: string; owner_id: string | null; created_at: number }
    | undefined;
  if (!dm) return null;
  const memberRows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio, u.status, u.custom_status, u.created_at, dm.joined_at, dm.last_read_at
       FROM dm_members dm JOIN users u ON u.id = dm.user_id WHERE dm.dm_id = ?`,
    )
    .all(dmId) as (UserRow & { joined_at: number; last_read_at: number | null })[];
  const me = memberRows.find((m) => m.id === viewerId);
  if (!me) return null;
  const last = db
    .prepare('SELECT MAX(created_at) AS t FROM messages WHERE dm_id = ?')
    .get(dmId) as { t: number | null };
  const unreadRow = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE dm_id = ? AND created_at > ? AND author_id != ?')
    .get(dmId, me.last_read_at ?? 0, viewerId) as { c: number };

  return {
    id: dm.id,
    type: dm.type,
    name: dm.name,
    iconColor: dm.icon_color,
    ownerId: dm.owner_id,
    members: memberRows.map((m) => publicUser(m)!),
    lastMessageAt: last.t,
    unread: unreadRow.c,
    createdAt: dm.created_at,
  };
}

export function mapNotification(row: {
  id: string;
  type: string;
  title: string;
  body: string;
  server_id: string | null;
  channel_id: string | null;
  dm_id: string | null;
  message_id: string | null;
  actor_id: string | null;
  read_at: number | null;
  created_at: number;
}): Notification {
  return {
    id: row.id,
    type: row.type as Notification['type'],
    title: row.title,
    body: row.body,
    serverId: row.server_id,
    channelId: row.channel_id,
    dmId: row.dm_id,
    messageId: row.message_id,
    actor: getUser(row.actor_id),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function mapEvent(row: {
  id: string;
  server_id: string;
  channel_id: string | null;
  title: string;
  description: string;
  starts_at: number;
  ends_at: number | null;
  created_by: string | null;
}): ServerEvent {
  const attendees = db
    .prepare('SELECT user_id, status FROM event_attendees WHERE event_id = ?')
    .all(row.id) as { user_id: string; status: 'going' | 'interested' }[];
  return {
    id: row.id,
    serverId: row.server_id,
    channelId: row.channel_id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: getUser(row.created_by),
    attendees: attendees.map((a) => ({ userId: a.user_id, status: a.status })),
  };
}

export function mapModLog(row: {
  id: string;
  action: string;
  actor_id: string | null;
  target_id: string | null;
  reason: string;
  created_at: number;
}): ModLogEntry {
  return {
    id: row.id,
    action: row.action,
    actor: getUser(row.actor_id),
    target: getUser(row.target_id),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/** Kullanıcının görebildiği kanallar için okunmamış mesaj sayıları. */
export function unreadCounts(userId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT m.channel_id AS scope_id, COUNT(*) AS c
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = ?
       LEFT JOIN read_states rs ON rs.user_id = ? AND rs.scope_type = 'channel' AND rs.scope_id = m.channel_id
       WHERE m.deleted_at IS NULL AND m.author_id != ? AND m.created_at > COALESCE(rs.last_read_at, sm.joined_at)
       GROUP BY m.channel_id`,
    )
    .all(userId, userId, userId) as { scope_id: string; c: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.scope_id] = row.c;
  return out;
}

export function visibleChannelPermission(ctx: MemberContext, channel: ChannelRow): number {
  return channelPermissions(ctx, channel);
}
