/**
 * Mesaj servisi — kanal ve DM mesajlarının oluşturulması, yayını ve bildirimleri.
 * Yavaş mod, susturma, engelleme ve izin denetimleri burada uygulanır.
 */
import { db, newId, now } from './db';
import { ApiError, requireChannelAccess, getServerMembers } from './permissions';
import { PERMISSIONS } from '../shared/permissions';
import { mapMessage, messageColumns } from './serialize';
import { emitToChannel, emitToDm, emitToServer, notify } from './realtime';
import type { Message } from '../shared/types';

export function isBlockedBetween(a: string, b: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)')
      .get(a, b, b, a),
  );
}

export interface DmRow {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  icon_color: string;
  owner_id: string | null;
  created_at: number;
}

export function getDmRow(dmId: string): DmRow | null {
  return (db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId) as DmRow | undefined) ?? null;
}

export function assertDmMember(dmId: string, userId: string): DmRow {
  const dm = getDmRow(dmId);
  if (!dm) throw new ApiError(404, 'Sohbet bulunamadı.', 'DM_NOT_FOUND');
  const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(dmId, userId);
  if (!member) throw new ApiError(403, 'Bu sohbete erişiminiz yok.', 'NO_DM_ACCESS');
  return dm;
}

export interface CreateMessageInput {
  authorId: string;
  channelId?: string | null;
  dmId?: string | null;
  content: string;
  title?: string | null;
  parentId?: string | null;
  fileIds?: string[];
  poll?: { question: string; options: string[]; allowMultiple?: boolean; anonymous?: boolean } | null;
}

