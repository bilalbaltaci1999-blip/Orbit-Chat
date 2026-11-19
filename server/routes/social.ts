/** Arkadaşlar, doğrudan/grup mesajları, engelleme, bildirimler ve Web Push. */
import { Router, type Request } from 'express';
import { db, newId, now } from '../db';
import { requireAuth } from '../auth';
import { ApiError } from '../permissions';
import { friendsPayload, notificationsFor, unreadNotifications } from '../bootstrap';
import { dmChannelFor, mapNotification, publicUser } from '../serialize';
import { emitToDm, emitToUser, notify } from '../realtime';
import { assertDmMember, createMessage, getDmRow, isBlockedBetween, markDmRead } from '../messageService';
import { rateLimit } from '../rateLimit';
import { int, oneOf, optionalStr, str } from '../validate';
import * as pushApi from '../push';

const router = Router();
router.use(requireAuth);
const uid = (req: Request): string => req.user!.id;

const USER_COLUMNS = 'u.id, u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio, u.status, u.custom_status, u.created_at';

/* --------------------------------- arkadaşlar -------------------------------- */

router.get('/friends', (req, res) => {
  res.json({ friends: friendsPayload(uid(req)) });
});

router.post('/friends/requests', rateLimit({ windowMs: 60_000, max: 20 }), (req, res) => {
  const username = str(req.body?.username, 'Kullanıcı adı', { min: 2, max: 32 }).replace(/^@/, '');
  const target = db.prepare('SELECT id, display_name FROM users WHERE username = ?').get(username) as
    | { id: string; display_name: string }
    | undefined;
  if (!target) throw new ApiError(404, 'Bu kullanıcı adı bulunamadı.', 'USER_NOT_FOUND');
  if (target.id === uid(req)) throw new ApiError(400, 'Kendinize arkadaşlık isteği gönderemezsiniz.', 'SELF_REQUEST');
  if (isBlockedBetween(uid(req), target.id)) throw new ApiError(403, 'Bu kullanıcıyla etkileşim kuramazsınız.', 'BLOCKED');
  const friend = db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(uid(req), target.id);
  if (friend) throw new ApiError(400, 'Bu kullanıcı zaten arkadaşınız.', 'ALREADY_FRIENDS');

  const reverse = db
    .prepare("SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .get(target.id, uid(req)) as { id: string } | undefined;
  if (reverse) {
    // Karşı taraf zaten istek göndermişse doğrudan kabul et.
    db.prepare("UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?").run(now(), reverse.id);
    db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)').run(uid(req), target.id, now());
    db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)').run(target.id, uid(req), now());
    emitToUser(target.id, 'friends:update', {});
    emitToUser(uid(req), 'friends:update', {});
    return res.json({ status: 'friends' });
  }

  const existing = db
    .prepare("SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .get(uid(req), target.id) as { id: string } | undefined;
  if (existing) return res.json({ status: 'outgoing', requestId: existing.id });

  const requestId = newId('frq');
  db.prepare("INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES (?,?,?,'pending',?)").run(
    requestId,
    uid(req),
    target.id,
    now(),
  );
  notify({
    userId: target.id,
    type: 'friend_request',
    title: 'Yeni arkadaşlık isteği',
    body: `${req.user!.displayName} size arkadaşlık isteği gönderdi.`,
    actorId: uid(req),
  });
  emitToUser(target.id, 'friends:update', {});
  res.status(201).json({ status: 'outgoing', requestId });
});

router.post('/friends/requests/:id/accept', (req, res) => {
  const row = db.prepare('SELECT id, from_id, to_id, status FROM friend_requests WHERE id = ?').get(req.params.id) as
    | { id: string; from_id: string; to_id: string; status: string }
    | undefined;
  if (!row || row.to_id !== uid(req)) throw new ApiError(404, 'İstek bulunamadı.', 'REQUEST_NOT_FOUND');
  if (row.status !== 'pending') throw new ApiError(400, 'Bu istek zaten yanıtlanmış.', 'ALREADY_HANDLED');
  db.prepare("UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?").run(now(), row.id);
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)').run(row.to_id, row.from_id, now());
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?,?,?)').run(row.from_id, row.to_id, now());
  emitToUser(row.from_id, 'friends:update', {});
  emitToUser(row.to_id, 'friends:update', {});
  res.json({ ok: true });
});

