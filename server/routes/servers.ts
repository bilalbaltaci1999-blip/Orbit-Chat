/** Sunucu (topluluk) yönetimi: oluşturma, roller, üyeler, moderasyon, davetler, etkinlikler. */
import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { db, newId, now } from '../db';
import { requireAuth } from '../auth';
import {
  ApiError,
  assertHierarchy,
  assertPermission,
  getServerRow,
  memberContext,
  requireMemberContext,
} from '../permissions';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '../../shared/permissions';
import { getServerMembers, getUser, mapEvent, mapModLog, mapRole, mapServer, serverDetail } from '../serialize';
import { disconnectUserSockets, emitToServer, emitToUser, getVoiceState, notify } from '../realtime';
import { color, int, oneOf, optionalStr, str } from '../validate';

const router = Router();
router.use(requireAuth);

const uid = (req: Request): string => req.user!.id;

function modLog(serverId: string, actorId: string, targetId: string | null, action: string, reason: string, expiresAt?: number): void {
  db.prepare(
    'INSERT INTO mod_actions (id, server_id, actor_id, target_id, action, reason, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(newId('mod'), serverId, actorId, targetId, action, reason, now(), expiresAt ?? null);
}

export function joinServer(serverId: string, userId: string): boolean {
  const existing = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  if (existing) return false;
  const banned = db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  if (banned) throw new ApiError(403, 'Bu topluluktan yasaklandınız.', 'BANNED');
  db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(serverId, userId, now());
  emitToServer(serverId, 'server:member_add', { serverId, member: getServerMembers(serverId).find((m) => m.userId === userId) ?? null });
  emitToUser(userId, 'server:joined', { serverId });
  return true;
}

/* --------------------------------- listeleme --------------------------------- */

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.* FROM servers s JOIN server_members m ON m.server_id = s.id
       WHERE m.user_id = ? ORDER BY m.joined_at ASC`,
    )
    .all(uid(req)) as Parameters<typeof mapServer>[0][];
  res.json({ servers: rows.map(mapServer) });
});

router.post('/', (req, res) => {
  const name = str(req.body?.name, 'Sunucu adı', { min: 2, max: 64 });
  const description = optionalStr(req.body?.description, 'Açıklama', { max: 300 }) ?? '';
  const iconColor = color(req.body?.iconColor, 'Sunucu rengi', '#7c5cff');
  const isPublic = req.body?.isPublic === true;
  const serverId = newId('srv');
  const stamp = now();
  const everyoneId = newId('rol');
  const adminRoleId = newId('rol');
  const categoryId = newId('cat');
  const textId = newId('chn');
  const voiceId = newId('chn');
  const forumId = newId('chn');

  db.transaction(() => {
    db.prepare(
      'INSERT INTO servers (id, name, description, icon_color, owner_id, is_public, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(serverId, name, description, iconColor, uid(req), isPublic ? 1 : 0, stamp);
    db.prepare(
      'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, created_at) VALUES (?,?,?,?,?,?,1,?)',
    ).run(everyoneId, serverId, '@everyone', '#9aa0b4', 0, DEFAULT_EVERYONE_PERMISSIONS, stamp);
    db.prepare(
      'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, created_at) VALUES (?,?,?,?,?,?,0,?)',
    ).run(adminRoleId, serverId, 'Yönetici', '#7c5cff', 100, ALL_PERMISSIONS, stamp);
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(serverId, uid(req), stamp);
    db.prepare('INSERT INTO member_roles (user_id, role_id, server_id) VALUES (?,?,?)').run(uid(req), adminRoleId, serverId);
    db.prepare('INSERT INTO channel_categories (id, server_id, name, position) VALUES (?,?,?,0)').run(categoryId, serverId, 'GENEL');
    db.prepare(
      'INSERT INTO channels (id, server_id, category_id, name, topic, type, position, slowmode_seconds, is_private, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)',
    ).run(textId, serverId, categoryId, 'genel', 'ORBIT topluluğuna hoş geldiniz!', 'text', 0, stamp);
    db.prepare(
      'INSERT INTO channels (id, server_id, category_id, name, topic, type, position, slowmode_seconds, is_private, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)',
    ).run(voiceId, serverId, categoryId, 'Genel Sohbet', '', 'voice', 1, stamp);
    db.prepare(
      'INSERT INTO channels (id, server_id, category_id, name, topic, type, position, slowmode_seconds, is_private, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)',
    ).run(forumId, serverId, categoryId, 'duyurular', 'Topluluk duyuruları', 'forum', 2, stamp);
  })();

  const ctx = requireMemberContext(serverId, uid(req));
  res.status(201).json({ server: serverDetail(ctx) });
});

router.get('/:id', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  res.json({ server: serverDetail(ctx) });
});

router.patch('/:id', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_SERVER);
  const fields: string[] = [];
  const values: unknown[] = [];
  if (req.body?.name !== undefined) {
    fields.push('name = ?');
    values.push(str(req.body.name, 'Sunucu adı', { min: 2, max: 64 }));
  }
  if (req.body?.description !== undefined) {
    fields.push('description = ?');
    values.push(optionalStr(req.body.description, 'Açıklama', { max: 300 }) ?? '');
  }
  if (req.body?.iconColor !== undefined) {
    fields.push('icon_color = ?');
    values.push(color(req.body.iconColor, 'Renk'));
  }
  if (req.body?.isPublic !== undefined) {
    fields.push('is_public = ?');
    values.push(req.body.isPublic === true ? 1 : 0);
  }
  if (fields.length === 0) throw new ApiError(400, 'Güncellenecek alan yok.', 'NO_FIELDS');
  db.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).run(...values, ctx.server.id);
  emitToServer(ctx.server.id, 'server:update', { server: mapServer(getServerRow(ctx.server.id)!) });
  res.json({ server: serverDetail(requireMemberContext(ctx.server.id, uid(req))) });
});

router.delete('/:id', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  if (!ctx.isOwner) throw new ApiError(403, 'Sunucuyu yalnızca sahibi silebilir.', 'OWNER_ONLY');
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(ctx.server.id) as { user_id: string }[];
  db.prepare('DELETE FROM servers WHERE id = ?').run(ctx.server.id);
  for (const m of members) emitToUser(m.user_id, 'server:deleted', { serverId: ctx.server.id });
  res.json({ ok: true });
});

router.post('/:id/leave', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  if (ctx.isOwner) throw new ApiError(400, 'Sahip sunucudan ayrılamaz; önce sahipliği devredin veya sunucuyu silin.', 'OWNER_CANNOT_LEAVE');
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(ctx.server.id, uid(req));
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(ctx.server.id, uid(req));
  emitToServer(ctx.server.id, 'server:member_remove', { serverId: ctx.server.id, userId: uid(req) });
  emitToUser(uid(req), 'server:left', { serverId: ctx.server.id });
  res.json({ ok: true });
});

router.post('/:id/transfer', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  if (!ctx.isOwner) throw new ApiError(403, 'Sahiplik yalnızca mevcut sahip tarafından devredilebilir.', 'OWNER_ONLY');
  const targetId = str(req.body?.userId, 'Kullanıcı', { min: 1, max: 64 });
  const target = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(ctx.server.id, targetId);
  if (!target) throw new ApiError(400, 'Kullanıcı bu sunucunun üyesi değil.', 'NOT_MEMBER');
  db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(targetId, ctx.server.id);
  modLog(ctx.server.id, uid(req), targetId, 'transfer_ownership', 'Sahiplik devredildi');
  emitToServer(ctx.server.id, 'server:update', { server: mapServer(getServerRow(ctx.server.id)!) });
  res.json({ ok: true });
});

/* ---------------------------------- üyeler ---------------------------------- */

router.get('/:id/members', (req, res) => {
  requireMemberContext(req.params.id, uid(req));
  res.json({ members: getServerMembers(req.params.id) });
});

router.patch('/:id/members/:userId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  const targetId = req.params.userId;
  if (targetId !== uid(req)) assertPermission(ctx.permissions, PERMISSIONS.MANAGE_MEMBERS);
  const nickname = optionalStr(req.body?.nickname, 'Takma ad', { max: 32 });
  db.prepare('UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?').run(
    nickname || null,
    ctx.server.id,
    targetId,
  );
  emitToServer(ctx.server.id, 'server:member_update', { serverId: ctx.server.id, member: getServerMembers(ctx.server.id).find((m) => m.userId === targetId) });
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.KICK_MEMBERS);
  assertHierarchy(ctx, req.params.userId);
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(ctx.server.id, req.params.userId);
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(ctx.server.id, req.params.userId);
  modLog(ctx.server.id, uid(req), req.params.userId, 'kick', String(req.body?.reason ?? ''));
  emitToServer(ctx.server.id, 'server:member_remove', { serverId: ctx.server.id, userId: req.params.userId });
  emitToUser(req.params.userId, 'server:removed', { serverId: ctx.server.id });
  res.json({ ok: true });
});

router.post('/:id/members/:userId/timeout', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.TIMEOUT_MEMBERS);
  assertHierarchy(ctx, req.params.userId);
  const minutes = int(req.body?.minutes, 'Süre', { min: 0, max: 10080, fallback: 0 });
  const until = minutes > 0 ? now() + minutes * 60_000 : null;
  db.prepare('UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?').run(until, ctx.server.id, req.params.userId);
  modLog(ctx.server.id, uid(req), req.params.userId, minutes > 0 ? 'timeout' : 'timeout_remove', String(req.body?.reason ?? ''), until ?? undefined);
  emitToServer(ctx.server.id, 'server:member_update', { serverId: ctx.server.id, member: getServerMembers(ctx.server.id).find((m) => m.userId === req.params.userId) });
  res.json({ ok: true, timeoutUntil: until });
});

router.post('/:id/members/:userId/roles', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_ROLES);
  assertHierarchy(ctx, req.params.userId);
  const roleIds = Array.isArray(req.body?.roleIds) ? (req.body.roleIds as unknown[]).map(String) : [];
  const valid = db.prepare('SELECT id FROM roles WHERE server_id = ?').all(ctx.server.id) as { id: string }[];
  const allowed = new Set(valid.map((r) => r.id));
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(ctx.server.id, req.params.userId);
  for (const roleId of roleIds) {
    if (!allowed.has(roleId)) continue;
    db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, server_id) VALUES (?,?,?)').run(req.params.userId, roleId, ctx.server.id);
  }
  emitToServer(ctx.server.id, 'server:member_update', { serverId: ctx.server.id, member: getServerMembers(ctx.server.id).find((m) => m.userId === req.params.userId) });
  res.json({ ok: true });
});

/* ---------------------------------- yasaklar --------------------------------- */

router.get('/:id/bans', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.BAN_MEMBERS);
  const rows = db
    .prepare('SELECT user_id, reason, created_at FROM bans WHERE server_id = ? ORDER BY created_at DESC')
    .all(ctx.server.id) as { user_id: string; reason: string; created_at: number }[];
  res.json({
    bans: rows.map((r) => ({ user: getUser(r.user_id), reason: r.reason, createdAt: r.created_at })),
  });
});

router.post('/:id/bans', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.BAN_MEMBERS);
  const targetId = str(req.body?.userId, 'Kullanıcı', { min: 1, max: 64 });
  if (targetId === ctx.server.owner_id) throw new ApiError(403, 'Sunucu sahibi yasaklanamaz.', 'CANNOT_BAN_OWNER');
  assertHierarchy(ctx, targetId);
  const reason = optionalStr(req.body?.reason, 'Sebep', { max: 300 }) ?? '';
  db.prepare('INSERT OR REPLACE INTO bans (server_id, user_id, reason, banned_by, created_at) VALUES (?,?,?,?,?)').run(
    ctx.server.id,
    targetId,
    reason,
    uid(req),
    now(),
  );
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(ctx.server.id, targetId);
  db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(ctx.server.id, targetId);
  modLog(ctx.server.id, uid(req), targetId, 'ban', reason);
  emitToServer(ctx.server.id, 'server:member_remove', { serverId: ctx.server.id, userId: targetId });
  emitToUser(targetId, 'server:banned', { serverId: ctx.server.id });
  disconnectUserSockets(targetId);
  res.json({ ok: true });
});

router.delete('/:id/bans/:userId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.BAN_MEMBERS);
  db.prepare('DELETE FROM bans WHERE server_id = ? AND user_id = ?').run(ctx.server.id, req.params.userId);
  modLog(ctx.server.id, uid(req), req.params.userId, 'unban', '');
  res.json({ ok: true });
});

/* ----------------------------------- roller ---------------------------------- */

router.get('/:id/roles', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  const rows = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC').all(ctx.server.id) as never[];
  res.json({ roles: rows.map((r) => mapRole(r)) });
});

router.post('/:id/roles', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_ROLES);
  const name = str(req.body?.name, 'Rol adı', { min: 1, max: 32 });
  const roleColor = color(req.body?.color, 'Rol rengi', '#7c5cff');
  const permissions = int(req.body?.permissions, 'İzinler', { min: 0, max: ALL_PERMISSIONS, fallback: 0 });
  const icon = optionalStr(req.body?.icon, 'Simge', { max: 4 });
  const roleId = newId('rol');
  const max = db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM roles WHERE server_id = ?').get(ctx.server.id) as { p: number };
  db.prepare(
    'INSERT INTO roles (id, server_id, name, color, icon, position, permissions, is_default, created_at) VALUES (?,?,?,?,?,?,?,0,?)',
  ).run(roleId, ctx.server.id, name, roleColor, icon ?? null, max.p + 1, permissions, now());
  emitToServer(ctx.server.id, 'server:roles_update', { serverId: ctx.server.id });
  res.status(201).json({ role: mapRole(db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) as never) });
});

router.patch('/:id/roles/:roleId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_ROLES);
  const row = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, ctx.server.id) as
    | { id: string; is_default: number; position: number }
    | undefined;
  if (!row) throw new ApiError(404, 'Rol bulunamadı.', 'ROLE_NOT_FOUND');
  const fields: string[] = [];
  const values: unknown[] = [];
  if (req.body?.name !== undefined) {
    fields.push('name = ?');
    values.push(str(req.body.name, 'Rol adı', { min: 1, max: 32 }));
  }
  if (req.body?.color !== undefined) {
    fields.push('color = ?');
    values.push(color(req.body.color, 'Rol rengi'));
  }
  if (req.body?.icon !== undefined) {
    fields.push('icon = ?');
    values.push(optionalStr(req.body.icon, 'Simge', { max: 4 }) ?? null);
  }
  if (req.body?.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(int(req.body.permissions, 'İzinler', { min: 0, max: ALL_PERMISSIONS }));
  }
  if (req.body?.position !== undefined) {
    fields.push('position = ?');
    values.push(int(req.body.position, 'Sıra', { min: 0, max: 1000 }));
  }
  if (fields.length === 0) throw new ApiError(400, 'Güncellenecek alan yok.', 'NO_FIELDS');
  db.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`).run(...values, row.id);
  emitToServer(ctx.server.id, 'server:roles_update', { serverId: ctx.server.id });
  res.json({ role: mapRole(db.prepare('SELECT * FROM roles WHERE id = ?').get(row.id) as never) });
});

