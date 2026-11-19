/** Kullanıcı profili, durum, tema ve gizlilik ayarları. */
import { Router } from 'express';
import { requireAuth } from '../auth';
import { db, newId, now } from '../db';
import { meUser } from '../bootstrap';
import { ApiError } from '../permissions';
import { emitToServer, getIo } from '../realtime';
import { color, oneOf, optionalStr, str } from '../validate';
import { publicUser } from '../serialize';
import { computeBadges, sanitizeFeatured } from '../badges';
import { resolveBadges } from '../../shared/badges';
import { saveFile, upload } from '../storage';

const router = Router();
router.use(requireAuth);

const STATUSES = ['online', 'idle', 'dnd', 'offline', 'invisible'] as const;

router.get('/me', (req, res) => {
  res.json({ user: meUser(req.user!) });
});

router.patch('/me', (req, res) => {
  const fields: string[] = [];
  const values: unknown[] = [];
  const body = req.body ?? {};

  if (body.displayName !== undefined) {
    fields.push('display_name = ?');
    values.push(optionalStr(body.displayName, 'Görünen ad', { max: 32 }) || req.user!.username);
  }
  if (body.bio !== undefined) {
    fields.push('bio = ?');
    values.push(optionalStr(body.bio, 'Hakkında', { max: 400 }) ?? '');
  }
  if (body.avatarColor !== undefined) {
    fields.push('avatar_color = ?');
    values.push(color(body.avatarColor, 'Avatar rengi'));
  }
  if (body.customStatus !== undefined) {
    fields.push('custom_status = ?');
    values.push(optionalStr(body.customStatus, 'Durum mesajı', { max: 128 }) ?? '');
  }
  if (body.theme !== undefined) {
    fields.push('theme = ?');
    values.push(oneOf(body.theme, ['dark', 'light'] as const, 'Tema'));
  }
  if (body.bannerColor !== undefined) {
    fields.push('banner_color = ?');
    values.push(color(body.bannerColor, 'Banner rengi'));
  }
  if (body.featuredBadges !== undefined) {
    fields.push('featured_badges = ?');
    values.push(sanitizeFeatured(req.user!.id, body.featuredBadges).join(','));
  }
  if (body.status !== undefined) {
    const status = oneOf(body.status, STATUSES, 'Durum');
    fields.push('status = ?');
    values.push(status);
  }

  if (fields.length === 0) throw new ApiError(400, 'Güncellenecek alan yok.', 'NO_FIELDS');
  fields.push('updated_at = ?');
  values.push(now());
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.user!.id);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as never;
  const user = meUser({ ...req.user!, ...mapPatch(req.user!, body) });
  broadcastPresence(req.user!.id);
  res.json({ user, row: Boolean(row) });
});

type ProfilePatch = {
  displayName?: string;
  bio?: string;
  avatarColor?: string;
  customStatus?: string;
  theme?: 'dark' | 'light';
  status?: 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';
  bannerColor?: string;
  featuredBadges?: string[];
};

function mapPatch(user: { status: string; customStatus: string }, body: Record<string, unknown>): ProfilePatch {
  const patch: ProfilePatch = {};
  if (body.displayName !== undefined) patch.displayName = String(body.displayName);
  if (body.bio !== undefined) patch.bio = String(body.bio);
  if (body.avatarColor !== undefined) patch.avatarColor = String(body.avatarColor);
  if (body.customStatus !== undefined) patch.customStatus = String(body.customStatus);
  if (body.theme !== undefined) patch.theme = body.theme === 'light' ? 'light' : 'dark';
  if (body.bannerColor !== undefined) patch.bannerColor = String(body.bannerColor);
  if (body.featuredBadges !== undefined) {
    patch.featuredBadges = Array.isArray(body.featuredBadges) ? body.featuredBadges.map(String) : [];
  }
  if (body.status !== undefined) patch.status = String(body.status) as ProfilePatch['status'];
  return patch;
}

function broadcastPresence(userId: string): void {
  const row = db.prepare('SELECT status, custom_status FROM users WHERE id = ?').get(userId) as
    | { status: string; custom_status: string }
    | undefined;
  if (!row) return;
  const servers = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(userId) as {
    server_id: string;
  }[];
  for (const s of servers) {
    emitToServer(s.server_id, 'presence:update', { userId, status: row.status, customStatus: row.custom_status });
  }
}

