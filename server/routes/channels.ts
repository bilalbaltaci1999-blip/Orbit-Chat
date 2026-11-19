/** Kanal ve mesaj API'leri: mesaj geçmişi, gönderme, düzenleme, tepki, pin, arama, dosya. */
import { Router, type Request } from 'express';
import { db, newId, now, UPLOAD_DIR } from '../db';
import { requireAuth } from '../auth';
import {
  ApiError,
  assertPermission,
  canViewChannel,
  getChannelRow,
  memberContext,
  requireChannelAccess,
  requireMemberContext,
} from '../permissions';
import { PERMISSIONS } from '../../shared/permissions';
import { mapChannel, mapMessage, messageColumns } from '../serialize';
import { emitToChannel, emitToDm, emitToServer } from '../realtime';
import { createMessage, markDmRead } from '../messageService';
import { rateLimit } from '../rateLimit';
import { color, int, oneOf, optionalStr, str } from '../validate';
import { canAccessFile, filePathFor, saveFile, upload } from '../storage';
import fs from 'node:fs';

const router = Router();
router.use(requireAuth);
const uid = (req: Request): string => req.user!.id;

/* ---------------------------------- kanallar --------------------------------- */

router.post('/servers/:serverId/channels', (req, res) => {
  const ctx = requireMemberContext(req.params.serverId, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_CHANNELS);
  const name = str(req.body?.name, 'Kanal adı', { min: 1, max: 48 }).toLowerCase().replace(/\s+/g, '-');
  const type = oneOf(req.body?.type, ['text', 'voice', 'forum', 'announcement'] as const, 'Kanal türü', 'text');
  const categoryId = optionalStr(req.body?.categoryId, 'Kategori', { max: 64 }) ?? null;
  const topic = optionalStr(req.body?.topic, 'Konu', { max: 200 }) ?? '';
  const isPrivate = req.body?.isPrivate === true;
  const channelId = newId('chn');
  const max = db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM channels WHERE server_id = ?').get(ctx.server.id) as { p: number };
  db.prepare(
    'INSERT INTO channels (id, server_id, category_id, name, topic, type, position, slowmode_seconds, is_private, created_at) VALUES (?,?,?,?,?,?,?,0,?,?)',
  ).run(channelId, ctx.server.id, categoryId, name, topic, type, max.p + 1, isPrivate ? 1 : 0, now());
  const channel = mapChannel(getChannelRow(channelId)!);
  emitToServer(ctx.server.id, 'channel:created', { serverId: ctx.server.id, channel });
  res.status(201).json({ channel });
});

router.patch('/channels/:channelId', (req, res) => {
  const { ctx, channel } = requireChannelAccess(uid(req), req.params.channelId, PERMISSIONS.MANAGE_CHANNELS);
  const fields: string[] = [];
  const values: unknown[] = [];
  if (req.body?.name !== undefined) {
    fields.push('name = ?');
    values.push(str(req.body.name, 'Kanal adı', { min: 1, max: 48 }).toLowerCase().replace(/\s+/g, '-'));
  }
  if (req.body?.topic !== undefined) {
    fields.push('topic = ?');
    values.push(optionalStr(req.body.topic, 'Konu', { max: 200 }) ?? '');
  }
  if (req.body?.slowmodeSeconds !== undefined) {
    fields.push('slowmode_seconds = ?');
    values.push(int(req.body.slowmodeSeconds, 'Yavaş mod', { min: 0, max: 21600, fallback: 0 }));
  }
  if (req.body?.isPrivate !== undefined) {
    fields.push('is_private = ?');
    values.push(req.body.isPrivate === true ? 1 : 0);
  }
  if (req.body?.categoryId !== undefined) {
    fields.push('category_id = ?');
    values.push(optionalStr(req.body.categoryId, 'Kategori', { max: 64 }) ?? null);
  }
  if (req.body?.position !== undefined) {
    fields.push('position = ?');
    values.push(int(req.body.position, 'Sıra', { min: 0, max: 1000 }));
  }
  if (fields.length === 0) throw new ApiError(400, 'Güncellenecek alan yok.', 'NO_FIELDS');
  db.prepare(`UPDATE channels SET ${fields.join(', ')} WHERE id = ?`).run(...values, channel.id);
  const updated = mapChannel(getChannelRow(channel.id)!);
  emitToServer(ctx.server.id, 'channel:updated', { serverId: ctx.server.id, channel: updated });
  res.json({ channel: updated });
});