router.delete('/:id/roles/:roleId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_ROLES);
  const row = db.prepare('SELECT is_default FROM roles WHERE id = ? AND server_id = ?').get(req.params.roleId, ctx.server.id) as
    | { is_default: number }
    | undefined;
  if (!row) throw new ApiError(404, 'Rol bulunamadı.', 'ROLE_NOT_FOUND');
  if (row.is_default === 1) throw new ApiError(400, '@everyone rolü silinemez.', 'DEFAULT_ROLE');
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.roleId);
  emitToServer(ctx.server.id, 'server:roles_update', { serverId: ctx.server.id });
  res.json({ ok: true });
});

/* -------------------------------- kategoriler -------------------------------- */

router.post('/:id/categories', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_CHANNELS);
  const name = str(req.body?.name, 'Kategori adı', { min: 1, max: 48 });
  const categoryId = newId('cat');
  db.prepare('INSERT INTO channel_categories (id, server_id, name, position) VALUES (?,?,?,?)').run(categoryId, ctx.server.id, name, now());
  emitToServer(ctx.server.id, 'server:channels_update', { serverId: ctx.server.id });
  res.status(201).json({ category: { id: categoryId, serverId: ctx.server.id, name, position: 0 } });
});

router.patch('/:id/categories/:categoryId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_CHANNELS);
  const name = str(req.body?.name, 'Kategori adı', { min: 1, max: 48 });
  db.prepare('UPDATE channel_categories SET name = ? WHERE id = ? AND server_id = ?').run(name, req.params.categoryId, ctx.server.id);
  emitToServer(ctx.server.id, 'server:channels_update', { serverId: ctx.server.id });
  res.json({ ok: true });
});

