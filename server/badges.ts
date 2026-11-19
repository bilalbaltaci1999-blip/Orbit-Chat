/** Rozetleri gerçek verilerden hesaplar — elle atama yoktur. */
import { db } from './db';
import { BADGE_CATALOG, MAX_FEATURED_BADGES } from '../shared/badges';

const DAY = 24 * 60 * 60 * 1000;

interface RoleRow {
  permissions: string | null;
  is_default: number;
}

/** Rol izinleri JSON dizi, virgüllü liste ya da bit alanı olarak saklanabilir. */
function permissionKeys(raw: string | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map((value) => String(value));
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed as Record<string, unknown>)
          .filter(([, enabled]) => Boolean(enabled))
          .map(([key]) => key);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const ADMIN_KEYS = ['administrator', 'manageServer', 'manage_server', 'admin'];
const MOD_KEYS = ['manageMessages', 'manage_messages', 'kickMembers', 'kick_members', 'manageMembers', 'moderator'];

export function computeBadges(userId: string): string[] {
  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId) as
    | { created_at: number }
    | undefined;
  if (!user) return [];

  const earned = new Set<string>();

  const earlier = db
    .prepare('SELECT COUNT(*) AS c FROM users WHERE created_at < ? OR (created_at = ? AND id < ?)')
    .get(user.created_at, user.created_at, userId) as { c: number };
  if (earlier.c === 0) earned.add('founder');
  if (earlier.c < 50) earned.add('early');

  if (Date.now() - user.created_at >= 30 * DAY) earned.add('veteran');

  const owned = db.prepare('SELECT 1 FROM servers WHERE owner_id = ? LIMIT 1').get(userId);
  if (owned) earned.add('owner');

  const roles = db
    .prepare(
      `SELECT r.permissions AS permissions, r.is_default AS is_default
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id
       WHERE mr.user_id = ?`,
    )
    .all(userId) as RoleRow[];

  const keys = new Set<string>();
  for (const role of roles) {
    for (const key of permissionKeys(role.permissions)) keys.add(key);
  }
  if (owned || ADMIN_KEYS.some((key) => keys.has(key))) earned.add('admin');
  if (MOD_KEYS.some((key) => keys.has(key))) earned.add('moderator');

  const messages = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE author_id = ? AND deleted_at IS NULL')
    .get(userId) as { c: number };
  if (messages.c >= 100) earned.add('chatter');

  const friends = db.prepare('SELECT COUNT(*) AS c FROM friendships WHERE user_id = ?').get(userId) as { c: number };
  if (friends.c >= 5) earned.add('social');

  return [...earned].filter((id) => Boolean(BADGE_CATALOG[id]));
}

/** Öne çıkarılan rozetleri doğrular: yalnızca gerçekten kazanılmış rozetler. */
export function sanitizeFeatured(userId: string, input: unknown): string[] {
  const earned = new Set(computeBadges(userId));
  const requested = Array.isArray(input) ? input : [];
  const result: string[] = [];
  for (const value of requested) {
    const id = String(value);
    if (earned.has(id) && !result.includes(id)) result.push(id);
    if (result.length >= MAX_FEATURED_BADGES) break;
  }
  return result;
}