router.delete('/channels/:channelId', (req, res) => {
  const { ctx, channel } = requireChannelAccess(uid(req), req.params.channelId, PERMISSIONS.MANAGE_CHANNELS);
  db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
  emitToServer(ctx.server.id, 'channel:deleted', { serverId: ctx.server.id, channelId: channel.id });
  res.json({ ok: true });
});

router.put('/channels/:channelId/overwrites', (req, res) => {
  const { ctx, channel } = requireChannelAccess(uid(req), req.params.channelId, PERMISSIONS.MANAGE_CHANNELS);
  const list = Array.isArray(req.body?.overwrites) ? req.body.overwrites : [];
  db.prepare('DELETE FROM channel_overwrites WHERE channel_id = ?').run(channel.id);
  for (const raw of list) {
    const item = raw as { targetType?: string; targetId?: string; allow?: number; deny?: number };
    const targetType = oneOf(item.targetType, ['role', 'member'] as const, 'Hedef türü');
    const targetId = str(item.targetId, 'Hedef', { min: 1, max: 64 });
    const allow = int(item.allow, 'İzin ver', { min: 0, max: 4194303, fallback: 0 });
    const deny = int(item.deny, 'Reddet', { min: 0, max: 4194303, fallback: 0 });
    db.prepare('INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES (?,?,?,?,?)').run(
      channel.id,
      targetType,
      targetId,
      allow,
      deny,
    );
  }
  emitToServer(ctx.server.id, 'channel:updated', { serverId: ctx.server.id, channel: mapChannel(channel) });
  res.json({ ok: true });
});

router.post('/channels/:channelId/read', (req, res) => {
  const { channel } = requireChannelAccess(uid(req), req.params.channelId);
  db.prepare(
    `INSERT INTO read_states (user_id, scope_type, scope_id, last_read_at) VALUES (?, 'channel', ?, ?)
     ON CONFLICT(user_id, scope_type, scope_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  ).run(uid(req), channel.id, now());
  res.json({ ok: true });
});

/* ---------------------------------- mesajlar --------------------------------- */

router.get('/channels/:channelId/messages', (req, res) => {
  const { channel, ctx } = requireChannelAccess(uid(req), req.params.channelId, PERMISSIONS.VIEW_CHANNEL);
  const before = req.query.before ? int(req.query.before, 'before', { min: 0, max: 9_999_999_999_999 }) : Number.MAX_SAFE_INTEGER;
  const limit = req.query.limit ? int(req.query.limit, 'limit', { min: 1, max: 100, fallback: 50 }) : 50;
  const rows = db
    .prepare(
      `SELECT ${messageColumns} FROM messages
       WHERE channel_id = ? AND deleted_at IS NULL AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channel.id, before, limit) as never[];
  void ctx;
  res.json({ messages: rows.reverse().map((row) => mapMessage(row, uid(req))) });
});

router.post(
  '/channels/:channelId/messages',
  rateLimit({ windowMs: 10_000, max: 20, message: 'Çok hızlı mesaj gönderiyorsunuz.' }),
  (req, res) => {
    const { channel } = requireChannelAccess(uid(req), String(req.params.channelId), PERMISSIONS.SEND_MESSAGES);
    const message = createMessage({
      authorId: uid(req),
      channelId: channel.id,
      content: optionalStr(req.body?.content, 'Mesaj', { max: 4000 }) ?? '',
      title: optionalStr(req.body?.title, 'Başlık', { max: 120 }),
      parentId: optionalStr(req.body?.parentId, 'Yanıt', { max: 64 }),
      fileIds: Array.isArray(req.body?.fileIds) ? (req.body.fileIds as unknown[]).map(String) : [],
      poll: req.body?.poll ?? null,
    });
    res.status(201).json({ message });
  },
);

