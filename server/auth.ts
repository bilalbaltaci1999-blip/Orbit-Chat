/**
 * Kimlik doğrulama: scrypt parola hash'i, httpOnly oturum çerezleri,
 * şifre sıfırlama belirteçleri ve Express ara katmanları.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db, newId, now } from './db';

export const SESSION_COOKIE = 'orbit_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 gün

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  bio: string;
  status: string;
  customStatus: string;
  theme: 'dark' | 'light';
  createdAt: number;
  settings: {
    dmPrivacy: 'everyone' | 'friends';
    notificationsEnabled: boolean;
    soundsEnabled: boolean;
    pushEnabled: boolean;
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_color: string;
  avatar_url: string | null;
  bio: string;
  status: string;
  custom_status: string;
  theme: 'dark' | 'light';
  password_hash: string;
  created_at: number;
}

interface SettingsRow {
  dm_privacy: 'everyone' | 'friends';
  notifications_enabled: number;
  sounds_enabled: number;
  push_enabled: number;
}

const selectUser = db.prepare('SELECT * FROM users WHERE id = ?');
const selectUserByEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
const selectSettings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');

export function toAuthUser(row: UserRow): AuthUser {
  const settings = selectSettings.get(row.id) as SettingsRow | undefined;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    status: row.status,
    customStatus: row.custom_status,
    theme: row.theme,
    createdAt: row.created_at,
    settings: {
      dmPrivacy: settings?.dm_privacy ?? 'everyone',
      notificationsEnabled: Boolean(settings?.notifications_enabled ?? 1),
      soundsEnabled: Boolean(settings?.sounds_enabled ?? 1),
      pushEnabled: Boolean(settings?.push_enabled ?? 1),
    },
  };
}

export function getUserRowById(id: string): UserRow | null {
  return (selectUser.get(id) as UserRow | undefined) ?? null;
}

export function getUserRowByEmail(email: string): UserRow | null {
  return (selectUserByEmail.get(email) as UserRow | undefined) ?? null;
}

export function createSession(userId: string, userAgent: string): { token: string; id: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = newId('ses');
  const createdAt = now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, sha256(token), userAgent.slice(0, 300), createdAt, createdAt, expiresAt);
  return { token, id, expiresAt };
}

export function setSessionCookie(res: Response, token: string, expiresAt: number): void {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  last_seen_at: number;
}

const selectSession = db.prepare('SELECT id, user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?');
const touchSession = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');

export function authenticateToken(token: string | undefined): { user: AuthUser; sessionId: string } | null {
  if (!token) return null;
  const session = selectSession.get(sha256(token)) as SessionRow | undefined;
  if (!session) return null;
  const stamp = now();
  if (session.expires_at < stamp) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return null;
  }
  const row = getUserRowById(session.user_id);
  if (!row) return null;
  if (stamp - session.last_seen_at > 60_000) touchSession.run(stamp, session.id);
  return { user: toAuthUser(row), sessionId: session.id };
}

export function currentUser(req: Request): AuthUser | null {
  return req.user ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const auth = authenticateToken(cookies[SESSION_COOKIE]);
  if (!auth) {
    res.status(401).json({ error: 'Oturum bulunamadı, lütfen giriş yapın.' });
    return;
  }
  req.user = auth.user;
  req.sessionId = auth.sessionId;
  next();
}

export function destroySessionByToken(token: string | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function cleanupSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now());
}

/** Oturum çerezini istek başlıklarından okur (Socket.IO el sıkışması için de kullanılır). */
export function userFromCookieHeader(cookieHeader: string | undefined): AuthUser | null {
  const cookies = parseCookies(cookieHeader);
  return authenticateToken(cookies[SESSION_COOKIE])?.user ?? null;
}
