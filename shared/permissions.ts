/**
 * ORBIT izin bitleri — sunucu ve istemci tarafından ortak kullanılır.
 * Kritik denetim her zaman sunucuda yapılır; istemci sadece arayüzü şekillendirir.
 */
export const PERMISSIONS = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_ROLES: 1 << 3,
  MANAGE_MEMBERS: 1 << 4,
  KICK_MEMBERS: 1 << 5,
  BAN_MEMBERS: 1 << 6,
  TIMEOUT_MEMBERS: 1 << 7,
  CREATE_INVITES: 1 << 8,
  MANAGE_MESSAGES: 1 << 9,
  SEND_MESSAGES: 1 << 10,
  VIEW_CHANNEL: 1 << 11,
  PIN_MESSAGES: 1 << 12,
  MANAGE_EVENTS: 1 << 13,
  VIEW_AUDIT_LOG: 1 << 14,
  MENTION_EVERYONE: 1 << 15,
  MANAGE_WEBHOOKS: 1 << 16,
  SEND_FILES: 1 << 17,
  ADD_REACTIONS: 1 << 18,
  CONNECT_VOICE: 1 << 19,
  SPEAK: 1 << 20,
  MANAGE_THREADS: 1 << 21,
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((acc, bit) => acc | bit, 0);

/** Sunucu sahibinin varsayılan olarak aldığı tüm izinler. */
export const OWNER_PERMISSIONS = ALL_PERMISSIONS;

/** @everyone rolü için güvenli varsayılan izinler. */
export const DEFAULT_EVERYONE_PERMISSIONS =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.CREATE_INVITES |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.SEND_FILES |
  PERMISSIONS.CONNECT_VOICE |
  PERMISSIONS.SPEAK;

export const MODERATOR_PERMISSIONS =
  DEFAULT_EVERYONE_PERMISSIONS |
  PERMISSIONS.MANAGE_MESSAGES |
  PERMISSIONS.KICK_MEMBERS |
  PERMISSIONS.TIMEOUT_MEMBERS |
  PERMISSIONS.PIN_MESSAGES |
  PERMISSIONS.VIEW_AUDIT_LOG;

export const ADMIN_PERMISSIONS = OWNER_PERMISSIONS;

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  ADMINISTRATOR: 'Yönetici (tüm izinler)',
  MANAGE_SERVER: 'Sunucuyu yönet',
  MANAGE_CHANNELS: 'Kanalları yönet',
  MANAGE_ROLES: 'Rolleri yönet',
  MANAGE_MEMBERS: 'Üyeleri yönet',
  KICK_MEMBERS: 'Üyeleri at',
  BAN_MEMBERS: 'Üyeleri yasakla',
  TIMEOUT_MEMBERS: 'Geçici sustur',
  CREATE_INVITES: 'Davet oluştur',
  MANAGE_MESSAGES: 'Mesajları yönet',
  SEND_MESSAGES: 'Mesaj gönder',
  VIEW_CHANNEL: 'Kanalları gör',
  PIN_MESSAGES: 'Mesajları sabitle',
  MANAGE_EVENTS: 'Etkinlikleri yönet',
  VIEW_AUDIT_LOG: 'Denetim kaydını gör',
  MENTION_EVERYONE: '@everyone etiketle',
  MANAGE_WEBHOOKS: 'Webhook yönet',
  SEND_FILES: 'Dosya gönder',
  ADD_REACTIONS: 'Tepki ekle',
  CONNECT_VOICE: 'Sesli kanala katıl',
  SPEAK: 'Sesli konuş',
  MANAGE_THREADS: 'Forum konularını yönet',
};

export function hasPermission(permissions: number, bit: number): boolean {
  if ((permissions & PERMISSIONS.ADMINISTRATOR) !== 0) return true;
  return (permissions & bit) === bit;
}