router.delete('/:id/categories/:categoryId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_CHANNELS);
  db.prepare('DELETE FROM channel_categories WHERE id = ? AND server_id = ?').run(req.params.categoryId, ctx.server.id);
  emitToServer(ctx.server.id, 'server:channels_update', { serverId: ctx.server.id });
  res.json({ ok: true });
});

/* ----------------------------------- davetler -------------------------------- */

router.get('/:id/invites', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.CREATE_INVITES);
  const rows = db
    .prepare('SELECT code, uses, max_uses, expires_at, created_at FROM invites WHERE server_id = ? ORDER BY created_at DESC')
    .all(ctx.server.id) as { code: string; uses: number; max_uses: number | null; expires_at: number | null; created_at: number }[];
  res.json({
    invites: rows.map((r) => ({ code: r.code, uses: r.uses, maxUses: r.max_uses, expiresAt: r.expires_at, createdAt: r.created_at })),
  });
});

router.post('/:id/invites', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.CREATE_INVITES);
  const channelId = optionalStr(req.body?.channelId, 'Kanal', { max: 64 }) ?? null;
  const maxUses = req.body?.maxUses !== undefined ? int(req.body.maxUses, 'Kullanım', { min: 0, max: 1000, fallback: 0 }) : null;
  const expiresInHours = req.body?.expiresInHours !== undefined ? int(req.body.expiresInHours, 'Süre', { min: 0, max: 720, fallback: 0 }) : 0;
  const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'a').slice(0, 8);
  db.prepare('INSERT INTO invites (code, server_id, channel_id, creator_id, uses, max_uses, expires_at, created_at) VALUES (?,?,?,?,0,?,?,?)').run(
    code,
    ctx.server.id,
    channelId,
    uid(req),
    maxUses && maxUses > 0 ? maxUses : null,
    expiresInHours > 0 ? now() + expiresInHours * 3_600_000 : null,
    now(),
  );
  res.status(201).json({ invite: { code, uses: 0, maxUses, expiresAt: expiresInHours > 0 ? now() + expiresInHours * 3_600_000 : null } });
});