router.get('/channels/:channelId/pins', (req, res) => {
  const { channel } = requireChannelAccess(uid(req), req.params.channelId);
  const rows = db
    .prepare(`SELECT ${messageColumns} FROM messages WHERE channel_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`)
    .all(channel.id) as never[];
  res.json({ messages: rows.map((row) => mapMessage(row, uid(req))) });
});

router.get('/channels/:channelId/topics', (req, res) => {
  const { channel } = requireChannelAccess(uid(req), req.params.channelId);
  const rows = db
    .prepare(
      `SELECT ${messageColumns} FROM messages
       WHERE channel_id = ? AND deleted_at IS NULL AND title IS NOT NULL AND parent_id IS NULL
       ORDER BY created_at DESC LIMIT 50`,
    )
    .all(channel.id) as never[];
  res.json({ topics: rows.map((row) => mapMessage(row, uid(req))) });
});

router.get('/messages/:messageId/thread', (req, res) => {
  const row = db.prepare('SELECT channel_id, dm_id FROM messages WHERE id = ?').get(req.params.messageId) as
    | { channel_id: string | null; dm_id: string | null }
    | undefined;
  if (!row) throw new ApiError(404, 'Mesaj bulunamadı.', 'MESSAGE_NOT_FOUND');
  if (row.channel_id) requireChannelAccess(uid(req), row.channel_id);
  else if (row.dm_id) {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(row.dm_id, uid(req));
    if (!member) throw new ApiError(403, 'Bu sohbete erişiminiz yok.', 'NO_DM_ACCESS');
  }
  const replies = db
    .prepare(`SELECT ${messageColumns} FROM messages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 100`)
    .all(req.params.messageId) as never[];
  res.json({ messages: replies.map((r) => mapMessage(r, uid(req))) });
});

router.patch('/messages/:messageId', (req, res) => {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.messageId) as
    | { id: string; channel_id: string | null; dm_id: string | null; author_id: string | null; content: string; created_at: number }
    | undefined;
  if (!row) throw new ApiError(404, 'Mesaj bulunamadı.', 'MESSAGE_NOT_FOUND');
  if (row.channel_id) {
    const { ctx, permissions } = requireChannelAccess(uid(req), row.channel_id, PERMISSIONS.VIEW_CHANNEL);
    if (row.author_id !== uid(req)) assertPermission(permissions, PERMISSIONS.MANAGE_MESSAGES);
    void ctx;
  } else if (row.dm_id) {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(row.dm_id, uid(req));
    if (!member || row.author_id !== uid(req)) throw new ApiError(403, 'Bu mesajı düzenleyemezsiniz.', 'FORBIDDEN');
  }
  const content = str(req.body?.content, 'Mesaj', { min: 1, max: 4000 });
  db.prepare('INSERT INTO message_edits (id, message_id, old_content, edited_at) VALUES (?,?,?,?)').run(
    newId('med'),
    row.id,
    row.content,
    now(),
  );
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now(), row.id);
  const updated = mapMessage(db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(row.id) as never, uid(req));
  if (row.channel_id) emitToChannel(row.channel_id, 'message:update', updated);
  else if (row.dm_id) emitToDm(row.dm_id, 'message:update', updated);
  res.json({ message: updated });
});