router.post('/friends/requests/:id/decline', (req, res) => {
  const row = db.prepare('SELECT id, from_id, to_id FROM friend_requests WHERE id = ?').get(req.params.id) as
    | { id: string; from_id: string; to_id: string }
    | undefined;
  if (!row || (row.to_id !== uid(req) && row.from_id !== uid(req))) {
    throw new ApiError(404, 'İstek bulunamadı.', 'REQUEST_NOT_FOUND');
  }
  db.prepare("UPDATE friend_requests SET status = 'rejected', responded_at = ? WHERE id = ?").run(now(), row.id);
  emitToUser(row.from_id, 'friends:update', {});
  emitToUser(row.to_id, 'friends:update', {});
  res.json({ ok: true });
});

router.delete('/friends/:userId', (req, res) => {
  db.prepare('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(
    uid(req),
    req.params.userId,
    req.params.userId,
    uid(req),
  );
  emitToUser(req.params.userId, 'friends:update', {});
  res.json({ ok: true });
});

router.post('/blocks/:userId', (req, res) => {
  if (req.params.userId === uid(req)) throw new ApiError(400, 'Kendinizi engelleyemezsiniz.', 'SELF_BLOCK');
  db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?,?,?)').run(uid(req), req.params.userId, now());
  db.prepare('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(
    uid(req),
    req.params.userId,
    req.params.userId,
    uid(req),
  );
  res.json({ ok: true });
});

router.delete('/blocks/:userId', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(uid(req), req.params.userId);
  res.json({ ok: true });
});

/* -------------------------------- özel mesajlar ------------------------------- */

