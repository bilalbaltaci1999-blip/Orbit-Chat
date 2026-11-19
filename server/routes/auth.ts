/** Kimlik doğrulama rotaları: kayıt, giriş, çıkış, şifre sıfırlama, oturumlar. */
import crypto from 'node:crypto';
import { Router } from 'express';
import {
  clearSessionCookie,
  createSession,
  destroySessionByToken,
  getUserRowByEmail,
  getUserRowById,
  hashPassword,
  parseCookies,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookie,
  sha256,
  toAuthUser,
  verifyPassword,
} from '../auth';
import { db, newId, now } from '../db';
import { buildBootstrap, meUser, notificationsFor } from '../bootstrap';
import { ApiError } from '../permissions';
import { clientIp, rateLimit } from '../rateLimit';
import { email as vEmail, optionalStr, password as vPassword, str, username as vUsername } from '../validate';
import { sendMail, mailConfigured } from '../mailer';
import { publicUser } from '../serialize';

const router = Router();

const AVATAR_COLORS = ['#7c5cff', '#3b82f6', '#22d3ee', '#f472b6', '#f59e0b', '#34d399', '#a855f7', '#ef4444'];

function publicBase(req: { protocol: string; get(name: string): string | undefined }): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : '';
}

router.post(
  '/register',
  rateLimit({
    windowMs: 60_000,
    max: 10,
    message: 'Çok fazla kayıt denemesi. Lütfen biraz bekleyin.',
    key: (req) => clientIp(req),
  }),
  (req, res) => {
    const email = vEmail(req.body?.email);
    const username = vUsername(req.body?.username);
    const displayName = optionalStr(req.body?.displayName, 'Görünen ad', { max: 32 }) || username;
    const password = vPassword(req.body?.password);

    if (getUserRowByEmail(email)) {
      throw new ApiError(409, 'Bu e-posta ile bir hesap zaten var.', 'EMAIL_TAKEN', { email: 'Bu e-posta kullanılıyor.' });
    }
    const existingUsername = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (existingUsername) {
      throw new ApiError(409, 'Bu kullanıcı adı alınmış.', 'USERNAME_TAKEN', { username: 'Bu kullanıcı adı kullanılıyor.' });
    }

    const id = newId('usr');
    const stamp = now();
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, email, username, display_name, password_hash, avatar_color, bio, status, custom_status, theme, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 'online', '', 'dark', ?, ?)`,
      ).run(id, email, username, displayName, hashPassword(password), avatarColor, stamp, stamp);
      db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(id);
    });
    tx();

    const row = getUserRowById(id);
    if (!row) throw new ApiError(500, 'Hesap oluşturulamadı.');
    const authUser = toAuthUser(row);
    const session = createSession(id, req.get('user-agent') ?? '');
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ user: meUser(authUser) });
  },
);

router.post(
  '/login',
  rateLimit({
    windowMs: 15 * 60_000,
    max: 40,
    message: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.',
    key: (req) => clientIp(req),
  }),
  rateLimit({
    windowMs: 15 * 60_000,
    max: 8,
    message: 'Bu hesap için çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.',
    key: (req) => `${clientIp(req)}:${String(req.body?.email ?? '').trim().toLowerCase()}`,
  }),
  (req, res) => {
    const email = vEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = getUserRowByEmail(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new ApiError(401, 'E-posta veya şifre hatalı.', 'INVALID_CREDENTIALS');
    }
    const session = createSession(row.id, req.get('user-agent') ?? '');
    setSessionCookie(res, session.token, session.expiresAt);
    db.prepare('UPDATE users SET status = ? WHERE id = ? AND status = ?').run('online', row.id, 'offline');
    const fresh = getUserRowById(row.id);
    res.json({ user: meUser(toAuthUser(fresh ?? row)) });
  },
);

router.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  destroySessionByToken(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: meUser(req.user!) });
});

router.get('/bootstrap', requireAuth, (req, res) => {
  res.json(buildBootstrap(req.user!));
});

router.get('/notifications-preview', requireAuth, (req, res) => {
  res.json({ notifications: notificationsFor(req.user!.id, 10) });
});

router.get('/sessions', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user!.id) as {
    id: string;
    user_agent: string;
    created_at: number;
    last_seen_at: number;
    expires_at: number;
  }[];
  res.json({
    sessions: rows.map((r) => ({
      id: r.id,
      current: r.id === req.sessionId,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
    })),
  });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
  if (result.changes === 0) throw new ApiError(404, 'Oturum bulunamadı.', 'SESSION_NOT_FOUND');
  res.json({ ok: true });
});

router.post('/change-password', requireAuth, (req, res) => {
  const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const next = vPassword(req.body?.newPassword);
  const row = getUserRowById(req.user!.id);
  if (!row || !verifyPassword(current, row.password_hash)) {
    throw new ApiError(400, 'Mevcut şifre hatalı.', 'INVALID_PASSWORD');
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(next), now(), row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(row.id, req.sessionId ?? '');
  res.json({ ok: true });
});

router.post(
  '/forgot-password',
  rateLimit({ windowMs: 60 * 60_000, max: 6, message: 'Çok fazla sıfırlama isteği. Daha sonra tekrar deneyin.' }),
  async (req, res) => {
    const email = vEmail(req.body?.email);
    const row = getUserRowByEmail(email);
    const base = publicBase(req);
    const generic = {
      ok: true,
      message: 'Bu e-posta kayıtlıysa sıfırlama bağlantısı gönderildi.',
    };

    if (!row) {
      res.json(generic);
      return;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
      newId('rst'),
      row.id,
      sha256(token),
      now() + 60 * 60_000,
    );
    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    if (mailConfigured()) {
      await sendMail({
        to: row.email,
        subject: 'ORBIT — şifre sıfırlama',
        text: `Şifrenizi sıfırlamak için bu bağlantıyı 1 saat içinde kullanın:\n\n${resetUrl}\n\nBu isteği siz yapmadıysanız e-postayı yok sayın.`,
      });
      res.json(generic);
      return;
    }

    console.log(`[orbit] Şifre sıfırlama bağlantısı (${row.email}): ${resetUrl}`);
    if (process.env.NODE_ENV === 'production' && process.env.ORBIT_EXPOSE_RESET_LINK !== 'true') {
      res.json({
        ok: true,
        message: 'E-posta gönderimi yapılandırılmadı. Sunucu yöneticisi sıfırlama bağlantısını günlüklerden alabilir.',
      });
      return;
    }
    res.json({ ...generic, resetUrl, delivery: 'manual' });
  },
);

router.post(
  '/reset-password',
  rateLimit({ windowMs: 15 * 60_000, max: 12, message: 'Çok fazla deneme.' }),
  (req, res) => {
    const token = str(req.body?.token, 'Belirteç', { min: 10, max: 200 });
    const password = vPassword(req.body?.password);
    const record = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(token)) as
      | { id: string; user_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!record || record.used_at !== null || record.expires_at < now()) {
      throw new ApiError(400, 'Sıfırlama bağlantısı geçersiz veya süresi dolmuş.', 'INVALID_RESET_TOKEN');
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(password), now(), record.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), record.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(record.user_id);
    res.json({ ok: true });
  },
);

router.get('/users/:id/public', (req, res) => {
  const row = db
    .prepare(
      'SELECT id, username, display_name, avatar_color, avatar_url, bio, status, custom_status, created_at FROM users WHERE id = ?',
    )
    .get(req.params.id) as never;
  const user = publicUser(row);
  if (!user) throw new ApiError(404, 'Kullanıcı bulunamadı.', 'USER_NOT_FOUND');
  const mutual = db
    .prepare(
      `SELECT COUNT(*) AS c FROM server_members a JOIN server_members b ON a.server_id = b.server_id
       WHERE a.user_id = ? AND b.user_id = ?`,
    )
    .get(req.query.viewerId ?? '', req.params.id) as { c: number };
  res.json({ user, mutualServers: mutual.c });
});

export default router;