function upsertChannelRead(userId: string, channelId: string, at: number): void {
  db.prepare(
    `INSERT INTO read_states (user_id, scope_type, scope_id, last_read_at) VALUES (?, 'channel', ?, ?)
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  ).run(userId, channelId, at);
}

export function markDmRead(userId: string, dmId: string, at = now()): void {
  db.prepare('UPDATE dm_members SET last_read_at = ? WHERE dm_id = ? AND user_id = ?').run(at, dmId, userId);
}

export function createMessage(input: CreateMessageInput): Message {
  const content = (input.content ?? '').trim();
  const fileIds = input.fileIds ?? [];
  if (!content && fileIds.length === 0) {
    throw new ApiError(400, 'Mesaj içeriği boş olamaz.', 'EMPTY_MESSAGE');
  }
  if (content.length > 4000) {
    throw new ApiError(400, 'Mesaj 4000 karakteri aşamaz.', 'MESSAGE_TOO_LONG');
  }
  if (!input.channelId && !input.dmId) {
    throw new ApiError(400, 'Mesaj için kanal veya sohbet gerekli.', 'MISSING_SCOPE');
  }

  const stamp = now();
  const messageId = newId('msg');

  if (input.channelId) {
    const channelId = input.channelId;
    const { channel, ctx, permissions } = requireChannelAccess(input.authorId, channelId, PERMISSIONS.SEND_MESSAGES);
    const member = db
      .prepare('SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?')
      .get(channel.server_id, input.authorId) as { timeout_until: number | null } | undefined;
    if (member?.timeout_until && member.timeout_until > stamp) {
      throw new ApiError(403, 'Süreli susturma aktif olduğu için mesaj gönderemezsiniz.', 'TIMED_OUT');
    }
    if (channel.slowmode_seconds > 0 && (permissions & PERMISSIONS.MANAGE_MESSAGES) === 0) {
      const last = db
        .prepare('SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(channelId, input.authorId) as { created_at: number } | undefined;
      if (last && stamp - last.created_at < channel.slowmode_seconds * 1000) {
        const wait = Math.ceil((channel.slowmode_seconds * 1000 - (stamp - last.created_at)) / 1000);
        throw new ApiError(429, `Yavaş mod etkin: ${wait} saniye bekleyin.`, 'SLOWMODE');
      }
    }
    if (input.parentId) {
      const parent = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(input.parentId) as
        | { channel_id: string | null }
        | undefined;
      if (!parent || parent.channel_id !== channelId) {
        throw new ApiError(400, 'Yanıtlanan mesaj bu kanalda değil.', 'INVALID_PARENT');
      }
    }

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, channel_id, dm_id, author_id, content, title, parent_id, type, pinned, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'text', 0, ?)`,
      ).run(messageId, channelId, input.authorId, content, input.title ?? null, input.parentId ?? null, stamp);
      for (const fileId of fileIds) {
        const file = db.prepare('SELECT id, uploader_id FROM files WHERE id = ?').get(fileId) as
          | { id: string; uploader_id: string | null }
          | undefined;
        if (!file || file.uploader_id !== input.authorId) continue;
        db.prepare('INSERT OR IGNORE INTO message_files (message_id, file_id) VALUES (?, ?)').run(messageId, fileId);
      }
      if (input.poll && input.poll.options.length >= 2) {
        const pollId = newId('pol');
        db.prepare(
          'INSERT INTO polls (id, message_id, question, allow_multiple, anonymous, closes_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
        ).run(pollId, messageId, input.poll.question, input.poll.allowMultiple ? 1 : 0, input.poll.anonymous ? 1 : 0, stamp);
        input.poll.options.forEach((label, index) => {
          db.prepare('INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)').run(
            newId('pop'),
            pollId,
            label,
            index,
          );
        });
      }
      upsertChannelRead(input.authorId, channelId, stamp);
    });
    tx();

    const row = db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(messageId);
    const message = mapMessage(row as never, input.authorId);
    emitToChannel(channelId, 'message:create', message);
    emitToServer(channel.server_id, 'channel:activity', { channelId, messageId, at: stamp });
    notifyMentions({ message, content, serverId: channel.server_id, channelId, authorId: input.authorId });
    return message;
  }

  const dm = assertDmMember(input.dmId as string, input.authorId);
  const members = db.prepare('SELECT user_id FROM dm_members WHERE dm_id = ?').all(dm.id) as { user_id: string }[];
  for (const member of members) {
    if (member.user_id === input.authorId) continue;
    if (isBlockedBetween(member.user_id, input.authorId)) {
      throw new ApiError(403, 'Bu kullanıcıyla mesajlaşamazsınız.', 'BLOCKED');
    }
  }
  if (input.parentId) {
    const parent = db.prepare('SELECT dm_id FROM messages WHERE id = ?').get(input.parentId) as
      | { dm_id: string | null }
      | undefined;
    if (!parent || parent.dm_id !== dm.id) throw new ApiError(400, 'Yanıtlanan mesaj bu sohbette değil.', 'INVALID_PARENT');
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, channel_id, dm_id, author_id, content, title, parent_id, type, pinned, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, 'text', 0, ?)`,
    ).run(messageId, dm.id, input.authorId, content, input.title ?? null, input.parentId ?? null, stamp);
    for (const fileId of fileIds) {
      const file = db.prepare('SELECT id, uploader_id FROM files WHERE id = ?').get(fileId) as
        | { id: string; uploader_id: string | null }
        | undefined;
      if (!file || file.uploader_id !== input.authorId) continue;
      db.prepare('INSERT OR IGNORE INTO message_files (message_id, file_id) VALUES (?, ?)').run(messageId, fileId);
    }
    markDmRead(input.authorId, dm.id, stamp);
  });
  tx();

  const row = db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(messageId);
  const message = mapMessage(row as never, input.authorId);
  emitToDm(dm.id, 'message:create', message);
  for (const member of members) {
    if (member.user_id === input.authorId) continue;
    if (isBlockedBetween(member.user_id, input.authorId)) continue;
    const author = message.author;
    notify({
      userId: member.user_id,
      type: 'dm',
      title: `${author?.displayName ?? 'Yeni mesaj'}`,
      body: content.slice(0, 140) || 'Dosya gönderdi',
      dmId: dm.id,
      messageId,
      actorId: input.authorId,
    });
  }
  return message;
}

function notifyMentions(input: {
  message: Message;
  content: string;
  serverId: string;
  channelId: string;
  authorId: string;
}): void {
  if (!input.content) return;
  const members = getServerMembers(input.serverId);
  const author = input.message.author;
  const usernameMatches = new Set(
    [...input.content.matchAll(/@([a-zA-Z0-9_.\-]{2,32})/g)].map((m) => m[1].toLowerCase()),
  );
  const roleMatches = new Set([...input.content.matchAll(/@&([^\s@]{2,40})/g)].map((m) => m[1].toLowerCase()));
  const roles = db.prepare('SELECT id, name FROM roles WHERE server_id = ?').all(input.serverId) as {
    id: string;
    name: string;
  }[];
  const mentionedRoleIds = roles.filter((r) => roleMatches.has(r.name.toLowerCase())).map((r) => r.id);

  for (const member of members) {
    if (member.userId === input.authorId) continue;
    const byName = usernameMatches.has(member.username.toLowerCase());
    const byRole = member.roleIds.some((id) => mentionedRoleIds.includes(id));
    if (!byName && !byRole) continue;
    notify({
      userId: member.userId,
      type: 'mention',
      title: `${author?.displayName ?? 'Birisi'} sizi etiketledi`,
      body: input.content.slice(0, 140),
      serverId: input.serverId,
      channelId: input.channelId,
      messageId: input.message.id,
      actorId: input.authorId,
    });
  }
}