router.get('/dms', (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, MAX(m.created_at) AS last FROM dm_channels d
       JOIN dm_members dm ON dm.dm_id = d.id
       LEFT JOIN messages m ON m.dm_id = d.id AND m.deleted_at IS NULL
       WHERE dm.user_id = ? GROUP BY d.id ORDER BY COALESCE(last, d.created_at) DESC`,
    )
    .all(uid(req)) as { id: string }[];
  res.json({ dms: rows.map((r) => dmChannelFor(r.id, uid(req))).filter(Boolean) });
});

router.post('/dms', (req, res) => {
  const targetId = optionalStr(req.body?.userId, 'Kullanıcı', { max: 64 });
  const userIds = Array.isArray(req.body?.userIds) ? (req.body.userIds as unknown[]).map(String) : [];
  const isGroup = userIds.length > 0 || Boolean(req.body?.name);

  if (!isGroup && targetId) {
    if (targetId === uid(req)) throw new ApiError(400, 'Kendinizle özel sohbet açamazsınız.', 'SELF_DM');
    const target = db.prepare('SELECT id, status FROM users WHERE id = ?').get(targetId) as { id: string; status: string } | undefined;
    if (!target) throw new ApiError(404, 'Kullanıcı bulunamadı.', 'USER_NOT_FOUND');
    if (isBlockedBetween(uid(req), targetId)) throw new ApiError(403, 'Bu kullanıcıyla mesajlaşamazsınız.', 'BLOCKED');
    const settings = db.prepare('SELECT dm_privacy FROM user_settings WHERE user_id = ?').get(targetId) as
      | { dm_privacy: string }
      | undefined;
    if (settings?.dm_privacy === 'friends') {
      const friend = db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(targetId, uid(req));
      if (!friend) throw new ApiError(403, 'Bu kullanıcı yalnızca arkadaşlarından mesaj kabul ediyor.', 'DM_PRIVACY');
    }
    const existing = db
      .prepare(
        `SELECT d.id FROM dm_channels d
         JOIN dm_members a ON a.dm_id = d.id AND a.user_id = ?
         JOIN dm_members b ON b.dm_id = d.id AND b.user_id = ?
         WHERE d.type = 'direct' LIMIT 1`,
      )
      .get(uid(req), targetId) as { id: string } | undefined;
    if (existing) return res.json({ dm: dmChannelFor(existing.id, uid(req)) });

    const dmId = newId('dm');
    db.transaction(() => {
      db.prepare("INSERT INTO dm_channels (id, type, name, icon_color, owner_id, created_at) VALUES (?, 'direct', NULL, '#3b82f6', ?, ?)").run(
        dmId,
        uid(req),
        now(),
      );
      db.prepare('INSERT INTO dm_members (dm_id, user_id, joined_at) VALUES (?,?,?)').run(dmId, uid(req), now());
      db.prepare('INSERT INTO dm_members (dm_id, user_id, joined_at) VALUES (?,?,?)').run(dmId, targetId, now());
    })();
    emitToUser(targetId, 'dm:created', { dmId });
    return res.status(201).json({ dm: dmChannelFor(dmId, uid(req)) });
  }

  const unique = [...new Set(userIds.filter((id) => id !== uid(req)))];
  if (unique.length === 0) throw new ApiError(400, 'Grup sohbeti için en az bir katılımcı seçin.', 'NO_MEMBERS');
  if (unique.length > 20) throw new ApiError(400, 'Grup sohbeti en fazla 21 kişi olabilir.', 'TOO_MANY_MEMBERS');
  for (const id of unique) {
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
    if (!exists) throw new ApiError(400, 'Geçersiz katılımcı.', 'INVALID_MEMBER');
    if (isBlockedBetween(uid(req), id)) throw new ApiError(403, 'Engellenen kullanıcı gruba eklenemez.', 'BLOCKED');
  }
  const dmId = newId('dm');
  const name = optionalStr(req.body?.name, 'Grup adı', { max: 48 }) ?? 'Grup sohbeti';
  db.transaction(() => {
    db.prepare("INSERT INTO dm_channels (id, type, name, icon_color, owner_id, created_at) VALUES (?, 'group', ?, '#7c5cff', ?, ?)").run(
      dmId,
      name,
      uid(req),
      now(),
    );
    for (const id of [uid(req), ...unique]) {
      db.prepare('INSERT INTO dm_members (dm_id, user_id, joined_at) VALUES (?,?,?)').run(dmId, id, now());
    }
  })();
  for (const id of unique) emitToUser(id, 'dm:created', { dmId });
  res.status(201).json({ dm: dmChannelFor(dmId, uid(req)) });
});

router.get('/dms/:dmId/messages', (req, res) => {
  const dm = assertDmMember(req.params.dmId, uid(req));
  const before = req.query.before ? int(req.query.before, 'before', { min: 0, max: 9_999_999_999_999 }) : Number.MAX_SAFE_INTEGER;
  const limit = req.query.limit ? int(req.query.limit, 'limit', { min: 1, max: 100, fallback: 50 }) : 50;
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id, m.dm_id, m.author_id, m.content, m.title, m.parent_id, m.type, m.pinned,
              m.edited_at, m.created_at, m.deleted_at
       FROM messages m WHERE m.dm_id = ? AND m.deleted_at IS NULL AND m.created_at < ?
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(dm.id, before, limit) as never[];
  const { mapMessage } = require('../serialize') as typeof import('../serialize');
  res.json({ messages: rows.reverse().map((row) => mapMessage(row, uid(req))) });
});

router.post('/dms/:dmId/messages', rateLimit({ windowMs: 10_000, max: 30 }), (req, res) => {
  const dm = assertDmMember(String(req.params.dmId), uid(req));
  const message = createMessage({
    authorId: uid(req),
    dmId: dm.id,
    content: optionalStr(req.body?.content, 'Mesaj', { max: 4000 }) ?? '',
    parentId: optionalStr(req.body?.parentId, 'Yanıt', { max: 64 }),
    fileIds: Array.isArray(req.body?.fileIds) ? (req.body.fileIds as unknown[]).map(String) : [],
  });
  res.status(201).json({ message });
});

router.post('/dms/:dmId/read', (req, res) => {
  const dm = assertDmMember(req.params.dmId, uid(req));
  markDmRead(uid(req), dm.id);
  res.json({ ok: true });
});

router.patch('/dms/:dmId', (req, res) => {
  const dm = assertDmMember(req.params.dmId, uid(req));
  if (dm.type !== 'group') throw new ApiError(400, 'Yalnızca grup sohbetleri yeniden adlandırılabilir.', 'NOT_GROUP');
  const name = str(req.body?.name, 'Grup adı', { min: 1, max: 48 });
  db.prepare('UPDATE dm_channels SET name = ? WHERE id = ?').run(name, dm.id);
  emitToDm(dm.id, 'dm:update', { dmId: dm.id, name });
  res.json({ ok: true });
});

router.post('/dms/:dmId/members', (req, res) => {
  const dm = assertDmMember(req.params.dmId, uid(req));
  if (dm.type !== 'group') throw new ApiError(400, 'Yalnızca grup sohbetlerine üye eklenebilir.', 'NOT_GROUP');
  const userId = str(req.body?.userId, 'Kullanıcı', { min: 1, max: 64 });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new ApiError(404, 'Kullanıcı bulunamadı.', 'USER_NOT_FOUND');
  db.prepare('INSERT OR IGNORE INTO dm_members (dm_id, user_id, joined_at) VALUES (?,?,?)').run(dm.id, userId, now());
  emitToUser(userId, 'dm:created', { dmId: dm.id });
  emitToDm(dm.id, 'dm:update', { dmId: dm.id });
  res.json({ ok: true });
});

router.delete('/dms/:dmId/members/:userId', (req, res) => {
  const dm = assertDmMember(req.params.dmId, uid(req));
  const targetId = req.params.userId;
  if (targetId !== uid(req) && dm.owner_id !== uid(req)) {
    throw new ApiError(403, 'Bu üyeyi çıkaramazsınız.', 'FORBIDDEN');
  }
  db.prepare('DELETE FROM dm_members WHERE dm_id = ? AND user_id = ?').run(dm.id, targetId);
  emitToUser(targetId, 'dm:removed', { dmId: dm.id });
  res.json({ ok: true });
});

/* --------------------------------- bildirimler -------------------------------- */

router.get('/notifications', (req, res) => {
  res.json({ notifications: notificationsFor(uid(req), 60), unread: unreadNotifications(uid(req)) });
});

router.post('/notifications/read', (req, res) => {
  const id = optionalStr(req.body?.id, 'Bildirim', { max: 64 });
  if (id) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), id, uid(req));
  else db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), uid(req));
  emitToUser(uid(req), 'notifications:update', { unread: unreadNotifications(uid(req)) });
  res.json({ unread: unreadNotifications(uid(req)) });
});

router.delete('/notifications', (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(uid(req));
  res.json({ ok: true });
});

/* ---------------------------------- web push --------------------------------- */

router.get('/push/key', (req, res) => {
  res.json({ publicKey: pushApi.vapidPublicKey(), configured: pushApi.pushConfigured() });
});

router.post('/push/subscribe', (req, res) => {
  const subscription = req.body?.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
    throw new ApiError(400, 'Geçersiz push aboneliği.', 'INVALID_SUBSCRIPTION');
  }
  pushApi.saveSubscription({
    userId: uid(req),
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  });
  res.status(201).json({ ok: true });
});

router.delete('/push/subscribe', (req, res) => {
  const endpoint = optionalStr(req.body?.endpoint, 'Endpoint', { max: 500 });
  if (endpoint) pushApi.removeSubscription(uid(req), endpoint);
  res.json({ ok: true });
});

void getDmRow;
void oneOf;
void mapNotification;
void publicUser;
void USER_COLUMNS;
void notify;

export default router;