router.post('/me/avatar', upload.single('avatar'), (req, res) => {
  const file = req.file;
  if (!file) throw new ApiError(400, 'Görsel seçilmedi.', 'NO_FILE');
  if (!file.mimetype.startsWith('image/')) throw new ApiError(400, 'Yalnızca görsel yükleyebilirsiniz.', 'INVALID_IMAGE');
  const stored = saveFile({
    buffer: file.buffer,
    originalName: file.originalname,
    mime: file.mimetype,
    uploaderId: req.user!.id,
  });
  const url = `/api/files/${stored.id}`;
  db.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?').run(url, now(), req.user!.id);
  res.json({ avatarUrl: url });
});

/* Profil banner görseli: renk şeridinin yerine geçer. */
router.post('/me/banner', upload.single('banner'), (req, res) => {
  const file = req.file;
  if (!file) throw new ApiError(400, 'Görsel seçilmedi.', 'NO_FILE');
  if (!file.mimetype.startsWith('image/')) throw new ApiError(400, 'Yalnızca görsel yükleyebilirsiniz.', 'INVALID_IMAGE');
  const stored = saveFile({
    buffer: file.buffer,
    originalName: file.originalname,
    mime: file.mimetype,
    uploaderId: req.user!.id,
  });
  const url = `/api/files/${stored.id}`;
  db.prepare('UPDATE users SET banner_url = ?, updated_at = ? WHERE id = ?').run(url, now(), req.user!.id);
  res.json({ bannerUrl: url });
});

router.delete('/me/banner', (req, res) => {
  db.prepare('UPDATE users SET banner_url = NULL, updated_at = ? WHERE id = ?').run(now(), req.user!.id);
  res.json({ ok: true });
});

router.patch('/me/settings', (req, res) => {
  const body = req.body ?? {};
  const current = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user!.id) as
    | {
        dm_privacy: string;
        notifications_enabled: number;
        sounds_enabled: number;
        push_enabled: number;
        accent_color: string;
        compact_mode: number;
        message_density: string;
      }
    | undefined;
  const dmPrivacy =
    body.dmPrivacy !== undefined
      ? oneOf(body.dmPrivacy, ['everyone', 'friends'] as const, 'DM gizliliği')
      : current?.dm_privacy ?? 'everyone';
  const accentColor =
    body.accentColor !== undefined
      ? color(body.accentColor, 'Vurgu rengi')
      : current?.accent_color ?? '#7c5cff';
  const messageDensity =
    body.messageDensity !== undefined
      ? oneOf(body.messageDensity, ['cozy', 'compact'] as const, 'Mesaj yoğunluğu')
      : current?.message_density === 'compact'
        ? 'compact'
        : 'cozy';
  const flag = (value: unknown, fallback: number) => (typeof value === 'boolean' ? (value ? 1 : 0) : fallback);
  db.prepare(
    `INSERT INTO user_settings (user_id, dm_privacy, notifications_enabled, sounds_enabled, push_enabled, accent_color, compact_mode, message_density)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET dm_privacy = excluded.dm_privacy,
       notifications_enabled = excluded.notifications_enabled,
       sounds_enabled = excluded.sounds_enabled, push_enabled = excluded.push_enabled,
       accent_color = excluded.accent_color, compact_mode = excluded.compact_mode,
       message_density = excluded.message_density`,
  ).run(
    req.user!.id,
    dmPrivacy,
    flag(body.notificationsEnabled, current?.notifications_enabled ?? 1),
    flag(body.soundsEnabled, current?.sounds_enabled ?? 1),
    flag(body.pushEnabled, current?.push_enabled ?? 1),
    accentColor,
    flag(body.compactMode, current?.compact_mode ?? 0),
    messageDensity,
  );
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user!.id) as {
    dm_privacy: string;
    notifications_enabled: number;
    sounds_enabled: number;
    push_enabled: number;
    accent_color: string;
    compact_mode: number;
    message_density: string;
  };
  res.json({
    settings: {
      dmPrivacy: row.dm_privacy,
      notificationsEnabled: row.notifications_enabled === 1,
      soundsEnabled: row.sounds_enabled === 1,
      pushEnabled: row.push_enabled === 1,
      accentColor: row.accent_color,
      compactMode: row.compact_mode === 1,
      messageDensity: row.message_density === 'compact' ? 'compact' : 'cozy',
    },
  });
});