router.delete('/:id/invites/:code', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.CREATE_INVITES);
  db.prepare('DELETE FROM invites WHERE code = ? AND server_id = ?').run(req.params.code, ctx.server.id);
  res.json({ ok: true });
});

/* ------------------------------------ ses ------------------------------------ */

router.get('/:id/voice', (req, res) => {
  requireMemberContext(req.params.id, uid(req));
  res.json({ voice: getVoiceState(req.params.id) });
});

/* -------------------------------- moderasyon --------------------------------- */

router.get('/:id/mod-log', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.VIEW_AUDIT_LOG);
  const rows = db
    .prepare('SELECT id, action, actor_id, target_id, reason, created_at FROM mod_actions WHERE server_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(ctx.server.id) as never[];
  res.json({ entries: rows.map((r) => mapModLog(r)) });
});

router.get('/:id/reports', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_SERVER);
  const rows = db
    .prepare(
      `SELECT r.id, r.reason, r.status, r.created_at, r.message_id, r.target_user_id, u.display_name AS reporter
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.server_id = ? ORDER BY r.created_at DESC LIMIT 100`,
    )
    .all(ctx.server.id) as { id: string; reason: string; status: string; created_at: number; message_id: string | null; target_user_id: string | null; reporter: string | null }[];
  res.json({ reports: rows });
});

