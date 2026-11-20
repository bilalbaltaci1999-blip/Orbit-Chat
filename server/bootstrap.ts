/**
 * Uygulama önyüklemesi: oturum açan kullanıcının tüm başlangıç verisi.
 * Sunucular, DM'ler, arkadaşlar, bildirimler, okunmamışlar ve ICE yapılandırması.
 */
import { db } from './db';
import type { AuthUser } from './auth';
import { memberContext } from './permissions';
import { dmChannelFor, mapNotification, publicUser, serverDetail } from './serialize';
import type {
  Bootstrap,
  DmChannel,
  FriendsPayload,
  FriendRequest,
  IceServerConfig,
  MeUser,
  Notification,
  PublicUser,
  ServerDetail,
} from '../shared/types';

const USER_COLUMNS =
  'u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio, u.status, u.custom_status, u.created_at';

export function meUser(user: AuthUser): MeUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    status: user.status as MeUser['status'],
    customStatus: user.customStatus,
    createdAt: user.createdAt,
    bannerColor: user.bannerColor,
    bannerUrl: user.bannerUrl,
    featuredBadges: user.featuredBadges,
    email: user.email,
    theme: user.theme,
    settings: user.settings,
  };
}

export function friendsPayload(userId: string): FriendsPayload {
  const friends = (
    db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM friendships f JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? ORDER BY u.display_name COLLATE NOCASE`,
      )
      .all(userId) as PublicUser[]
  ).map((row) => publicUser(row as never)!).filter(Boolean);

  const incoming = (
    db
      .prepare(
        `SELECT fr.id, fr.created_at, ${USER_COLUMNS} FROM friend_requests fr
         JOIN users u ON u.id = fr.from_id
         WHERE fr.to_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`,
      )
      .all(userId) as (PublicUser & { id: string; created_at: number })[]
  ).map((row) => ({
    id: (row as unknown as { id: string }).id,
    user: publicUser(row as never)!,
    createdAt: (row as unknown as { created_at: number }).created_at,
  }));

  const outgoing = (
    db
      .prepare(
        `SELECT fr.id, fr.created_at, ${USER_COLUMNS} FROM friend_requests fr
         JOIN users u ON u.id = fr.to_id
         WHERE fr.from_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`,
      )
      .all(userId) as (PublicUser & { created_at: number })[]
  ).map((row) => ({
    id: (row as unknown as { id: string }).id,
    user: publicUser(row as never)!,
    createdAt: (row as unknown as { created_at: number }).created_at,
  }));

  const blocked = (
    db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM blocks b JOIN users u ON u.id = b.blocked_id
         WHERE b.user_id = ? ORDER BY b.created_at DESC`,
      )
      .all(userId) as PublicUser[]
  ).map((row) => publicUser(row as never)!).filter(Boolean);

  return { friends, incoming, outgoing, blocked };
}

export function notificationsFor(userId: string, limit = 40): Notification[] {
  return (
    db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as Parameters<typeof mapNotification>[0][]
  ).map(mapNotification);
}

export function unreadNotifications(userId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { c: number };
  return row.c;
}

export function dmsFor(userId: string): DmChannel[] {
  const rows = db
    .prepare(
      `SELECT d.id, MAX(m.created_at) AS last
       FROM dm_channels d JOIN dm_members dm ON dm.dm_id = d.id
       LEFT JOIN messages m ON m.dm_id = d.id AND m.deleted_at IS NULL
       WHERE dm.user_id = ?
       GROUP BY d.id
       ORDER BY COALESCE(last, d.created_at) DESC`,
    )
    .all(userId) as { id: string }[];
  return rows.map((r) => dmChannelFor(r.id, userId)).filter((d): d is DmChannel => d !== null);
}

export function serversFor(userId: string): ServerDetail[] {
  const rows = db
    .prepare('SELECT server_id FROM server_members WHERE user_id = ? ORDER BY joined_at ASC')
    .all(userId) as { server_id: string }[];
  const out: ServerDetail[] = [];
  for (const row of rows) {
    const ctx = memberContext(row.server_id, userId);
    if (ctx) out.push(serverDetail(ctx));
  }
  return out;
}

export function iceConfig(): { iceServers: IceServerConfig[]; turnConfigured: boolean } {
  const iceServers: IceServerConfig[] = [];
  const stun = process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
  for (const url of stun.split(',').map((s) => s.trim()).filter(Boolean)) {
    iceServers.push({ urls: url });
  }
  const turnUrls = (process.env.TURN_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;
  const turnConfigured = turnUrls.length > 0 && Boolean(turnUsername) && Boolean(turnCredential);
  if (turnConfigured) {
    iceServers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
  }
  return { iceServers, turnConfigured };
}

export function buildBootstrap(user: AuthUser): Bootstrap {
  const unread: Record<string, number> = {};
  const channelRows = db
    .prepare(
      `SELECT m.channel_id AS scope_id, COUNT(*) AS c
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = ?
       LEFT JOIN read_states rs ON rs.user_id = ? AND rs.scope_type = 'channel' AND rs.scope_id = m.channel_id
       WHERE m.deleted_at IS NULL AND m.author_id != ? AND m.created_at > COALESCE(rs.last_read_at, sm.joined_at)
       GROUP BY m.channel_id`,
    )
    .all(user.id, user.id, user.id) as { scope_id: string; c: number }[];
  for (const row of channelRows) unread[row.scope_id] = row.c;

  const dmRows = db
    .prepare(
      `SELECT m.dm_id AS scope_id, COUNT(*) AS c
       FROM messages m
       JOIN dm_members dm ON dm.dm_id = m.dm_id AND dm.user_id = ?
       WHERE m.deleted_at IS NULL AND m.author_id != ? AND m.created_at > COALESCE(dm.last_read_at, dm.joined_at)
       GROUP BY m.dm_id`,
    )
    .all(user.id, user.id) as { scope_id: string; c: number }[];
  for (const row of dmRows) unread[row.scope_id] = row.c;

  return {
    user: meUser(user),
    servers: serversFor(user.id),
    dms: dmsFor(user.id),
    friends: friendsPayload(user.id),
    notifications: notificationsFor(user.id),
    unread,
    voice: iceConfig(),
  };
}

export function friendRequest(id: string): FriendRequest | null {
  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(id) as
    | { id: string; from_id: string; created_at: number }
    | undefined;
  if (!row) return null;
  const user = publicUser(
    db
      .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`)
      .get(row.from_id) as never,
  );
  return user ? { id: row.id, user, createdAt: row.created_at } : null;
}
