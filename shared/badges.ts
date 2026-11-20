/** Rozet kataloğu ve profil banner ön ayarları — istemci ve sunucu ortak kullanır. */
import type { Badge } from './types';

/**
 * Rozetler elle atanmaz; sunucu tarafında gerçek verilerden hesaplanır
 * (hesap sırası, yaş, mesaj sayısı, arkadaş sayısı, sunucu rolleri).
 */
export const BADGE_CATALOG: Record<string, Badge> = {
  founder: {
    id: 'founder',
    label: 'Kurucu',
    icon: 'crown',
    color: '#f0b232',
    description: 'ORBIT\'e katılan ilk kullanıcı.',
  },
  early: {
    id: 'early',
    label: 'Erken Üye',
    icon: 'check',
    color: '#3ba55d',
    description: 'İlk 50 kullanıcı arasında katıldı.',
  },
  veteran: {
    id: 'veteran',
    label: 'Kıdemli',
    icon: 'calendar',
    color: '#00a8fc',
    description: 'Hesabı 30 günden eski.',
  },
  owner: {
    id: 'owner',
    label: 'Topluluk Sahibi',
    icon: 'globe',
    color: '#7c5cff',
    description: 'En az bir topluluk kurdu.',
  },
  admin: {
    id: 'admin',
    label: 'Yönetici',
    icon: 'shield',
    color: '#ed4245',
    description: 'Bir toplulukta yönetici yetkisi var.',
  },
  moderator: {
    id: 'moderator',
    label: 'Moderatör',
    icon: 'hammer',
    color: '#eb459e',
    description: 'Bir toplulukta moderasyon yetkisi var.',
  },
  chatter: {
    id: 'chatter',
    label: 'Sohbetçi',
    icon: 'message',
    color: '#5865f2',
    description: '100 veya daha fazla mesaj gönderdi.',
  },
  social: {
    id: 'social',
    label: 'Sosyal',
    icon: 'users',
    color: '#faa61a',
    description: '5 veya daha fazla arkadaş edindi.',
  },
};

/** Profil kartı üst şeridi için hazır renkler. */
export const BANNER_PRESETS: { label: string; color: string }[] = [
  { label: 'Gece moru', color: '#1a1440' },
  { label: 'Derin mavi', color: '#0d2a4a' },
  { label: 'Neon çivit', color: '#2b1b6b' },
  { label: 'Kozmik', color: '#3a1450' },
  { label: 'Okyanus', color: '#0b3d4f' },
  { label: 'Grafit', color: '#22252b' },
  { label: 'Gün batımı', color: '#5c1f3d' },
  { label: 'Zümrüt', color: '#123f31' },
];

export const DEFAULT_BANNER = '#1a1440';

/** Profil kartında en fazla bu kadar rozet öne çıkarılabilir. */
export const MAX_FEATURED_BADGES = 3;

/** Rozet kimliklerini tam rozet nesnelerine çevirir (bilinmeyenler atlanır). */
export function resolveBadges(ids: readonly string[] | undefined): Badge[] {
  if (!ids) return [];
  const result: Badge[] = [];
  for (const id of ids) {
    const badge = BADGE_CATALOG[id];
    if (badge) result.push(badge);
  }
  return result;
}