router.post('/:id/reports', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  const reason = str(req.body?.reason, 'Şikâyet sebebi', { min: 3, max: 500 });
  const targetUserId = optionalStr(req.body?.targetUserId, 'Hedef kullanıcı', { max: 64 }) ?? null;
  const messageId = optionalStr(req.body?.messageId, 'Mesaj', { max: 64 }) ?? null;
  db.prepare(
    'INSERT INTO reports (id, reporter_id, target_user_id, server_id, message_id, reason, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(newId('rep'), uid(req), targetUserId, ctx.server.id, messageId, reason, 'open', now());
  const owners = db
    .prepare(
      `SELECT DISTINCT mr.user_id FROM member_roles mr JOIN roles r ON r.id = mr.role_id
       WHERE mr.server_id = ? AND (r.permissions & ?) != 0`,
    )
    .all(ctx.server.id, PERMISSIONS.MANAGE_SERVER) as { user_id: string }[];
  const ownerId = getServerRow(ctx.server.id)?.owner_id;
  const recipients = new Set(owners.map((o) => o.user_id));
  if (ownerId) recipients.add(ownerId);
  for (const userId of recipients) {
    notify({ userId, type: 'system', title: 'Yeni şikâyet', body: reason.slice(0, 140), serverId: ctx.server.id, actorId: uid(req) });
  }
  res.status(201).json({ ok: true });
});