router.get('/search', (req, res) => {
  const q = str(req.query.q, 'Arama', { min: 1, max: 32 }).toLowerCase();
  const rows = db
    .prepare(
      `SELECT id, username, display_name, avatar_color, avatar_url, bio, status, custom_status, created_at, banner_color
       FROM users WHERE (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?) AND id != ?
       ORDER BY username LIMIT 12`,
    )
    .all(`%${q}%`, `%${q}%`, req.user!.id) as never[];
  res.json({ users: rows.map((row) => publicUser(row)).filter(Boolean) });
});

router.get('/:id', (req, res) => {
  const row = db
    .prepare(
      'SELECT id, username, display_name, avatar_color, avatar_url, bio, status, custom_status, created_at, banner_color, featured_badges FROM users WHERE id = ?',
    )
    .get(req.params.id) as never;
  const user = publicUser(row);
  if (!user) throw new ApiError(404, 'Kullanıcı bulunamadı.', 'USER_NOT_FOUND');

  const mutual = db
    .prepare(
      `SELECT s.id, s.name, s.icon_color FROM server_members a
       JOIN server_members b ON a.server_id = b.server_id
       JOIN servers s ON s.id = a.server_id
       WHERE a.user_id = ? AND b.user_id = ? LIMIT 20`,
    )
    .all(req.user!.id, req.params.id) as { id: string; name: string; icon_color: string }[];

  const friendship = db
    .prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?')
    .get(req.user!.id, req.params.id);
  const pendingOut = db
    .prepare("SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .get(req.user!.id, req.params.id) as { id: string } | undefined;
  const pendingIn = db
    .prepare("SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
    .get(req.params.id, req.user!.id) as { id: string } | undefined;
  const blocked = db
    .prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?')
    .get(req.user!.id, req.params.id);

  let status: 'self' | 'friends' | 'incoming' | 'outgoing' | 'blocked' | 'none' = 'none';
  if (req.params.id === req.user!.id) status = 'self';
  else if (blocked) status = 'blocked';
  else if (friendship) status = 'friends';
  else if (pendingIn) status = 'incoming';
  else if (pendingOut) status = 'outgoing';

  const noteRow = db
    .prepare('SELECT note FROM user_notes WHERE user_id = ? AND target_id = ?')
    .get(req.user!.id, req.params.id) as { note: string } | undefined;
  const featuredRow = db.prepare('SELECT featured_badges FROM users WHERE id = ?').get(req.params.id) as
    | { featured_badges: string | null }
    | undefined;
  const earned = computeBadges(req.params.id);

  res.json({
    user: { ...user, badges: earned },
    badges: resolveBadges(earned),
    featuredBadges: (featuredRow?.featured_badges ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => earned.includes(value)),
    note: noteRow?.note ?? '',
    friendship: { status, requestId: pendingIn?.id ?? pendingOut?.id ?? null },
    mutualServers: mutual.map((m) => ({ id: m.id, name: m.name, iconColor: m.icon_color })),
  });
});

/** Kişisel not — yalnızca notu yazan kullanıcı görebilir. */
router.put('/:id/note', (req, res) => {
  const target = db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.params.id);
  if (!target) throw new ApiError(404, 'Kullanıcı bulunamadı.', 'USER_NOT_FOUND');
  if (req.params.id === req.user!.id) throw new ApiError(400, 'Kendinize not ekleyemezsiniz.', 'SELF_NOTE');
  const note = optionalStr(req.body?.note, 'Not', { max: 256 }) ?? '';
  if (!note) {
    db.prepare('DELETE FROM user_notes WHERE user_id = ? AND target_id = ?').run(req.user!.id, req.params.id);
  } else {
    db.prepare(
      `INSERT INTO user_notes (user_id, target_id, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, target_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
    ).run(req.user!.id, req.params.id, note, now());
  }
  res.json({ note });
});

export default router;
