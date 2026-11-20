/** Discord tarzı profil kartı: banner, rozetler, hakkında, notlar ve eylemler. */
import { useEffect, useState } from 'react';
import type { Badge, PublicUser } from '@shared/types';
import { resolveBadges, MAX_FEATURED_BADGES } from '@shared/badges';
import { ApiFailure, socialApi, usersApi } from './api';
import { Avatar, Icon, Modal, Spinner, fullTime, relative, useToast } from './ui';

export interface ProfileData {
  user: PublicUser;
  badges: Badge[];
  featuredBadges: string[];
  note: string;
  friendship: { status: string; requestId: string | null };
  mutualServers: { id: string; name: string; iconColor: string }[];
}

/** Rozet satırı — profil kartında ve ayarlarda kullanılır. */
export function BadgeRow({ badges, size = 22 }: { badges: Badge[]; size?: number }) {
  if (badges.length === 0) return null;
  return (
    <div className="badge-row">
      {badges.map((badge) => (
        <span
          key={badge.id}
          className="badge-chip"
          style={{ color: badge.color, borderColor: `${badge.color}55`, background: `${badge.color}18` }}
          title={`${badge.label} — ${badge.description}`}
        >
          <Icon name={badge.icon} size={size * 0.6} />
          <span className="badge-label">{badge.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Sadece ikon olarak rozet gösterimi (dar alanlar için). */
export function BadgeIcons({ badges, size = 16 }: { badges: Badge[]; size?: number }) {
  if (badges.length === 0) return null;
  return (
    <span className="badge-icons">
      {badges.map((badge) => (
        <span key={badge.id} style={{ color: badge.color }} title={`${badge.label} — ${badge.description}`}>
          <Icon name={badge.icon} size={size} />
        </span>
      ))}
    </span>
  );
}

const FRIEND_LABEL: Record<string, string> = {
  self: 'Bu sizsiniz',
  friends: 'Arkadaşsınız',
  outgoing: 'İstek gönderildi',
  incoming: 'İstek bekliyor',
  blocked: 'Engellendi',
  none: '',
};

export function ProfileCard({
  userId,
  onClose,
  onStartDm,
  onChanged,
  onOpenSettings,
}: {
  userId: string;
  onClose: () => void;
  onStartDm: (userId: string) => void;
  onChanged: () => Promise<void> | void;
  onOpenSettings?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const [editingNote, setEditingNote] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    usersApi
      .profile(userId)
      .then((result) => {
        if (!alive) return;
        const profile = result as unknown as ProfileData;
        setData(profile);
        setNote(profile.note ?? '');
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof ApiFailure ? err.message : 'Profil yüklenemedi.');
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  const act = async (action: 'friend' | 'block' | 'unblock') => {
    if (!data) return;
    setBusy(true);
    try {
      if (action === 'friend') {
        await socialApi.sendRequest(data.user.username);
        toast.push('Arkadaşlık isteği gönderildi.', 'success');
      } else if (action === 'block') {
        await socialApi.block(data.user.id);
        toast.push('Kullanıcı engellendi.', 'success');
      } else {
        await socialApi.unblock(data.user.id);
        toast.push('Engel kaldırıldı.', 'success');
      }
      await onChanged();
      onClose();
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'İşlem tamamlanamadı.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!data) return;
    try {
      await usersApi.setNote(data.user.id, note.trim());
      setNoteSaved(true);
      setEditingNote(false);
      toast.push('Not kaydedildi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Not kaydedilemedi.', 'error');
    }
  };

  const banner = data?.user.bannerColor || '#1a1440';
  const earned = data?.badges ?? [];
  const featured = resolveBadges(data?.featuredBadges ?? []).slice(0, MAX_FEATURED_BADGES);
  const isSelf = data?.friendship.status === 'self';

  return (
    <Modal title="Profil" onClose={onClose} wide>
      {error ? (
        <div className="stack" style={{ alignItems: 'center', gap: 12, padding: '24px 0' }}>
          <Icon name="ban" size={26} />
          <p style={{ margin: 0 }}>{error}</p>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Kapat
          </button>
        </div>
      ) : !data ? (
        <Spinner label="Profil yükleniyor…" />
      ) : (
        <div className="profile-card">
          <div
            className="profile-banner"
            style={
              data.user.bannerUrl
                ? {
                    backgroundImage: `url(${data.user.bannerUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }
                : { background: `linear-gradient(135deg, ${banner}, ${banner}99 60%, #7c5cff55)` }
            }
          >
            {featured.length > 0 ? (
              <div className="profile-featured" title="Öne çıkan rozetler">
                <BadgeRow badges={featured} size={20} />
              </div>
            ) : null}
          </div>

          <div className="profile-body">
            <div className="profile-avatar-wrap">
              <div className="profile-avatar-ring">
                <Avatar user={data.user} size={88} showStatus />
              </div>
            </div>

            <div className="profile-identity">
              <h3 className="profile-name">{data.user.displayName}</h3>
              <div className="profile-handle">@{data.user.username}</div>
              {data.user.customStatus ? <div className="profile-status">{data.user.customStatus}</div> : null}
            </div>

            {earned.length > 0 ? (
              <div className="profile-section">
                <div className="profile-section-title">
                  Rozetler <span className="muted">({earned.length})</span>
                </div>
                <BadgeRow badges={earned} />
              </div>
            ) : (
              <div className="profile-section">
                <div className="profile-section-title">Rozetler</div>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  Henüz rozet kazanılmadı. Topluluklara katılın, mesaj gönderin ve rozet kazanın.
                </p>
              </div>
            )}

            <div className="profile-section">
              <div className="profile-section-title">Hakkında</div>
              <p className="profile-about">{data.user.bio || 'Henüz bir açıklama yok.'}</p>
            </div>

            <div className="profile-section">
              <div className="profile-section-title">ORBIT üyesi</div>
              <div className="profile-meta">
                <Icon name="calendar" size={14} /> {fullTime(data.user.createdAt)} tarihinde katıldı
                <span className="muted"> · {relative(data.user.createdAt)}</span>
              </div>
            </div>

            {data.mutualServers.length > 0 ? (
              <div className="profile-section">
                <div className="profile-section-title">Ortak topluluklar</div>
                <div className="profile-servers">
                  {data.mutualServers.map((server) => (
                    <span key={server.id} className="profile-server-chip">
                      <span className="profile-server-dot" style={{ background: server.iconColor }} />
                      {server.name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {!isSelf ? (
              <div className="profile-section">
                <div className="profile-section-title">Not</div>
                {editingNote ? (
                  <div className="stack" style={{ gap: 8 }}>
                    <textarea
                      className="input"
                      rows={3}
                      maxLength={256}
                      value={note}
                      placeholder="Bu kişi hakkında yalnızca sizin görebileceğiniz bir not…"
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <div className="row" style={{ gap: 8 }}>
                      <button type="button" className="btn btn-primary btn-sm" onClick={saveNote}>
                        Kaydet
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingNote(false);
                          setNote(data.note ?? '');
                        }}
                      >
                        Vazgeç
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="profile-note" onClick={() => setEditingNote(true)}>
                    {note ? note : noteSaved ? 'Not kaydedildi.' : 'Not eklemek için tıklayın'}
                  </button>
                )}
              </div>
            ) : null}

            <div className="profile-actions">
              {isSelf ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenSettings?.()}>
                  <Icon name="settings" size={15} /> Profili düzenle
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onStartDm(data.user.id)}>
                    <Icon name="message" size={15} /> Mesaj gönder
                  </button>
                  {data.friendship.status === 'friends' || data.friendship.status === 'outgoing' || data.friendship.status === 'incoming' ? (
                    <span className="chip">{FRIEND_LABEL[data.friendship.status]}</span>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('friend')}>
                      <Icon name="users" size={15} /> Arkadaş ekle
                    </button>
                  )}
                  {data.friendship.status === 'blocked' ? (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('unblock')}>
                      Engeli kaldır
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => act('block')}>
                      <Icon name="ban" size={15} /> Engelle
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
