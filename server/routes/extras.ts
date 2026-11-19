/** Keşfet, davetler, webhook mesajları ve sistem durumu uç noktaları. */
import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { db, newId, now } from '../db';
import { requireAuth } from '../auth';
import { ApiError, memberContext } from '../permissions';
import { PERMISSIONS } from '../../shared/permissions';
import { getServerMembers, mapMessage, messageColumns, serverDetail } from '../serialize';
import { emitToChannel, emitToServer } from '../realtime';
import { joinServer } from './servers';
import { int, optionalStr, str } from '../validate';

const router = Router();

/* ----------------------------------- sağlık ---------------------------------- */

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'ORBIT', time: now(), version: 1 });
});

/* ----------------------------------- keşfet ---------------------------------- */

router.get('/discover', requireAuth, (req: Request, res) => {
  const q = optionalStr(req.query.q, 'Arama', { max: 60 }) ?? '';
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.description, s.icon_color, s.created_at,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id AND m.user_id = ?) AS joined
       FROM servers s WHERE s.is_public = 1 AND s.name LIKE ?
       ORDER BY member_count DESC LIMIT 40`,
    )
    .all(req.user!.id, `%${q}%`) as {
    id: string;
    name: string;
    description: string;
    icon_color: string;
    created_at: number;
    member_count: number;
    joined: number;
  }[];
  res.json({
    servers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      iconColor: r.icon_color,
      createdAt: r.created_at,
      memberCount: r.member_count,
      joined: r.joined > 0,
    })),
  });
});

router.post('/discover/:serverId/join', requireAuth, (req: Request, res) => {
  const server = db.prepare('SELECT id, is_public FROM servers WHERE id = ?').get(req.params.serverId) as
    | { id: string; is_public: number }
    | undefined;
  if (!server || !server.is_public) throw new ApiError(404, 'Topluluk bulunamadı.', 'NOT_FOUND');
  joinServer(server.id, req.user!.id);
  res.json({ ok: true, serverId: server.id });
});

/* ----------------------------------- davetler -------------------------------- */

function loadInvite(code: string) {
  const invite = db
    .prepare(
      `SELECT i.code, i.server_id, i.channel_id, i.uses, i.max_uses, i.expires_at,
              s.name AS server_name, s.description, s.icon_color,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
       FROM invites i JOIN servers s ON s.id = i.server_id WHERE i.code = ?`,
    )
    .get(code) as
    | {
        code: string;
        server_id: string;
        channel_id: string | null;
        uses: number;
        max_uses: number | null;
        expires_at: number | null;
        server_name: string;
        description: string;
        icon_color: string;
        member_count: number;
      }
    | undefined;
  if (!invite) throw new ApiError(404, 'Davet geçersiz veya iptal edilmiş.', 'INVITE_NOT_FOUND');
  if (invite.expires_at && invite.expires_at < now()) throw new ApiError(410, 'Davetin süresi dolmuş.', 'INVITE_EXPIRED');
  if (invite.max_uses && invite.uses >= invite.max_uses) throw new ApiError(410, 'Davet kullanım limitine ulaştı.', 'INVITE_EXHAUSTED');
  return invite;
}

router.get('/invites/:code', requireAuth, (req, res) => {
  const invite = loadInvite(String(req.params.code));
  const joined = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(invite.server_id, req.user!.id);
  res.json({
    invite: {
      code: invite.code,
      serverId: invite.server_id,
      serverName: invite.server_name,
      description: invite.description,
      iconColor: invite.icon_color,
      memberCount: invite.member_count,
      channelId: invite.channel_id,
      alreadyMember: Boolean(joined),
    },
  });
});

router.post('/invites/:code/join', requireAuth, (req, res) => {
  const invite = loadInvite(String(req.params.code));
  const ctx = memberContext(invite.server_id, req.user!.id);
  if (ctx) return res.json({ server: serverDetail(ctx), alreadyMember: true });
  joinServer(invite.server_id, req.user!.id);
  db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(invite.code);
  const newCtx = memberContext(invite.server_id, req.user!.id)!;
  emitToServer(invite.server_id, 'server:member_add', {
    serverId: invite.server_id,
    member: getServerMembers(invite.server_id).find((m) => m.userId === req.user!.id) ?? null,
  });
  res.json({ server: serverDetail(newCtx), alreadyMember: false });
});

/* ---------------------------------- webhooklar ------------------------------- */

router.post('/webhooks/:webhookId/:token', (req, res) => {
  const webhook = db
    .prepare('SELECT id, server_id, channel_id, name, token FROM webhooks WHERE id = ?')
    .get(req.params.webhookId) as
    | { id: string; server_id: string; channel_id: string; name: string; token: string }
    | undefined;
  if (!webhook || !safeEqual(webhook.token, req.params.token)) {
    throw new ApiError(401, 'Geçersiz webhook.', 'INVALID_WEBHOOK');
  }
  const content = optionalStr(req.body?.content, 'İçerik', { max: 2000 }) ?? '';
  if (!content.trim()) throw new ApiError(400, 'İçerik gerekli.', 'EMPTY_CONTENT');
  const messageId = newId('msg');
  db.prepare(
    `INSERT INTO messages (id, channel_id, dm_id, author_id, content, title, parent_id, type, pinned, created_at)
     VALUES (?, ?, NULL, NULL, ?, NULL, NULL, 'text', 0, ?)`,
  ).run(messageId, webhook.channel_id, `**[${webhook.name}]** ${content}`, now());
  const message = mapMessage(db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(messageId) as never, '');
  emitToChannel(webhook.channel_id, 'message:create', message);
  res.status(201).json({ message });
});

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------------------------------- etkinlikler ------------------------------ */

router.get('/events', requireAuth, (req: Request, res) => {
  const rows = db
    .prepare(
      `SELECT e.id, e.server_id, e.channel_id, e.title, e.description, e.starts_at, e.ends_at, e.created_by,
              s.name AS server_name,
              (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendees
       FROM server_events e
       JOIN server_members m ON m.server_id = e.server_id AND m.user_id = ?
       JOIN servers s ON s.id = e.server_id
       ORDER BY e.starts_at ASC LIMIT 40`,
    )
    .all(req.user!.id) as {
    id: string;
    server_id: string;
    channel_id: string | null;
    title: string;
    description: string;
    starts_at: number;
    ends_at: number | null;
    created_by: string | null;
    server_name: string;
    attendees: number;
  }[];
  res.json({
    events: rows.map((r) => ({
      id: r.id,
      serverId: r.server_id,
      serverName: r.server_name,
      channelId: r.channel_id,
      title: r.title,
      description: r.description,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      createdBy: r.created_by,
      attendees: r.attendees,
    })),
  });
});

/* ------------------------------ yönetici komutları --------------------------- */

router.post('/admin/broadcast', requireAuth, (req: Request, res) => {
  const ctx = optionalStr(req.body?.serverId, 'Sunucu', { max: 64 });
  if (!ctx) throw new ApiError(400, 'Sunucu gerekli.', 'MISSING_SERVER');
  const member = memberContext(ctx, req.user!.id);
  if (!member || (member.permissions & PERMISSIONS.ADMINISTRATOR) === 0) {
    throw new ApiError(403, 'Yönetici izni gerekli.', 'FORBIDDEN');
  }
  const title = str(req.body?.title, 'Başlık', { min: 2, max: 80 });
  const body = optionalStr(req.body?.body, 'Metin', { max: 500 }) ?? '';
  const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(ctx) as { user_id: string }[];
  const insert = db.prepare(
    'INSERT INTO notifications (id, user_id, type, title, body, server_id, created_at) VALUES (?,?,?,?,?,?,?)',
  );
  const stamp = now();
  db.transaction(() => {
    for (const m of members) insert.run(newId('ntf'), m.user_id, 'system', title, body, ctx, stamp);
  })();
  for (const m of members) emitToServer(ctx, 'notifications:ping', { userId: m.user_id });
  void int;
  res.json({ sent: members.length });
});

export default router;