router.delete('/messages/:messageId', (req, res) => {
  const row = db.prepare('SELECT id, channel_id, dm_id, author_id FROM messages WHERE id = ?').get(req.params.messageId) as
    | { id: string; channel_id: string | null; dm_id: string | null; author_id: string | null }
    | undefined;
  if (!row) throw new ApiError(404, 'Mesaj bulunamadı.', 'MESSAGE_NOT_FOUND');
  if (row.channel_id) {
    const { permissions } = requireChannelAccess(uid(req), row.channel_id, PERMISSIONS.VIEW_CHANNEL);
    if (row.author_id !== uid(req)) assertPermission(permissions, PERMISSIONS.MANAGE_MESSAGES);
  } else if (row.dm_id) {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(row.dm_id, uid(req));
    if (!member || row.author_id !== uid(req)) throw new ApiError(403, 'Bu mesajı silemezsiniz.', 'FORBIDDEN');
  }
  db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(now(), row.id);
  if (row.channel_id) emitToChannel(row.channel_id, 'message:delete', { messageId: row.id, channelId: row.channel_id });
  else if (row.dm_id) emitToDm(row.dm_id, 'message:delete', { messageId: row.id, dmId: row.dm_id });
  res.json({ ok: true });
});

router.post('/messages/:messageId/reactions', (req, res) => {
  const row = db.prepare('SELECT id, channel_id, dm_id FROM messages WHERE id = ?').get(req.params.messageId) as
    | { id: string; channel_id: string | null; dm_id: string | null }
    | undefined;
  if (!row) throw new ApiError(404, 'Mesaj bulunamadı.', 'MESSAGE_NOT_FOUND');
  if (row.channel_id) requireChannelAccess(uid(req), row.channel_id, PERMISSIONS.ADD_REACTIONS);
  else if (row.dm_id) {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(row.dm_id, uid(req));
    if (!member) throw new ApiError(403, 'Bu sohbete erişiminiz yok.', 'NO_DM_ACCESS');
  }
  const emoji = str(req.body?.emoji, 'Emoji', { min: 1, max: 32 });
  const existing = db
    .prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(row.id, uid(req), emoji);
  if (existing) db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(row.id, uid(req), emoji);
  else db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)').run(row.id, uid(req), emoji, now());
  const updated = mapMessage(db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(row.id) as never, uid(req));
  if (row.channel_id) emitToChannel(row.channel_id, 'message:update', updated);
  else if (row.dm_id) emitToDm(row.dm_id, 'message:update', updated);
  res.json({ message: updated });
});

router.post('/messages/:messageId/pin', (req, res) => {
  const row = db.prepare('SELECT id, channel_id, pinned FROM messages WHERE id = ?').get(req.params.messageId) as
    | { id: string; channel_id: string | null; pinned: number }
    | undefined;
  if (!row || !row.channel_id) throw new ApiError(404, 'Mesaj bulunamadı.', 'MESSAGE_NOT_FOUND');
  const { permissions } = requireChannelAccess(uid(req), row.channel_id, PERMISSIONS.VIEW_CHANNEL);
  assertPermission(permissions, PERMISSIONS.PIN_MESSAGES);
  const pinned = row.pinned === 1 ? 0 : 1;
  db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned, row.id);
  const updated = mapMessage(db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(row.id) as never, uid(req));
  emitToChannel(row.channel_id, 'message:update', updated);
  res.json({ message: updated });
});

