/** Kullanıcı ayarları (hesap, görünüm, gizlilik, güvenlik) ve sunucu ayarları. */
import { useEffect, useState } from 'react';
import type {
  Badge,
  MeUser,
  ModLogEntry,
  PublicUser,
  Role,
  ServerDetail,
  ServerEvent,
  SessionInfo,
  UserSettings,
} from '@shared/types';
import { PERMISSIONS, PERMISSION_LABELS, hasPermission, type PermissionKey } from '@shared/permissions';
import { ApiFailure, authApi, channelsApi, serversApi, socialApi, usersApi } from './api';
import { BADGE_CATALOG, BANNER_PRESETS, DEFAULT_BANNER, MAX_FEATURED_BADGES } from '@shared/badges';
import { Avatar, Icon, Modal, Spinner, fullTime, relative, useToast } from './ui';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'online', label: 'Çevrimiçi' },
  { value: 'idle', label: 'Boşta' },
  { value: 'dnd', label: 'Rahatsız etme' },
  { value: 'invisible', label: 'Görünmez' },
];

/* ------------------------------- kullanıcı ayarı ----------------------------- */

export function UserSettingsModal({
  me,
  onClose,
  onSaved,
  onLogout,
}: {
  me: MeUser;
  onClose: () => void;
  onSaved: (user: MeUser) => void;
  onLogout: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<'account' | 'appearance' | 'whatsnew' | 'privacy' | 'security'>('account');
  const [profileSection, setProfileSection] = useState<'identity' | 'about' | 'banner' | 'badges'>('identity');
  const [displayName, setDisplayName] = useState(me.displayName);
  const [username, setUsername] = useState(me.username);
  const [bio, setBio] = useState(me.bio);
  const [customStatus, setCustomStatus] = useState(me.customStatus);
  const [status, setStatus] = useState(me.status);
  const [theme, setTheme] = useState(me.theme);
  const [settings, setSettings] = useState<UserSettings>(me.settings);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [blocked, setBlocked] = useState<PublicUser[]>([]);
  const [bannerColor, setBannerColor] = useState(me.bannerColor ?? DEFAULT_BANNER);
  const [featuredBadges, setFeaturedBadges] = useState<string[]>(me.featuredBadges ?? []);
  const [earnedBadges, setEarnedBadges] = useState<Badge[]>([]);
  const [bannerUrl, setBannerUrl] = useState<string | null>(me.bannerUrl ?? null);
  const [bannerBusy, setBannerBusy] = useState(false);

  useEffect(() => {
    if (tab !== 'account' || earnedBadges.length > 0) return;
    usersApi
      .profile(me.id)
      .then((result) => setEarnedBadges(result.badges ?? []))
      .catch(() => setEarnedBadges([]));
  }, [tab, me.id, earnedBadges.length]);

  const toggleFeatured = (id: string) => {
    setFeaturedBadges((prev) => {
      if (prev.includes(id)) return prev.filter((value) => value !== id);
      if (prev.length >= MAX_FEATURED_BADGES) {
        toast.push(`En fazla ${MAX_FEATURED_BADGES} rozet seçebilirsiniz.`, 'error');
        return prev;
      }
      return [...prev, id];
    });
  };

  useEffect(() => {
    if (tab === 'security' && !sessions) {
      authApi
        .sessions()
        .then((result) => setSessions(result.sessions))
        .catch(() => setSessions([]));
    }
  }, [tab, sessions]);

  useEffect(() => {
    socialApi
      .friends()
      .then((result) => setBlocked(result.friends.blocked))
      .catch(() => undefined);
  }, []);

  const uploadBannerFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.push('Yalnızca görsel dosyası yükleyebilirsiniz.', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.push('Banner en fazla 8 MB olabilir.', 'error');
      return;
    }
    setBannerBusy(true);
    try {
      const result = await usersApi.uploadBanner(file);
      setBannerUrl(result.bannerUrl);
      onSaved({ ...me, bannerUrl: result.bannerUrl });
      toast.push('Banner görseli güncellendi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Banner yüklenemedi.', 'error');
    } finally {
      setBannerBusy(false);
    }
  };

  const clearBanner = async () => {
    setBannerBusy(true);
    try {
      await usersApi.removeBanner();
      setBannerUrl(null);
      onSaved({ ...me, bannerUrl: null });
      toast.push('Banner görseli kaldırıldı.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Banner kaldırılamadı.', 'error');
    } finally {
      setBannerBusy(false);
    }
  };

  const saveAccount = async () => {
    setBusy(true);
    try {
      const result = await usersApi.updateMe({
        displayName,
        username,
        bio,
        customStatus,
        status,
        bannerColor,
        featuredBadges,
      });
      onSaved(result.user);
      toast.push('Profil güncellendi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Profil güncellenemedi.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (patch: Partial<UserSettings> & { theme?: 'dark' | 'light' }) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (patch.theme) {
      setTheme(patch.theme);
      document.documentElement.dataset.theme = patch.theme;
    }
    try {
      const result = await usersApi.updateSettings(patch);
      setSettings(result.settings);
      toast.push('Tercihler kaydedildi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Tercihler kaydedilemedi.', 'error');
    }
  };

  const uploadAvatar = async (file: File) => {
    try {
      const result = await usersApi.uploadAvatar(file);
      onSaved({ ...me, avatarUrl: result.avatarUrl });
      toast.push('Profil fotoğrafı güncellendi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Fotoğraf yüklenemedi.', 'error');
    }
  };

  const enablePush = async () => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      toast.push('Bu tarayıcı Web Push desteklemiyor.', 'error');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast.push('Bildirim izni verilmedi.', 'error');
      return;
    }
    try {
      const keyResult = await socialApi.pushKey();
      if (!keyResult.configured || !keyResult.publicKey) {
        toast.push('Sunucuda Web Push anahtarları yapılandırılmamış.', 'error');
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyResult.publicKey) as unknown as BufferSource,
      });
      await socialApi.pushSubscribe(subscription.toJSON());
      await saveSettings({ pushEnabled: true });
      toast.push('Web Push bildirimleri açıldı.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Push aboneliği oluşturulamadı.', 'error');
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 8) {
      toast.push('Yeni şifre en az 8 karakter olmalı.', 'error');
      return;
    }
    try {
      await authApi.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setSessions(null);
      toast.push('Şifre değiştirildi, diğer oturumlar kapatıldı.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Şifre değiştirilemedi.', 'error');
    }
  };

  return (
    <Modal title="Kullanıcı ayarları" onClose={onClose} wide>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Ayar bölümleri">
          {(
            [
              ['account', 'Hesap'],
              ['appearance', 'Görünüm'],
              ['whatsnew', 'Yenilikler'],
              ['privacy', 'Gizlilik ve bildirimler'],
              ['security', 'Güvenlik'],
            ] as [typeof tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`btn btn-ghost btn-block${tab === key ? ' active' : ''}`}
              style={tab === key ? { background: 'var(--bg-4)' } : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {tab === 'account' ? (
            <>
              <nav className="seg-nav" aria-label="Profil bölümleri">
                {(
                  [
                    ['identity', 'Kimlik'],
                    ['about', 'Hakkında ve durum'],
                    ['banner', 'Banner'],
                    ['badges', 'Rozetler'],
                  ] as [typeof profileSection, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`seg${profileSection === key ? ' active' : ''}`}
                    aria-pressed={profileSection === key}
                    onClick={() => setProfileSection(key)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {profileSection === 'identity' ? (
                <>
              <div className="row" style={{ gap: 14, alignItems: 'center' }}>
                <Avatar user={{ ...me, displayName }} size={64} />
                <div>
                  <label className="btn btn-ghost btn-sm">
                    Fotoğraf yükle
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadAvatar(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <div className="hint">PNG, JPG veya GIF · en fazla 5 MB</div>
                </div>
              </div>
              <div className="field">
                <label htmlFor="displayName">Görünen ad</label>
                <input id="displayName" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
              </div>
              <div className="field">
                <label htmlFor="username">Kullanıcı adı</label>
                <input
                  id="username"
                  className={`input${usernameError ? ' input-invalid' : ''}`}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  maxLength={24}
                  aria-invalid={usernameError ? true : undefined}
                />
                <div className={usernameError ? 'hint hint-error' : 'hint'}>
                  {usernameError ||
                    '3-24 karakter: küçük harf, sayı, nokta ve alt çizgi. Arkadaşlarınız sizi @ad ile bulur.'}
                </div>
              </div>
                </>
              ) : null}
              {profileSection === 'about' ? (
                <>
              <div className="field">
                <label htmlFor="bio">Hakkında</label>
                <textarea id="bio" className="textarea" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={190} />
              </div>
              <div className="field">
                <label htmlFor="customStatus">Durum mesajı</label>
                <input id="customStatus" className="input" value={customStatus} onChange={(e) => setCustomStatus(e.target.value)} maxLength={80} />
              </div>
              <div className="field">
                <label htmlFor="status">Durum</label>
                <select id="status" className="select" value={status} onChange={(e) => setStatus(e.target.value as MeUser['status'])}>
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
                </>
              ) : null}
              {profileSection === 'banner' ? (
                <>
              <div className="field">
                <label>Profil banner'ı</label>
                <div
                  className="banner-preview"
                  style={
                    bannerUrl
                      ? { backgroundImage: `url(${bannerUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                      : { background: `linear-gradient(135deg, ${bannerColor}, ${bannerColor}99 60%, #7c5cff55)` }
                  }
                >
                  <Avatar user={{ ...me, displayName }} size={56} />
                </div>
                <div className="swatch-row">
                  {BANNER_PRESETS.map((preset) => (
                    <button
                      key={preset.color}
                      type="button"
                      className={`swatch${bannerColor.toLowerCase() === preset.color.toLowerCase() ? ' active' : ''}`}
                      style={{ background: preset.color }}
                      title={preset.label}
                      aria-label={preset.label}
                      onClick={() => setBannerColor(preset.color)}
                    />
                  ))}
                  <label className="swatch swatch-custom" title="Özel renk seç">
                    <Icon name="plus" size={13} />
                    <input
                      type="color"
                      value={bannerColor}
                      aria-label="Özel banner rengi"
                      onChange={(event) => setBannerColor(event.target.value)}
                    />
                  </label>
                </div>
                <div className="hint">Banner rengi profil kartınızın üst şeridinde görünür.</div>
                <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                    <Icon name="plus" size={14} />
                    {bannerBusy ? 'Yükleniyor…' : 'Banner görseli yükle'}
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      aria-label="Banner görseli yükle"
                      onChange={(event) => {
                        void uploadBannerFile(event.target.files?.[0]);
                        event.target.value = '';
                      }}
                    />
                  </label>
                  {bannerUrl ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void clearBanner()} disabled={bannerBusy}>
                      Görseli kaldır
                    </button>
                  ) : null}
                </div>
                <div className="hint">Görsel yüklerseniz renk şeridi yerine bu görsel gösterilir (en fazla 8 MB).</div>
              </div>
                </>
              ) : null}
              {profileSection === 'badges' ? (
                <>
              <div className="field">
                <label>
                  Öne çıkan rozetler{' '}
                  <span className="muted">
                    ({featuredBadges.length}/{MAX_FEATURED_BADGES})
                  </span>
                </label>
                {earnedBadges.length === 0 ? (
                  <div className="hint">
                    Henüz rozet yok. Sohbete katılın, arkadaş edinin veya bir topluluk yönetin.
                  </div>
                ) : (
                  <div className="badge-picker">
                    {earnedBadges.map((badge) => {
                      const active = featuredBadges.includes(badge.id);
                      return (
                        <button
                          key={badge.id}
                          type="button"
                          className={`badge-chip${active ? ' active' : ''}`}
                          style={
                            active
                              ? { color: badge.color, borderColor: `${badge.color}66`, background: `${badge.color}1f` }
                              : undefined
                          }
                          title={badge.description}
                          onClick={() => toggleFeatured(badge.id)}
                        >
                          <Icon name={badge.icon} size={15} />
                          <span className="badge-label">{badge.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="hint">
                  Kazandığınız rozetlerden en fazla {MAX_FEATURED_BADGES} tanesini profil kartınızda öne çıkarın.
                </div>
              </div>
                </>
              ) : null}
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={saveAccount} disabled={busy}>
                  Değişiklikleri kaydet
                </button>
                <span className="hint">{me.email}</span>
              </div>
            </>
          ) : null}

          {tab === 'whatsnew' ? (
            <div className="whatsnew">
              <h3 className="section-title">Yeni özellikler</h3>
              <p className="hint">
                Son güncellemeler ayrı menülere ayrıldı. Bir karta dokunarak ilgili bölüme gidin.
              </p>
              <div className="whatsnew-grid">
                <button
                  type="button"
                  className="whatsnew-card"
                  onClick={() => {
                    setTab('account');
                    setProfileSection('identity');
                  }}
                >
                  <strong>Kimlik bilgileri</strong>
                  <span>Kullanıcı adı artık gerçekten kaydediliyor ve biçimi anında doğrulanıyor.</span>
                </button>
                <button
                  type="button"
                  className="whatsnew-card"
                  onClick={() => {
                    setTab('account');
                    setProfileSection('banner');
                  }}
                >
                  <strong>Profil banner'ı</strong>
                  <span>Renk şeridi seçin veya kendi görselinizi yükleyin.</span>
                </button>
                <button
                  type="button"
                  className="whatsnew-card"
                  onClick={() => {
                    setTab('account');
                    setProfileSection('badges');
                  }}
                >
                  <strong>Rozet vitrini</strong>
                  <span>Kazandığınız rozetlerden en fazla {MAX_FEATURED_BADGES} tanesini öne çıkarın.</span>
                </button>
                <button type="button" className="whatsnew-card" onClick={() => setTab('appearance')}>
                  <strong>Görünüm ve vurgu rengi</strong>
                  <span>Tema, vurgu rengi, mesaj yoğunluğu ve kompakt mod.</span>
                </button>
                <button type="button" className="whatsnew-card" onClick={() => setTab('privacy')}>
                  <strong>Bildirimler</strong>
                  <span>Masaüstü bildirimleri, sesler ve gizlilik tercihleri.</span>
                </button>
                <button type="button" className="whatsnew-card" onClick={() => setTab('security')}>
                  <strong>Oturum güvenliği</strong>
                  <span>Aktif oturumları görün, şifrenizi değiştirin.</span>
                </button>
              </div>
              <h3 className="section-title">Topluluk şablonları</h3>
              <p className="hint">
                Topluluk oluştururken Oyun, Çalışma veya Topluluk şablonu seçerek hazır kategori ve kanal düzeni kurun.
              </p>
            </div>
          ) : null}

          {tab === 'appearance' ? (
            <>
              <div className="field">
                <label>Tema</label>
                <div className="row">
                  <button type="button" className={`btn ${theme === 'dark' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => saveSettings({ theme: 'dark' })}>
                    <Icon name="moon" size={15} /> Koyu
                  </button>
                  <button type="button" className={`btn ${theme === 'light' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => saveSettings({ theme: 'light' })}>
                    <Icon name="sun" size={15} /> Açık
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Vurgu rengi</label>
                <div className="swatch-row">
                  {['#7c5cff', '#4f7dff', '#22d3ee', '#f472b6', '#34d399', '#fbbf24'].map((accent) => (
                    <button
                      key={accent}
                      type="button"
                      className={`swatch${settings.accentColor?.toLowerCase() === accent ? ' active' : ''}`}
                      style={{ background: accent }}
                      title={accent}
                      aria-label={`Vurgu rengi ${accent}`}
                      onClick={() => saveSettings({ accentColor: accent })}
                    />
                  ))}
                  <label className="swatch swatch-custom" title="Özel vurgu rengi">
                    <Icon name="plus" size={13} />
                    <input
                      type="color"
                      value={settings.accentColor ?? '#7c5cff'}
                      aria-label="Özel vurgu rengi"
                      onChange={(event) => saveSettings({ accentColor: event.target.value })}
                    />
                  </label>
                </div>
                <div className="hint">Düğmeler, bağlantılar ve vurgu çizgileri bu rengi kullanır.</div>
              </div>
              <div className="field">
                <label>Mesaj yoğunluğu</label>
                <div className="row">
                  <button
                    type="button"
                    className={`btn ${settings.messageDensity === 'cozy' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => saveSettings({ messageDensity: 'cozy' })}
                  >
                    Rahat
                  </button>
                  <button
                    type="button"
                    className={`btn ${settings.messageDensity === 'compact' ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => saveSettings({ messageDensity: 'compact' })}
                  >
                    Kompakt
                  </button>
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.compactMode}
                  onChange={(event) => saveSettings({ compactMode: event.target.checked })}
                />
                <span className="track" />
                <span style={{ fontSize: 13.5 }}>Kompakt mod (daha küçük yazı ve dar boşluklar)</span>
              </label>
              <div className="field">
                <label>Ses efektleri</label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.soundsEnabled}
                    onChange={(e) => saveSettings({ soundsEnabled: e.target.checked })}
                  />
                  <span className="track" />
                  <span style={{ fontSize: 13.5 }}>Bildirim seslerini çal</span>
                </label>
              </div>
            </>
          ) : null}

          {tab === 'privacy' ? (
            <>
              <div className="field">
                <label htmlFor="dmPrivacy">Özel mesaj izni</label>
                <select
                  id="dmPrivacy"
                  className="select"
                  value={settings.dmPrivacy}
                  onChange={(e) => saveSettings({ dmPrivacy: e.target.value as UserSettings['dmPrivacy'] })}
                >
                  <option value="everyone">Herkes</option>
                  <option value="friends">Yalnızca arkadaşlar</option>
                </select>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.notificationsEnabled}
                  onChange={(e) => saveSettings({ notificationsEnabled: e.target.checked })}
                />
                <span className="track" />
                <span style={{ fontSize: 13.5 }}>Uygulama içi bildirimler</span>
              </label>
              <label className="switch" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={settings.pushEnabled} onChange={() => (settings.pushEnabled ? saveSettings({ pushEnabled: false }) : enablePush())} />
                <span className="track" />
                <span style={{ fontSize: 13.5 }}>Tarayıcı Web Push bildirimleri</span>
              </label>
              <div className="hint" style={{ marginTop: 8 }}>
                Web Push için sunucuda VAPID anahtarları gerekir; anahtar yoksa yalnızca uygulama içi bildirimler çalışır.
              </div>

              <div className="sidebar-label" style={{ marginTop: 18 }}>Engellenen kullanıcılar</div>
              {blocked.length === 0 ? (
                <div className="hint">Engellenen kullanıcı yok.</div>
              ) : (
                blocked.map((user) => (
                  <div key={user.id} className="member-row">
                    <Avatar user={user} size={28} />
                    <span style={{ flex: 1 }}>{user.displayName}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        try {
                          await socialApi.unblock(user.id);
                          setBlocked((prev) => prev.filter((u) => u.id !== user.id));
                          toast.push('Engel kaldırıldı.', 'success');
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'İşlem başarısız.', 'error');
                        }
                      }}
                    >
                      Kaldır
                    </button>
                  </div>
                ))
              )}
            </>
          ) : null}

          {tab === 'security' ? (
            <>
              <div className="field">
                <label htmlFor="currentPassword">Mevcut şifre</label>
                <input
                  id="currentPassword"
                  className="input"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="field">
                <label htmlFor="newPassword">Yeni şifre</label>
                <input
                  id="newPassword"
                  className="input"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <div className="hint">En az 8 karakter. Diğer oturumlar kapatılır.</div>
              </div>
              <button type="button" className="btn btn-primary" onClick={changePassword}>
                Şifreyi değiştir
              </button>

              <div className="sidebar-label" style={{ marginTop: 20 }}>Oturumlar</div>
              {sessions === null ? (
                <Spinner label="Oturumlar yükleniyor…" />
              ) : sessions.length === 0 ? (
                <div className="hint">Oturum bilgisi yok.</div>
              ) : (
                sessions.map((session) => (
                  <div key={session.id} className="member-row">
                    <Icon name="shield" size={16} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 13 }}>
                        {session.userAgent || 'Bilinmeyen tarayıcı'} {session.current ? <span className="chip">bu oturum</span> : null}
                      </div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {fullTime(session.createdAt)} · son görülme {relative(session.lastSeenAt)}
                      </div>
                    </div>
                    {!session.current ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          try {
                            await authApi.revokeSession(session.id);
                            setSessions((prev) => (prev ?? []).filter((s) => s.id !== session.id));
                            toast.push('Oturum kapatıldı.', 'success');
                          } catch (err) {
                            toast.push(err instanceof ApiFailure ? err.message : 'Oturum kapatılamadı.', 'error');
                          }
                        }}
                      >
                        Kapat
                      </button>
                    ) : null}
                  </div>
                ))
              )}
              <button type="button" className="btn btn-danger" style={{ marginTop: 18 }} onClick={onLogout}>
                <Icon name="logout" size={15} /> Çıkış yap
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/* -------------------------------- sunucu ayarı ------------------------------- */

type ServerTab = 'general' | 'roles' | 'channels' | 'invites' | 'moderation' | 'webhooks' | 'events' | 'stats' | 'danger';

export function ServerSettingsModal({
  server,
  onClose,
  onChanged,
  onDeleted,
}: {
  server: ServerDetail;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<ServerTab>('general');
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [isPublic, setIsPublic] = useState(server.isPublic);
  const [iconColor, setIconColor] = useState(server.iconColor);
  const [invites, setInvites] = useState<{ code: string; uses: number; maxUses: number | null; expiresAt: number | null }[]>([]);
  const [bans, setBans] = useState<{ user: PublicUser | null; reason: string; createdAt: number }[]>([]);
  const [reports, setReports] = useState<{ id: string; reason: string; status: string; createdAt: number; reporter: PublicUser | null; target: PublicUser | null }[]>([]);
  const [modLog, setModLog] = useState<ModLogEntry[]>([]);
  const [webhooks, setWebhooks] = useState<{ id: string; name: string; channelId: string; token: string }[]>([]);
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [stats, setStats] = useState<{ members: number; messages: number; channels: number; online: number } | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState('text');
  const [newCategory, setNewCategory] = useState('');
  const [newInviteUses, setNewInviteUses] = useState(0);
  const [newInviteHours, setNewInviteHours] = useState(24);
  const [eventTitle, setEventTitle] = useState('');
  const [eventStarts, setEventStarts] = useState('');
  const [webhookName, setWebhookName] = useState('');

  const canManageServer = hasPermission(server.myPermissions, PERMISSIONS.MANAGE_SERVER);
  const canManageRoles = hasPermission(server.myPermissions, PERMISSIONS.MANAGE_ROLES);
  const canManageChannels = hasPermission(server.myPermissions, PERMISSIONS.MANAGE_CHANNELS);
  const canManageMembers = hasPermission(server.myPermissions, PERMISSIONS.MANAGE_MEMBERS);
  const canInvite = hasPermission(server.myPermissions, PERMISSIONS.CREATE_INVITES);
  const canModerate = hasPermission(server.myPermissions, PERMISSIONS.KICK_MEMBERS);

  useEffect(() => {
    const load = async () => {
      try {
        if (tab === 'invites') setInvites((await serversApi.invites(server.id)).invites);
        if (tab === 'moderation') {
          const [banList, reportList, log] = await Promise.all([
            serversApi.bans(server.id),
            serversApi.reports(server.id),
            serversApi.modLog(server.id),
          ]);
          setBans(banList.bans);
          setReports(reportList.reports);
          setModLog(log.entries);
        }
        if (tab === 'webhooks') setWebhooks((await serversApi.webhooks(server.id)).webhooks);
        if (tab === 'events') setEvents((await serversApi.events(server.id)).events);
        if (tab === 'stats') setStats((await serversApi.stats(server.id)).stats);
      } catch (err) {
        toast.push(err instanceof ApiFailure ? err.message : 'Ayarlar yüklenemedi.', 'error');
      }
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, server.id]);

  const saveGeneral = async () => {
    try {
      await serversApi.update(server.id, { name, description, isPublic, iconColor });
      await onChanged();
      toast.push('Sunucu güncellendi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Sunucu güncellenemedi.', 'error');
    }
  };

  const updateRolePermissions = async (role: Role, key: PermissionKey, enabled: boolean) => {
    const bit = PERMISSIONS[key];
    const permissions = enabled ? role.permissions | bit : role.permissions & ~bit;
    try {
      await serversApi.updateRole(server.id, role.id, { permissions });
      await onChanged();
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Rol güncellenemedi.', 'error');
    }
  };

  return (
    <Modal title={`${server.name} ayarları`} onClose={onClose} wide>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Sunucu ayar bölümleri">
          {(
            [
              ['general', 'Genel'],
              ['roles', 'Roller'],
              ['channels', 'Kanallar'],
              ['invites', 'Davetler'],
              ['moderation', 'Moderasyon'],
              ['webhooks', 'Webhook'],
              ['events', 'Etkinlikler'],
              ['stats', 'İstatistikler'],
              ['danger', 'Tehlikeli bölge'],
            ] as [ServerTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="btn btn-ghost btn-block"
              style={tab === key ? { background: 'var(--bg-4)' } : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {tab === 'general' ? (
            <>
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                <Avatar user={{ displayName: name, avatarColor: iconColor, avatarUrl: server.iconUrl }} size={56} square />
                <input
                  type="color"
                  aria-label="Sunucu rengi"
                  value={iconColor}
                  onChange={(e) => setIconColor(e.target.value)}
                  style={{ width: 44, height: 36, background: 'transparent', border: 'none' }}
                />
              </div>
              <div className="field">
                <label htmlFor="serverName">Sunucu adı</label>
                <input id="serverName" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} disabled={!canManageServer} />
              </div>
              <div className="field">
                <label htmlFor="serverDesc">Açıklama</label>
                <textarea id="serverDesc" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={!canManageServer} />
              </div>
              <label className="switch">
                <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} disabled={!canManageServer} />
                <span className="track" />
                <span style={{ fontSize: 13.5 }}>Sunucuyu keşfet listesinde göster</span>
              </label>
              <div className="row" style={{ marginTop: 14 }}>
                <button type="button" className="btn btn-primary" onClick={saveGeneral} disabled={!canManageServer}>
                  Kaydet
                </button>
                <span className="hint">Sunucu kimliği: {server.id}</span>
              </div>
            </>
          ) : null}

          {tab === 'roles' ? (
            <>
              {server.roles.map((role) => (
                <div key={role.id} className="card" style={{ marginBottom: 10 }}>
                  <div className="row-between">
                    <div className="row">
                      <span className="role-dot" style={{ background: role.color }} />
                      <strong>{role.name}</strong>
                      {role.isDefault ? <span className="chip">varsayılan</span> : null}
                    </div>
                    {!role.isDefault && canManageRoles ? (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Rolü sil"
                        onClick={async () => {
                          if (!window.confirm(`${role.name} rolü silinsin mi?`)) return;
                          try {
                            await serversApi.deleteRole(server.id, role.id);
                            await onChanged();
                            toast.push('Rol silindi.', 'success');
                          } catch (err) {
                            toast.push(err instanceof ApiFailure ? err.message : 'Rol silinemedi.', 'error');
                          }
                        }}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    ) : null}
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 8, gap: 6 }}>
                    {(Object.keys(PERMISSION_LABELS) as PermissionKey[]).map((key) => {
                      const active = (role.permissions & PERMISSIONS[key]) !== 0;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`chip${active ? ' active' : ''}`}
                          style={active ? { borderColor: 'var(--brand)', color: 'var(--text-1)' } : undefined}
                          onClick={() => canManageRoles && updateRolePermissions(role, key, !active)}
                          aria-pressed={active}
                        >
                          {PERMISSION_LABELS[key]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {canManageRoles ? (
                <div className="row">
                  <input className="input" placeholder="Yeni rol adı" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      if (!newRoleName.trim()) return;
                      try {
                        await serversApi.createRole(server.id, { name: newRoleName.trim(), color: '#7c5cff' });
                        setNewRoleName('');
                        await onChanged();
                        toast.push('Rol oluşturuldu.', 'success');
                      } catch (err) {
                        toast.push(err instanceof ApiFailure ? err.message : 'Rol oluşturulamadı.', 'error');
                      }
                    }}
                  >
                    Rol ekle
                  </button>
                </div>
              ) : null}

              <div className="sidebar-label" style={{ marginTop: 18 }}>Üye rolleri</div>
              {server.members.slice(0, 30).map((member) => (
                <div key={member.userId} className="member-row">
                  <Avatar user={{ ...member, avatarUrl: member.avatarUrl }} size={28} showStatus />
                  <span style={{ flex: 1 }} className="truncate">
                    {member.nickname ?? member.displayName}
                  </span>
                  <select
                    className="select"
                    style={{ maxWidth: 190 }}
                    value={member.roleIds[0] ?? ''}
                    onChange={async (e) => {
                      const roleIds = e.target.value ? [e.target.value] : [];
                      try {
                        await serversApi.setMemberRoles(server.id, member.userId, roleIds);
                        await onChanged();
                      } catch (err) {
                        toast.push(err instanceof ApiFailure ? err.message : 'Roller güncellenemedi.', 'error');
                      }
                    }}
                    disabled={!canManageRoles}
                  >
                    <option value="">Rol yok</option>
                    {server.roles.filter((role) => !role.isDefault).map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </>
          ) : null}

          {tab === 'channels' ? (
            <>
              {server.categories.map((category) => (
                <div key={category.id} className="card" style={{ marginBottom: 10 }}>
                  <div className="row-between">
                    <strong>{category.name}</strong>
                    {canManageChannels ? (
                      <div className="row">
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Kategori adını değiştir"
                          onClick={async () => {
                            const value = window.prompt('Yeni kategori adı', category.name);
                            if (!value) return;
                            try {
                              await serversApi.updateCategory(server.id, category.id, value);
                              await onChanged();
                            } catch (err) {
                              toast.push(err instanceof ApiFailure ? err.message : 'Güncellenemedi.', 'error');
                            }
                          }}
                        >
                          <Icon name="edit" size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Kategoriyi sil"
                          onClick={async () => {
                            if (!window.confirm(`${category.name} kategorisi silinsin mi?`)) return;
                            try {
                              await serversApi.deleteCategory(server.id, category.id);
                              await onChanged();
                            } catch (err) {
                              toast.push(err instanceof ApiFailure ? err.message : 'Silinemedi.', 'error');
                            }
                          }}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {server.channels
                    .filter((channel) => channel.categoryId === category.id)
                    .map((channel) => (
                      <div key={channel.id} className="channel-row">
                        <Icon name={channel.type === 'voice' ? 'volume' : 'hash'} size={15} />
                        <span style={{ flex: 1 }}>{channel.name}</span>
                        {channel.isPrivate ? <span className="chip">özel</span> : null}
                        <span className="muted" style={{ fontSize: 11 }}>
                          {channel.type}
                        </span>
                        {canManageChannels ? (
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label="Kanalı sil"
                            onClick={async () => {
                              if (!window.confirm(`#${channel.name} silinsin mi?`)) return;
                              try {
                                await channelsDelete(channel.id);
                                await onChanged();
                              } catch (err) {
                                toast.push(err instanceof ApiFailure ? err.message : 'Kanal silinemedi.', 'error');
                              }
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        ) : null}
                      </div>
                    ))}
                </div>
              ))}
              {canManageChannels ? (
                <>
                  <div className="row">
                    <input className="input" placeholder="Yeni kategori" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={async () => {
                        if (!newCategory.trim()) return;
                        try {
                          await serversApi.createCategory(server.id, newCategory.trim());
                          setNewCategory('');
                          await onChanged();
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Kategori oluşturulamadı.', 'error');
                        }
                      }}
                    >
                      Kategori ekle
                    </button>
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <input className="input" placeholder="Yeni kanal" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
                    <select className="select" style={{ maxWidth: 130 }} value={newChannelType} onChange={(e) => setNewChannelType(e.target.value)}>
                      <option value="text">Metin</option>
                      <option value="voice">Sesli</option>
                      <option value="forum">Forum</option>
                      <option value="announcement">Duyuru</option>
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={async () => {
                        if (!newChannelName.trim()) return;
                        try {
                          await channelsApi.create(server.id, { name: newChannelName.trim(), type: newChannelType });
                          setNewChannelName('');
                          await onChanged();
                          toast.push('Kanal oluşturuldu.', 'success');
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Kanal oluşturulamadı.', 'error');
                        }
                      }}
                    >
                      Kanal ekle
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'invites' ? (
            <>
              {canInvite ? (
                <div className="row" style={{ marginBottom: 12 }}>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={newInviteUses}
                    onChange={(e) => setNewInviteUses(Number(e.target.value))}
                    aria-label="Maksimum kullanım"
                  />
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={newInviteHours}
                    onChange={(e) => setNewInviteHours(Number(e.target.value))}
                    aria-label="Geçerlilik (saat)"
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      try {
                        const result = await serversApi.createInvite(server.id, {
                          maxUses: newInviteUses || undefined,
                          expiresInHours: newInviteHours || undefined,
                        });
                        setInvites((prev) => [{ code: result.invite.code, uses: 0, maxUses: result.invite.maxUses, expiresAt: result.invite.expiresAt }, ...prev]);
                        await navigator.clipboard?.writeText(`${location.origin}/invite/${result.invite.code}`).catch(() => undefined);
                        toast.push('Davet oluşturuldu ve kopyalandı.', 'success');
                      } catch (err) {
                        toast.push(err instanceof ApiFailure ? err.message : 'Davet oluşturulamadı.', 'error');
                      }
                    }}
                  >
                    Davet oluştur
                  </button>
                </div>
              ) : null}
              {invites.length === 0 ? (
                <div className="hint">Aktif davet yok.</div>
              ) : (
                invites.map((invite) => (
                  <div key={invite.code} className="member-row">
                    <Icon name="link" size={15} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 13 }}>
                        /invite/{invite.code}
                      </div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {invite.uses} kullanım{invite.maxUses ? ` / ${invite.maxUses}` : ''}
                        {invite.expiresAt ? ` · ${fullTime(invite.expiresAt)}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`).then(() => toast.push('Bağlantı kopyalandı.', 'success'))}
                    >
                      <Icon name="copy" size={13} /> Kopyala
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Daveti sil"
                      onClick={async () => {
                        try {
                          await serversApi.deleteInvite(server.id, invite.code);
                          setInvites((prev) => prev.filter((i) => i.code !== invite.code));
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Davet silinemedi.', 'error');
                        }
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))
              )}
            </>
          ) : null}

          {tab === 'moderation' ? (
            <>
              <div className="sidebar-label">Yasaklananlar</div>
              {bans.length === 0 ? <div className="hint">Yasaklı üye yok.</div> : null}
              {bans.map((ban) => (
                <div key={ban.user?.id ?? ban.createdAt} className="member-row">
                  {ban.user ? <Avatar user={ban.user} size={28} /> : <Icon name="ban" size={16} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="truncate">{ban.user?.displayName ?? 'Bilinmeyen'}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {ban.reason || 'neden belirtilmedi'} · {relative(ban.createdAt)}
                    </div>
                  </div>
                  {canModerate && ban.user ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        try {
                          await serversApi.unban(server.id, ban.user!.id);
                          setBans((prev) => prev.filter((b) => b.user?.id !== ban.user!.id));
                          toast.push('Yasak kaldırıldı.', 'success');
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Yasak kaldırılamadı.', 'error');
                        }
                      }}
                    >
                      Yasağı kaldır
                    </button>
                  ) : null}
                </div>
              ))}

              <div className="sidebar-label" style={{ marginTop: 16 }}>Şikâyetler</div>
              {reports.length === 0 ? <div className="hint">Şikâyet yok.</div> : null}
              {reports.map((report) => (
                <div key={report.id} className="card" style={{ marginBottom: 8 }}>
                  <div className="row-between">
                    <strong>{report.reporter?.displayName ?? 'Bilinmeyen'} · {report.status}</strong>
                    <span className="muted" style={{ fontSize: 11 }}>{relative(report.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{report.reason}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    {(['resolved', 'dismissed'] as const).map((status) => (
                      <button
                        key={status}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          try {
                            await serversApi.updateReport(server.id, report.id, status);
                            setReports((prev) => prev.map((r) => (r.id === report.id ? { ...r, status } : r)));
                          } catch (err) {
                            toast.push(err instanceof ApiFailure ? err.message : 'Güncellenemedi.', 'error');
                          }
                        }}
                      >
                        {status === 'resolved' ? 'Çözüldü' : 'Yok say'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div className="sidebar-label" style={{ marginTop: 16 }}>Moderasyon kaydı</div>
              {modLog.length === 0 ? <div className="hint">Kayıt yok.</div> : null}
              {modLog.map((entry) => (
                <div key={entry.id} className="row" style={{ fontSize: 12.5, padding: '4px 0' }}>
                  <span className="chip">{entry.action}</span>
                  <span className="truncate" style={{ flex: 1 }}>
                    {entry.actor?.displayName ?? 'sistem'} → {entry.target?.displayName ?? '-'} {entry.reason ? `· ${entry.reason}` : ''}
                  </span>
                  <span className="muted">{relative(entry.createdAt)}</span>
                </div>
              ))}
            </>
          ) : null}

          {tab === 'webhooks' ? (
            <>
              <div className="hint">Webhook ile harici servislerden kanala mesaj gönderin.</div>
              <div className="row" style={{ marginTop: 10 }}>
                <input className="input" placeholder="Webhook adı" value={webhookName} onChange={(e) => setWebhookName(e.target.value)} />
                <select className="select" id="webhookChannel" defaultValue={server.channels[0]?.id ?? ''}>
                  {server.channels.filter((c) => c.type === 'text' || c.type === 'announcement').map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    const channelId = (document.getElementById('webhookChannel') as HTMLSelectElement | null)?.value;
                    if (!webhookName.trim() || !channelId) return;
                    try {
                      const result = await serversApi.createWebhook(server.id, { name: webhookName.trim(), channelId });
                      setWebhooks((prev) => [...prev, { ...result.webhook, channelId }]);
                      setWebhookName('');
                      toast.push('Webhook oluşturuldu.', 'success');
                    } catch (err) {
                      toast.push(err instanceof ApiFailure ? err.message : 'Webhook oluşturulamadı.', 'error');
                    }
                  }}
                >
                  Ekle
                </button>
              </div>
              {webhooks.map((hook) => (
                <div key={hook.id} className="card" style={{ marginTop: 10 }}>
                  <div className="row-between">
                    <strong>{hook.name}</strong>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Webhook sil"
                      onClick={async () => {
                        try {
                          await serversApi.deleteWebhook(server.id, hook.id);
                          setWebhooks((prev) => prev.filter((h) => h.id !== hook.id));
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Silinemedi.', 'error');
                        }
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <code className="truncate" style={{ flex: 1, fontSize: 11.5 }}>
                      POST {location.origin}/api/webhooks/{hook.id}/{hook.token}
                    </code>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        navigator.clipboard
                          ?.writeText(`${location.origin}/api/webhooks/${hook.id}/${hook.token}`)
                          .then(() => toast.push('Webhook adresi kopyalandı.', 'success'))
                      }
                    >
                      Kopyala
                    </button>
                  </div>
                </div>
              ))}
            </>
          ) : null}

          {tab === 'events' ? (
            <>
              <div className="row">
                <input className="input" placeholder="Etkinlik başlığı" value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} />
                <input
                  className="input"
                  type="datetime-local"
                  value={eventStarts}
                  onChange={(e) => setEventStarts(e.target.value)}
                  aria-label="Başlangıç"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    if (!eventTitle.trim() || !eventStarts) return;
                    try {
                      await serversApi.createEvent(server.id, {
                        title: eventTitle.trim(),
                        startsAt: new Date(eventStarts).getTime(),
                      });
                      setEventTitle('');
                      setEventStarts('');
                      setEvents((await serversApi.events(server.id)).events);
                      toast.push('Etkinlik oluşturuldu.', 'success');
                    } catch (err) {
                      toast.push(err instanceof ApiFailure ? err.message : 'Etkinlik oluşturulamadı.', 'error');
                    }
                  }}
                >
                  Oluştur
                </button>
              </div>
              {events.length === 0 ? <div className="hint" style={{ marginTop: 10 }}>Yaklaşan etkinlik yok.</div> : null}
              {events.map((event) => (
                <div key={event.id} className="card" style={{ marginTop: 10 }}>
                  <div className="row-between">
                    <strong>{event.title}</strong>
                    <span className="muted" style={{ fontSize: 11.5 }}>{fullTime(event.startsAt)}</span>
                  </div>
                  {event.description ? <div style={{ fontSize: 13 }}>{event.description}</div> : null}
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="chip">{event.attendees.filter((a) => a.status === 'going').length} katılıyor</span>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={async () => {
                        try {
                          await serversApi.rsvp(server.id, event.id, 'going');
                          setEvents((await serversApi.events(server.id)).events);
                          toast.push('Etkinliğe katılıyorsunuz.', 'success');
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Katılım kaydedilemedi.', 'error');
                        }
                      }}
                    >
                      Katıl
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        try {
                          await serversApi.deleteEvent(server.id, event.id);
                          setEvents((prev) => prev.filter((e) => e.id !== event.id));
                        } catch (err) {
                          toast.push(err instanceof ApiFailure ? err.message : 'Etkinlik silinemedi.', 'error');
                        }
                      }}
                    >
                      Sil
                    </button>
                  </div>
                </div>
              ))}
            </>
          ) : null}

          {tab === 'stats' ? (
            stats === null ? (
              <Spinner label="İstatistikler yükleniyor…" />
            ) : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                {[
                  ['Üye', stats.members],
                  ['Çevrimiçi', stats.online],
                  ['Kanal', stats.channels],
                  ['Mesaj', stats.messages],
                ].map(([label, value]) => (
                  <div key={String(label)} className="card" style={{ minWidth: 120 }}>
                    <div className="muted" style={{ fontSize: 12 }}>{label}</div>
                    <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
                  </div>
                ))}
              </div>
            )
          ) : null}

          {tab === 'danger' ? (
            <>
              <div className="sidebar-label">Sahiplik devri</div>
              <div className="row">
                <select className="select" id="transferTarget" defaultValue="">
                  <option value="">Üye seçin</option>
                  {server.members
                    .filter((member) => member.userId !== server.ownerId)
                    .map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={async () => {
                    const target = (document.getElementById('transferTarget') as HTMLSelectElement | null)?.value;
                    if (!target) return;
                    if (!window.confirm('Sunucu sahipliğini bu üyeye devretmek istiyor musunuz?')) return;
                    try {
                      await serversApi.transfer(server.id, target);
                      await onChanged();
                      toast.push('Sahiplik devredildi.', 'success');
                    } catch (err) {
                      toast.push(err instanceof ApiFailure ? err.message : 'Devredilemedi.', 'error');
                    }
                  }}
                >
                  Devret
                </button>
              </div>
              <div className="sidebar-label" style={{ marginTop: 20 }}>Sunucuyu sil</div>
              <p className="hint">Bu işlem geri alınamaz; tüm kanallar ve mesajlar silinir.</p>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  if (!window.confirm(`${server.name} sunucusu kalıcı olarak silinsin mi?`)) return;
                  try {
                    await serversApi.remove(server.id);
                    toast.push('Sunucu silindi.', 'success');
                    onDeleted();
                  } catch (err) {
                    toast.push(err instanceof ApiFailure ? err.message : 'Sunucu silinemedi.', 'error');
                  }
                }}
              >
                <Icon name="trash" size={15} /> Sunucuyu sil
              </button>
              {!canManageMembers ? <div className="hint" style={{ marginTop: 10 }}>Bu işlemler için yönetici izni gerekir.</div> : null}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

async function channelsDelete(channelId: string): Promise<void> {
  const { channelsApi } = await import('./api');
  await channelsApi.deleteChannel(channelId);
}
