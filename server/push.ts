/** Web Push altyapısı — VAPID anahtarları tanımlıysa gerçek push gönderir. */
import webpush from 'web-push';
import { db, newId, now } from './db';

const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
const privateKey = process.env.VAPID_PRIVATE_KEY ?? '';
let configured = false;

if (publicKey && privateKey) {
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@orbit.app', publicKey, privateKey);
    configured = true;
  } catch (err) {
    console.warn('[push] VAPID anahtarları geçersiz:', (err as Error).message);
  }
}

export function pushConfigured(): boolean {
  return configured;
}

export function vapidPublicKey(): string | null {
  return configured ? publicKey : null;
}

export function saveSubscription(input: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}): void {
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(newId('psh'), input.userId, input.endpoint, input.p256dh, input.auth, now());
}

export function removeSubscription(endpoint: string, userId: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  if (!configured) return;
  const rows = db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as { id: string; endpoint: string; p256dh: string; auth: string }[];
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
        }
      }
    }),
  );
}