router.post('/messages/:messageId/vote', (req, res) => {
  const messageId = req.params.messageId;
  const row = db.prepare('SELECT channel_id, dm_id FROM messages WHERE id = ?').get(messageId) as
    | { channel_id: string | null; dm_id: string | null }
    | undefined;
  if (!row) throw new ApiError(404, 'Mesaj bulunamadı.', 'MESSAGE_NOT_FOUND');
  if (row.channel_id) requireChannelAccess(uid(req), row.channel_id);
  else if (row.dm_id) {
    const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(row.dm_id, uid(req));
    if (!member) throw new ApiError(403, 'Bu sohbete erişiminiz yok.', 'NO_DM_ACCESS');
  }
  const poll = db.prepare('SELECT id, allow_multiple FROM polls WHERE message_id = ?').get(messageId) as
    | { id: string; allow_multiple: number }
    | undefined;
  if (!poll) throw new ApiError(404, 'Anket bulunamadı.', 'POLL_NOT_FOUND');
  const optionId = str(req.body?.optionId, 'Seçenek', { min: 1, max: 64 });
  const option = db.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, poll.id);
  if (!option) throw new ApiError(400, 'Geçersiz seçenek.', 'INVALID_OPTION');
  const existing = db
    .prepare('SELECT 1 FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?')
    .get(poll.id, optionId, uid(req));
  if (existing) db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?').run(poll.id, optionId, uid(req));
  else {
    if (poll.allow_multiple === 0) db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, uid(req));
    db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?,?,?)').run(poll.id, optionId, uid(req));
  }
  const updated = mapMessage(db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(messageId) as never, uid(req));
  if (row.channel_id) emitToChannel(row.channel_id, 'message:update', updated);
  else if (row.dm_id) emitToDm(row.dm_id, 'message:update', updated);
  res.json({ message: updated });
});

/* ----------------------------------- arama ----------------------------------- */

router.get('/search', (req, res) => {
  const q = str(req.query.q, 'Arama', { min: 1, max: 100 });
  const serverId = optionalStr(req.query.serverId, 'Sunucu', { max: 64 });
  const channelId = optionalStr(req.query.channelId, 'Kanal', { max: 64 });
  const params: unknown[] = [`%${q}%`, uid(req)];
  let sql = `SELECT ${messageColumns} FROM messages m
    JOIN channels c ON c.id = m.channel_id
    JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = ?
    WHERE m.deleted_at IS NULL AND m.content LIKE ?`;
  params.reverse();
  if (serverId) {
    sql += ' AND c.server_id = ?';
    params.push(serverId);
  }
  if (channelId) {
    sql += ' AND m.channel_id = ?';
    params.push(channelId);
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 50';
  const rows = db.prepare(sql).all(...params) as { channel_id: string | null }[];
  const visible = rows.filter((row) => {
    if (!row.channel_id) return false;
    const channel = getChannelRow(row.channel_id);
    if (!channel) return false;
    const ctx = memberContext(channel.server_id, uid(req));
    return ctx ? canViewChannel(ctx, channel) : false;
  });
  res.json({ messages: visible.map((row) => mapMessage(row as never, uid(req))) });
});

/* ----------------------------------- dosyalar -------------------------------- */

router.post(
  '/files',
  rateLimit({ windowMs: 60_000, max: 30, message: 'Çok fazla dosya yüklediniz.' }),
  upload.single('file'),
  (req, res) => {
    const file = req.file;
    if (!file) throw new ApiError(400, 'Dosya seçilmedi.', 'NO_FILE');
    const channelId = optionalStr(req.body?.channelId, 'Kanal', { max: 64 });
    if (channelId) requireChannelAccess(uid(req), channelId, PERMISSIONS.SEND_FILES);
    const stored = saveFile({ buffer: file.buffer, originalName: file.originalname, mime: file.mimetype, uploaderId: uid(req) });
    res.status(201).json({
      file: { id: stored.id, name: stored.name, mime: stored.mime, size: stored.size, url: `/api/files/${stored.id}` },
    });
  },
);

router.get('/files/:id', (req, res) => {
  if (!canAccessFile(req.params.id, uid(req))) throw new ApiError(403, 'Bu dosyaya erişiminiz yok.', 'NO_FILE_ACCESS');
  const info = filePathFor(req.params.id);
  if (!info) throw new ApiError(404, 'Dosya bulunamadı.', 'FILE_NOT_FOUND');
  res.setHeader('Content-Type', info.mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(info.name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(info.absolute).pipe(res);
});

void UPLOAD_DIR;
void color;
void markDmRead;

export default router;
