/** Rozet kataloğu — istemci ve sunucu aynı tanımları kullanır. */
import type { Badge } from './types';

/**
 * Rozetler kullanıcıya elle verilmez; sunucu tarafında gerçek verilerden
 * (hesap yaşı, mesaj sayısı, arkadaş sayısı, sunucu rolleri) hesaplanır.
 */
export const BADGE_CATALOG: Record<string, Badge> = {
  founder: {
    id: 'founder',
    label: 'Kurucu',
    icon: 'crown',
    color: '#ffb020',
    description: 'ORBIT’in ilk hesabı.',
  },
  early: {
    id: 'early',
    label: 'Erken Üye',
    icon: 'rocket',
    color: '#22d3ee',
    description: 'Platformun ilk 50 üyesinden biri.',
  },
  owner: {
    id: 'owner',
    label: 'Topluluk Sahibi',
    icon: 'shield',
    color: '#7c5cff',
    description: 'En az bir topluluğun sahibi.',
  },
  admin: {
    id: 'admin',
    label: 'Yönetici',
    icon: 'hammer',
    color: '#f472b6',
    description: 'Bir toplulukta yönetici yetkisine sahip.',
  },
  moderator: {
    id: 'moderator',
    label: 'Moderatör',
    icon: 'shield',
    color: '#38bdf8',
    description: 'Bir toplulukta üye yönetme yetkisine sahip.',
  },
  veteran: {
    id: 'veteran',
    label: 'Kıdemli',
    icon: 'calendar',
    color: '#a3e635',
    description: 'Hesap 30 günden eski.',
  },
  chatter: {
    id: 'chatter',
    label: 'Sohbetçi',
    icon: 'message',
    color: '#fb923c',
    description: '100’den fazla mesaj gönderdi.',
  },
  social: {
    id: 'social',
    label: 'Sosyal',
    icon: 'users',
    color: '#34d399',
    description: '5 veya daha fazla arkadaş.',
  },
};

export const BADGE_ORDER: string[] = [
  'founder',
  'early',
  'owner',
  'admin',
  'moderator',
  'veteran',
  'chatter',
  'social',
];

/** Öne çıkarılabilecek en fazla rozet sayısı. */
export const MAX_FEATURED_BADGES = 3;

export const BANNER_PRESETS = [
  '#1a1440',
  '#0f2a4a',
  '#2b1055',
  '#123b32',
  '#3d1024',
  '#2f2105',
  '#111827',
  '#4c1d95',
];

export const DEFAULT_BANNER = '#1a1440';

/** Bilinmeyen kimlikleri güvenle yok sayarak rozet nesnelerine çevirir. */
export function resolveBadges(ids: string[] | undefined | null): Badge[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  const result: Badge[] = [];
  for (const id of ids) {
    const badge = BADGE_CATALOG[id];
    if (badge && !seen.has(id)) {
      seen.add(id);
      result.push(badge);
    }
  }
  return result;
}
