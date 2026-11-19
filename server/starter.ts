/** Yeni hesaplara çalışan bir başlangıç topluluğu kurar (kanallar, roller, hoş geldin mesajı). */
import { db, newId, now } from './db';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '../shared/permissions';

const STARTER_CHANNELS: { name: string; type: 'text' | 'voice' | 'forum'; topic: string; group: 'start' | 'voice' }[] = [
  { name: 'genel', type: 'text', topic: 'Topluluğun ana sohbet kanalı. Buradan başlayın.', group: 'start' },
  { name: 'tanisma', type: 'text', topic: 'Kendinizi kısaca tanıtın.', group: 'start' },
  { name: 'duyurular', type: 'forum', topic: 'Topluluk duyuruları ve konu başlıkları.', group: 'start' },
  { name: 'Genel Sohbet', type: 'voice', topic: '', group: 'voice' },
];

/**
 * Kullanıcının hiç topluluğu yoksa gerçek, kullanılabilir bir başlangıç topluluğu oluşturur.
 * Oluşturulan topluluk kimliğini, zaten üyelik varsa null döndürür.
 */
export function createStarterServer(userId: string, displayName: string): string | null {
  const existing = db.prepare('SELECT 1 FROM server_members WHERE user_id = ? LIMIT 1').get(userId);
  if (existing) return null;

  const serverId = newId('srv');
  const everyoneId = newId('rol');
  const ownerRoleId = newId('rol');
  const startCategoryId = newId('cat');
  const voiceCategoryId = newId('cat');
  const stamp = now();
  const label = displayName.trim() || 'ORBIT';
  const name = `${label.slice(0, 40)} alanı`;

  db.transaction(() => {
    db.prepare(
      'INSERT INTO servers (id, name, description, icon_color, owner_id, is_public, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      serverId,
      name,
      'Kişisel başlangıç alanınız. Kanalları düzenleyin, arkadaşlarınızı davet edin.',
      '#7c5cff',
      userId,
      0,
      stamp,
    );
    db.prepare(
      'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, created_at) VALUES (?,?,?,?,?,?,1,?)',
    ).run(everyoneId, serverId, '@everyone', '#9aa0b4', 0, DEFAULT_EVERYONE_PERMISSIONS, stamp);
    db.prepare(
      'INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, created_at) VALUES (?,?,?,?,?,?,0,?)',
    ).run(ownerRoleId, serverId, 'Kurucu', '#7c5cff', 100, ALL_PERMISSIONS, stamp);
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(serverId, userId, stamp);
    db.prepare('INSERT INTO member_roles (user_id, role_id, server_id) VALUES (?,?,?)').run(userId, ownerRoleId, serverId);
    db.prepare('INSERT INTO channel_categories (id, server_id, name, position) VALUES (?,?,?,0)').run(
      startCategoryId,
      serverId,
      'BAŞLANGIÇ',
    );
    db.prepare('INSERT INTO channel_categories (id, server_id, name, position) VALUES (?,?,?,1)').run(
      voiceCategoryId,
      serverId,
      'SESLİ',
    );

    let position = 0;
    for (const channel of STARTER_CHANNELS) {
      db.prepare(
        'INSERT INTO channels (id, server_id, category_id, name, topic, type, position, slowmode_seconds, is_private, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)',
      ).run(
        newId('chn'),
        serverId,
        channel.group === 'voice' ? voiceCategoryId : startCategoryId,
        channel.name,
        channel.topic,
        channel.type,
        position++,
        stamp,
      );
    }
  })();

  return serverId;
}