router.patch('/:id/reports/:reportId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_SERVER);
  const status = oneOf(req.body?.status, ['open', 'resolved', 'dismissed'] as const, 'Durum');
  db.prepare('UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND server_id = ?').run(
    status,
    now(),
    uid(req),
    req.params.reportId,
    ctx.server.id,
  );
  res.json({ ok: true });
});

/* --------------------------------- istatistik -------------------------------- */

router.get('/:id/stats', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  const members = db.prepare('SELECT COUNT(*) AS c FROM server_members WHERE server_id = ?').get(ctx.server.id) as { c: number };
  const channels = db.prepare('SELECT COUNT(*) AS c FROM channels WHERE server_id = ?').get(ctx.server.id) as { c: number };
  const messages = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m JOIN channels c ON c.id = m.channel_id
       WHERE c.server_id = ? AND m.created_at > ? AND m.deleted_at IS NULL`,
    )
    .get(ctx.server.id, now() - 86_400_000) as { c: number };
  res.json({ stats: { members: members.c, channels: channels.c, messages24h: messages.c } });
});

/* --------------------------------- webhooklar -------------------------------- */

router.get('/:id/webhooks', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_WEBHOOKS);
  const rows = db
    .prepare('SELECT id, channel_id, name, token, created_at FROM webhooks WHERE server_id = ? ORDER BY created_at DESC')
    .all(ctx.server.id) as { id: string; channel_id: string; name: string; token: string; created_at: number }[];
  res.json({ webhooks: rows.map((r) => ({ id: r.id, channelId: r.channel_id, name: r.name, token: r.token, createdAt: r.created_at })) });
});

router.post('/:id/webhooks', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_WEBHOOKS);
  const name = str(req.body?.name, 'Webhook adı', { min: 1, max: 32 });
  const channelId = str(req.body?.channelId, 'Kanal', { min: 1, max: 64 });
  const channel = db.prepare('SELECT id FROM channels WHERE id = ? AND server_id = ?').get(channelId, ctx.server.id);
  if (!channel) throw new ApiError(400, 'Kanal bu sunucuda değil.', 'INVALID_CHANNEL');
  const webhookId = newId('whk');
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO webhooks (id, server_id, channel_id, name, token, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(
    webhookId,
    ctx.server.id,
    channelId,
    name,
    token,
    uid(req),
    now(),
  );
  res.status(201).json({ webhook: { id: webhookId, channelId, name, token } });
});

router.delete('/:id/webhooks/:webhookId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_WEBHOOKS);
  db.prepare('DELETE FROM webhooks WHERE id = ? AND server_id = ?').run(req.params.webhookId, ctx.server.id);
  res.json({ ok: true });
});

/* ---------------------------------- etkinlik --------------------------------- */

router.get('/:id/events', (req, res) => {
  requireMemberContext(req.params.id, uid(req));
  const rows = db
    .prepare('SELECT id, server_id, channel_id, title, description, starts_at, ends_at, created_by FROM server_events WHERE server_id = ? ORDER BY starts_at ASC LIMIT 50')
    .all(req.params.id) as never[];
  res.json({ events: rows.map((r) => mapEvent(r)) });
});

router.post('/:id/events', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_EVENTS);
  const title = str(req.body?.title, 'Etkinlik adı', { min: 2, max: 80 });
  const description = optionalStr(req.body?.description, 'Açıklama', { max: 500 }) ?? '';
  const startsAt = int(req.body?.startsAt, 'Başlangıç', { min: 0, max: 9_999_999_999_999 });
  const endsAt = req.body?.endsAt !== undefined ? int(req.body.endsAt, 'Bitiş', { min: 0, max: 9_999_999_999_999 }) : null;
  const channelId = optionalStr(req.body?.channelId, 'Kanal', { max: 64 }) ?? null;
  const eventId = newId('evt');
  db.prepare(
    'INSERT INTO server_events (id, server_id, channel_id, title, description, starts_at, ends_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(eventId, ctx.server.id, channelId, title, description, startsAt, endsAt, uid(req), now());
  emitToServer(ctx.server.id, 'server:event_update', { serverId: ctx.server.id });
  res.status(201).json({ event: mapEvent(db.prepare('SELECT id, server_id, channel_id, title, description, starts_at, ends_at, created_by FROM server_events WHERE id = ?').get(eventId) as never) });
});

router.patch('/:id/events/:eventId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_EVENTS);
  const title = str(req.body?.title, 'Etkinlik adı', { min: 2, max: 80 });
  const description = optionalStr(req.body?.description, 'Açıklama', { max: 500 }) ?? '';
  const startsAt = int(req.body?.startsAt, 'Başlangıç', { min: 0, max: 9_999_999_999_999 });
  db.prepare('UPDATE server_events SET title = ?, description = ?, starts_at = ? WHERE id = ? AND server_id = ?').run(
    title,
    description,
    startsAt,
    req.params.eventId,
    ctx.server.id,
  );
  res.json({ ok: true });
});

router.delete('/:id/events/:eventId', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  assertPermission(ctx.permissions, PERMISSIONS.MANAGE_EVENTS);
  db.prepare('DELETE FROM server_events WHERE id = ? AND server_id = ?').run(req.params.eventId, ctx.server.id);
  res.json({ ok: true });
});

router.post('/:id/events/:eventId/rsvp', (req, res) => {
  const ctx = requireMemberContext(req.params.id, uid(req));
  const status = oneOf(req.body?.status, ['going', 'interested', 'none'] as const, 'Katılım');
  if (status === 'none') {
    db.prepare('DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?').run(req.params.eventId, uid(req));
  } else {
    db.prepare('INSERT OR REPLACE INTO event_attendees (event_id, user_id, status) VALUES (?,?,?)').run(req.params.eventId, uid(req), status);
  }
  emitToServer(ctx.server.id, 'server:event_update', { serverId: ctx.server.id });
  res.json({ ok: true });
});

export default router;
