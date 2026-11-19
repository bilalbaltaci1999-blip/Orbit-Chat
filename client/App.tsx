/** ORBIT uygulama kabuğu: kimlik doğrulama, gezinme, gerçek zamanlı olaylar, bildirimler. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  Bootstrap,
  Channel,
  DmChannel,
  MeUser,
  Message,
  Notification,
  PublicUser,
  ServerDetail,
  UserStatus,
} from '@shared/types';
import { ApiFailure, authApi, discoverApi, serversApi, socialApi } from './api';
import { Avatar, EmptyState, Icon, Modal, Spinner, ToastProvider, relative, useToast } from './ui';
import Chat from './Chat';
import FriendsView, { DiscoverView } from './Friends';
import VoiceRoom from './Voice';
import { ServerSettingsModal, UserSettingsModal } from './Settings';
import { ProfileCard } from './Profile';

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';
type View = 'server' | 'dm' | 'friends' | 'discover';

/* --------------------------------- giriş ekranı ------------------------------- */

function AuthScreen({ onAuthed }: { onAuthed: () => Promise<boolean> }) {
  const toast = useToast();
  const params = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<AuthMode>(params.get('reset') ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(params.get('reset') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** Sunucu kurallarıyla aynı doğrulama: hata mesajı gelmeden alan bazında uyarı. */
  const validate = (): Record<string, string> => {
    const problems: Record<string, string> = {};
    if (mode !== 'reset' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      problems.email = 'Geçerli bir e-posta adresi girin.';
    }
    if (mode === 'register' && !/^[a-zA-Z0-9_.]{3,24}$/.test(username.trim())) {
      problems.username = '3-24 karakter; harf, rakam, nokta veya alt çizgi kullanın.';
    }
    if ((mode === 'register' || mode === 'reset') && password.length > 0) {
      if (password.length < 8) problems.password = 'Şifre en az 8 karakter olmalı.';
      else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        problems.password = 'Şifre en az bir harf ve bir rakam içermeli.';
      }
    }
    return problems;
  };

  const sessionProblem =
    'İşlem tamamlandı ancak oturum tarayıcıya kaydedilemedi. Çerezleri engelleyen bir eklenti veya gizli sekme kullanıyorsanız kapatıp tekrar deneyin.';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setDevResetUrl(null);
    const problems = validate();
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) {
      setError('Lütfen işaretli alanları düzeltin.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await authApi.login(email.trim(), password);
        if (!(await onAuthed())) setError(sessionProblem);
      } else if (mode === 'register') {
        await authApi.register({
          email: email.trim(),
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          password,
        });
        if (!(await onAuthed())) setError(sessionProblem);
      } else if (mode === 'forgot') {
        const result = await authApi.forgotPassword(email.trim());
        setNotice(result.message ?? 'Sıfırlama bağlantısı e-posta adresinize gönderildi.');
        if (result.resetUrl) setDevResetUrl(result.resetUrl);
      } else {
        await authApi.resetPassword(token.trim(), password);
        toast.push('Şifreniz güncellendi. Yeni şifrenizle giriş yapın.', 'success');
        setMode('login');
        setPassword('');
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (err) {
      if (err instanceof ApiFailure) {
        setFieldErrors(err.details ?? {});
        if (err.code === 'EMAIL_TAKEN' && mode === 'register') {
          setMode('login');
          setPassword('');
          setError(null);
          setNotice('Bu e-posta ile bir hesap var. Şifrenizle giriş yapın veya "Şifremi unuttum" ile sıfırlayın.');
        } else if (err.code === 'USERNAME_TAKEN' && mode === 'register') {
          setError('Bu kullanıcı adı alınmış. Farklı bir kullanıcı adı deneyin.');
        } else if (err.code === 'INVALID_CREDENTIALS') {
          setError('E-posta veya şifre hatalı. Hesabınız yoksa "Hesap oluştur" sekmesinden kayıt olabilirsiniz.');
        } else {
          setError(err.message);
        }
      } else {
        setError('İşlem tamamlanamadı, tekrar deneyin.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">
            <Icon name="compass" size={26} />
          </span>
          <div>
            <div className="auth-title">ORBIT</div>
            <div className="auth-sub">Topluluk, sohbet ve sesli iletişim</div>
          </div>
        </div>

        {mode === 'login' || mode === 'register' ? (
          <div className="auth-tabs" role="tablist" aria-label="Giriş veya kayıt">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''}
              onClick={() => {
                setMode('login');
                setError(null);
                setFieldErrors({});
              }}
            >
              Giriş yap
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'active' : ''}
              onClick={() => {
                setMode('register');
                setError(null);
                setFieldErrors({});
              }}
            >
              Hesap oluştur
            </button>
          </div>
        ) : null}

        <form onSubmit={submit} className="stack">
          {mode === 'register' ? (
            <>
              <label className="field">
                <span>Kullanıcı adı</span>
                <input
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="orbit_kullanici"
                  autoComplete="username"
                  minLength={3}
                  maxLength={24}
                  required
                />
                <span className="hint">3-24 karakter · harf, rakam, nokta veya alt çizgi</span>
                {fieldErrors.username ? <span className="field-error">{fieldErrors.username}</span> : null}
              </label>
              <label className="field">
                <span>Görünen ad</span>
                <input
                  className="input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Görünen adınız"
                  maxLength={32}
                />
                {fieldErrors.displayName ? <span className="field-error">{fieldErrors.displayName}</span> : null}
              </label>
            </>
          ) : null}

          {mode !== 'reset' ? (
            <label className="field">
              <span>E-posta</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ornek@orbit.app"
                autoComplete="email"
                required
              />
              {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
            </label>
          ) : (
            <label className="field">
              <span>Sıfırlama kodu</span>
              <input className="input" value={token} onChange={(e) => setToken(e.target.value)} required />
            </label>
          )}

          {mode !== 'forgot' ? (
            <label className="field">
              <span>{mode === 'reset' ? 'Yeni şifre' : 'Şifre'}</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'login' ? undefined : 8}
                required
              />
              {mode === 'register' || mode === 'reset' ? (
                <span className="hint">En az 8 karakter, bir harf ve bir rakam.</span>
              ) : null}
              {fieldErrors.password ? <span className="field-error">{fieldErrors.password}</span> : null}
            </label>
          ) : null}

          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p className="auth-note">{notice}</p> : null}
          {devResetUrl ? (
            <p className="auth-note">
              Geliştirme bağlantısı:{' '}
              <a className="link-btn" href={devResetUrl}>
                şifreyi sıfırla
              </a>
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? (
              'İşleniyor…'
            ) : mode === 'login' ? (
              'Giriş yap'
            ) : mode === 'register' ? (
              'Hesap oluştur'
            ) : mode === 'forgot' ? (
              'Sıfırlama bağlantısı gönder'
            ) : (
              'Şifreyi güncelle'
            )}
          </button>
        </form>

        <div className="auth-footer">
          {mode === 'login' ? (
            <>
              <button type="button" className="link-btn" onClick={() => setMode('forgot')}>
                Şifremi unuttum
              </button>
              <span className="muted">•</span>
              <button type="button" className="link-btn" onClick={() => setMode('register')}>
                Yeni hesap
              </button>
            </>
          ) : (
            <button type="button" className="link-btn" onClick={() => setMode('login')}>
              Giriş ekranına dön
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- profil kartı ------------------------------ */

function ProfileModal({
  userId,
  onClose,
  onStartDm,
  onChanged,
  onOpenSettings,
}: {
  userId: string;
  onClose: () => void;
  onStartDm: (userId: string) => void;
  onChanged: () => Promise<void>;
  onOpenSettings?: () => void;
}) {
  return (
    <ProfileCard
      userId={userId}
      onClose={onClose}
      onStartDm={onStartDm}
      onChanged={onChanged}
      onOpenSettings={onOpenSettings}
    />
  );
}

/* ------------------------------- sunucu oluşturma ----------------------------- */

function CreateServerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (server: ServerDetail) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await serversApi.create({ name: name.trim(), description: description.trim(), isPublic });
      toast.push(`${result.server.name} topluluğu oluşturuldu.`, 'success');
      onCreated(result.server);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Topluluk oluşturulamadı.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Topluluk oluştur" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Topluluk adı</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} required />
        </label>
        <label className="field">
          <span>Açıklama</span>
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={280}
            placeholder="Topluluğunuz ne hakkında?"
          />
        </label>
        <label className="row" style={{ gap: 10, alignItems: 'center' }}>
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          <span>Herkese açık topluluk (keşfet listesinde görünür)</span>
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !name.trim()}>
          {busy ? 'Oluşturuluyor…' : 'Oluştur'}
        </button>
      </form>
    </Modal>
  );
}

/* ---------------------------------- davet modalı ------------------------------ */

function InviteModal({
  server,
  onClose,
  onJoined,
}: {
  server: ServerDetail | null;
  onClose: () => void;
  onJoined: (serverId: string) => Promise<void>;
}) {
  const toast = useToast();
  const [invite, setInvite] = useState<{ code: string; expiresAt: number | null; maxUses: number | null } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!server) return;
    let alive = true;
    serversApi
      .createInvite(server.id, {})
      .then((result) => {
        if (alive) setInvite(result.invite);
      })
      .catch(() => toast.push('Davet oluşturulamadı.', 'error'));
    return () => {
      alive = false;
    };
  }, [server?.id]);

  const link = invite ? `${window.location.origin}/invite/${invite.code}` : '';

  return (
    <Modal title={server ? `${server.name} • Davet` : 'Davet koduyla katıl'} onClose={onClose}>
      <div className="stack">
        {server ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              Bu bağlantıyı paylaşarak yeni üyeleri topluluğunuza davet edin.
            </p>
            {invite ? (
              <div className="row" style={{ gap: 8 }}>
                <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      toast.push('Davet bağlantısı kopyalandı.', 'success');
                    } catch {
                      toast.push('Bağlantı kopyalanamadı, elle seçebilirsiniz.', 'error');
                    }
                  }}
                >
                  <Icon name="copy" size={15} /> Kopyala
                </button>
              </div>
            ) : (
              <Spinner label="Davet oluşturuluyor…" />
            )}
            <div className="divider" />
          </>
        ) : null}

        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const result = await discoverApi.invite(code.trim());
              await discoverApi.join(result.invite.code);
              toast.push(`${result.invite.server.name} topluluğuna katıldınız.`, 'success');
              await onJoined(result.invite.server.id);
            } catch (err) {
              toast.push(err instanceof ApiFailure ? err.message : 'Davet geçersiz.', 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>Davet kodu veya bağlantısı</span>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="orbit.app/invite/abc123"
              required
            />
          </label>
          <button type="submit" className="btn btn-block" disabled={busy || !code.trim()}>
            {busy ? 'Katılınıyor…' : 'Topluluğa katıl'}
          </button>
        </form>
      </div>
    </Modal>
  );
}

/* ------------------------------------ kabuk ---------------------------------- */

function Shell() {
  const toast = useToast();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<View>('friends');
  const [serverId, setServerId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [dmId, setDmId] = useState<string | null>(null);
  const [voiceChannel, setVoiceChannel] = useState<Channel | null>(null);
  const [voiceCounts, setVoiceCounts] = useState<Record<string, number>>({});
  const [online, setOnline] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [notifOpen, setNotifOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const activeRef = useRef<{ channelId: string | null; dmId: string | null }>({ channelId: null, dmId: null });

  useEffect(() => {
    activeRef.current = { channelId, dmId };
  }, [channelId, dmId]);

  const applyBoot = useCallback((data: Bootstrap) => {
    setBoot(data);
    setUnread((prev) => ({ ...prev, ...data.unread }));
    setOnline((prev) => {
      const next = { ...prev };
      for (const server of data.servers) {
        for (const member of server.members) if (!next[member.userId]) next[member.userId] = member.status;
      }
      for (const dm of data.dms) {
        for (const member of dm.members) if (!next[member.id]) next[member.id] = member.status;
      }
      return next;
    });
    setServerId((current) => {
      if (current && data.servers.some((s) => s.id === current)) return current;
      return data.servers[0]?.id ?? null;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyBoot(await authApi.bootstrap());
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) setBoot(null);
    }
  }, [applyBoot]);

  useEffect(() => {
    let alive = true;
    authApi
      .bootstrap()
      .then((data) => {
        if (alive) applyBoot(data);
      })
      .catch((err) => {
        if (alive && !(err instanceof ApiFailure && err.status === 401)) {
          setBootError('Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.');
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [applyBoot]);

  const userId = boot?.user.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const socket = io({ withCredentials: true });
    socketRef.current = socket;

    const bump = (id: string) => setUnread((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));

    socket.on('presence', (payload: { userId: string; status: UserStatus }) => {
      setOnline((prev) => ({ ...prev, [payload.userId]: payload.status }));
    });
    socket.on('notification:new', (payload: Notification) => {
      setBoot((prev) => (prev ? { ...prev, notifications: [payload, ...prev.notifications].slice(0, 60) } : prev));
    });
    socket.on('message:create', (message: Message) => {
      if (message.author?.id === userId) return;
      const active = activeRef.current;
      if (message.channelId && message.channelId !== active.channelId) bump(message.channelId);
      if (message.dmId && message.dmId !== active.dmId) bump(message.dmId);
    });
    socket.on('voice:update', (payload: { channelId: string; participants: unknown[] }) => {
      setVoiceCounts((prev) => ({
        ...prev,
        [payload.channelId]: Array.isArray(payload.participants) ? payload.participants.length : 0,
      }));
    });
    socket.on('server:deleted', (payload: { serverId: string }) => {
      setServerId((current) => (current === payload.serverId ? null : current));
      setVoiceChannel((current) => (current?.serverId === payload.serverId ? null : current));
      void refresh();
    });

    const structural = () => {
      void refresh();
    };
    const events = [
      'server:member_add',
      'server:member_remove',
      'server:member_update',
      'server:updated',
      'server:channels_update',
      'server:roles_update',
      'channel:created',
      'channel:updated',
      'channel:deleted',
      'dm:create',
      'dm:update',
      'friends:update',
    ];
    for (const event of events) socket.on(event, structural);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [userId, refresh]);

  const activeServer = useMemo(
    () => boot?.servers.find((server) => server.id === serverId) ?? null,
    [boot, serverId],
  );
  const activeChannel = useMemo(
    () => activeServer?.channels.find((channel) => channel.id === channelId) ?? null,
    [activeServer, channelId],
  );
  const activeDm = useMemo(() => boot?.dms.find((dm) => dm.id === dmId) ?? null, [boot, dmId]);

  useEffect(() => {
    if (!activeServer) {
      setChannelId(null);
      return;
    }
    if (!channelId || !activeServer.channels.some((channel) => channel.id === channelId)) {
      const first = activeServer.channels.find((channel) => channel.type !== 'voice');
      setChannelId(first?.id ?? null);
    }
  }, [activeServer, channelId]);

  const grouped = useMemo(() => {
    if (!activeServer) return [] as { id: string | null; name: string; channels: Channel[] }[];
    const categories = activeServer.categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        channels: activeServer.channels.filter((channel) => channel.categoryId === category.id),
      }))
      .filter((category) => category.channels.length > 0);
    const loose = activeServer.channels.filter((channel) => !channel.categoryId);
    return [...categories, ...(loose.length ? [{ id: null, name: 'Kanallar', channels: loose }] : [])];
  }, [activeServer]);

  const unreadNotifications = boot?.notifications.filter((notification) => !notification.readAt).length ?? 0;
  const totalUnread = Object.values(unread).reduce((sum, count) => sum + count, 0);

  const openChannel = (sid: string, cid: string) => {
    setView('server');
    setServerId(sid);
    setChannelId(cid);
    setVoiceChannel(null);
    setNavOpen(false);
    setUnread((prev) => ({ ...prev, [cid]: 0 }));
  };

  const openServer = (sid: string) => {
    const server = boot?.servers.find((item) => item.id === sid);
    const first = server?.channels.find((channel) => channel.type !== 'voice');
    setView('server');
    setServerId(sid);
    setChannelId(first?.id ?? null);
    setVoiceChannel(null);
    setNavOpen(false);
  };

  const openDm = (id: string) => {
    setView('dm');
    setDmId(id);
    setVoiceChannel(null);
    setNavOpen(false);
    setUnread((prev) => ({ ...prev, [id]: 0 }));
    void socialApi.markRead(id).catch(() => undefined);
  };

  const startDm = async (targetId: string) => {
    try {
      const result = await socialApi.openDm({ userId: targetId });
      await refresh();
      openDm(result.dm.id);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Sohbet açılamadı.', 'error');
    }
  };

  const joinVoice = (channel: Channel) => {
    setVoiceChannel(channel);
    setView('server');
    setServerId(channel.serverId);
    setNavOpen(false);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      /* oturum zaten kapanmış olabilir */
    }
    socketRef.current?.disconnect();
    setBoot(null);
    setView('friends');
  };

  const openNotifications = async () => {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next && unreadNotifications > 0) {
      try {
        await socialApi.readNotifications();
        setBoot((prev) =>
          prev
            ? {
                ...prev,
                notifications: prev.notifications.map((notification) => ({
                  ...notification,
                  readAt: notification.readAt ?? Date.now(),
                })),
              }
            : prev,
        );
      } catch {
        /* okundu bilgisi bir sonraki yenilemede alınır */
      }
    }
  };

  if (loading) {
    return (
      <div className="auth-wrap">
        <Spinner label="ORBIT yükleniyor…" />
      </div>
    );
  }

  if (bootError && !boot) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="auth-logo" aria-hidden="true">
              <Icon name="compass" size={26} />
            </span>
            <div>
              <div className="auth-title">ORBIT</div>
              <div className="auth-sub">Bağlantı kurulamadı</div>
            </div>
          </div>
          <p className="auth-error" role="alert">
            {bootError}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => {
              setBootError(null);
              setLoading(true);
              refresh().finally(() => setLoading(false));
            }}
          >
            Tekrar dene
          </button>
        </div>
      </div>
    );
  }

  if (!boot) {
    return (
      <AuthScreen
        onAuthed={async () => {
          try {
            applyBoot(await authApi.bootstrap());
            return true;
          } catch {
            return false;
          }
        }}
      />
    );
  }

  const me: MeUser = boot.user;

  const channelScope =
    view === 'server' && activeServer && activeChannel && activeChannel.type !== 'voice'
      ? ({ kind: 'channel', channel: activeChannel, serverId: activeServer.id } as const)
      : null;
  const dmScope = view === 'dm' && activeDm ? ({ kind: 'dm', dm: activeDm } as const) : null;

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <nav className="rail" aria-label="Sunucular ve görünümler">
        <button
          type="button"
          className="rail-btn"
          aria-label="Arkadaşlar ve özel mesajlar"
          aria-current={view === 'friends' || view === 'dm' ? 'page' : undefined}
          onClick={() => {
            setView('friends');
            setVoiceChannel(null);
            setNavOpen(false);
          }}
        >
          <Icon name="message" size={22} />
          {totalUnread > 0 ? <span className="badge">{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
        </button>
        <div className="rail-sep" />
        {boot.servers.map((server) => (
          <button
            key={server.id}
            type="button"
            className="rail-btn"
            aria-label={server.name}
            aria-current={view === 'server' && serverId === server.id ? 'page' : undefined}
            onClick={() => openServer(server.id)}
          >
            <Avatar
              user={{ displayName: server.name, avatarColor: server.iconColor, avatarUrl: server.iconUrl }}
              size={44}
              square
            />
          </button>
        ))}
        <button type="button" className="rail-btn" aria-label="Topluluk oluştur" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" size={20} />
        </button>
        <button
          type="button"
          className="rail-btn"
          aria-label="Topluluk keşfet"
          aria-current={view === 'discover' ? 'page' : undefined}
          onClick={() => {
            setView('discover');
            setVoiceChannel(null);
            setNavOpen(false);
          }}
        >
          <Icon name="compass" size={20} />
        </button>
      </nav>

      <aside className="sidebar" aria-label="Gezinme paneli">
        {view === 'server' && activeServer ? (
          <>
            <div className="sidebar-head">
              <button type="button" className="icon-btn mobile-only" aria-label="Menüyü kapat" onClick={() => setNavOpen(false)}>
                <Icon name="arrowLeft" size={18} />
              </button>
              <strong className="truncate" style={{ flex: 1 }}>
                {activeServer.name}
              </strong>
              <button type="button" className="icon-btn" aria-label="Davet et" onClick={() => setInviteOpen(true)}>
                <Icon name="link" size={17} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Topluluk ayarları"
                onClick={() => setServerSettingsOpen(true)}
              >
                <Icon name="settings" size={17} />
              </button>
            </div>
            <div className="sidebar-body">
              {activeServer.description ? <p className="hint">{activeServer.description}</p> : null}
              {grouped.map((group) => (
                <div key={group.id ?? 'loose'} className="sidebar-section">
                  <div className="sidebar-label">{group.name}</div>
                  {group.channels.map((channel) => (
                    <button
                      key={channel.id}
                      type="button"
                      className="channel-row"
                      aria-current={view === 'server' && channelId === channel.id ? 'page' : undefined}
                      onClick={() => (channel.type === 'voice' ? joinVoice(channel) : openChannel(activeServer.id, channel.id))}
                    >
                      <Icon
                        name={channel.type === 'voice' ? 'volume' : channel.type === 'forum' ? 'message' : 'hash'}
                        size={16}
                      />
                      <span className="truncate" style={{ flex: 1 }}>
                        {channel.name}
                      </span>
                      {channel.isPrivate ? <Icon name="shield" size={13} /> : null}
                      {channel.type === 'voice' && voiceCounts[channel.id] ? (
                        <span className="badge">{voiceCounts[channel.id]}</span>
                      ) : null}
                      {unread[channel.id] ? <span className="badge">{unread[channel.id]}</span> : null}
                    </button>
                  ))}
                </div>
              ))}
              {grouped.length === 0 ? <p className="hint">Bu toplulukta henüz kanal yok.</p> : null}
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-head">
              <button type="button" className="icon-btn mobile-only" aria-label="Menüyü kapat" onClick={() => setNavOpen(false)}>
                <Icon name="arrowLeft" size={18} />
              </button>
              <strong style={{ flex: 1 }}>{view === 'discover' ? 'Keşfet' : 'Mesajlar'}</strong>
              <button type="button" className="icon-btn" aria-label="Yeni topluluk" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" size={18} />
              </button>
            </div>
            <div className="sidebar-body">
              <button
                type="button"
                className="channel-row"
                aria-current={view === 'friends' ? 'page' : undefined}
                onClick={() => {
                  setView('friends');
                  setNavOpen(false);
                }}
              >
                <Icon name="users" size={16} />
                <span style={{ flex: 1 }}>Arkadaşlar</span>
                {boot.friends.incoming.length > 0 ? <span className="badge">{boot.friends.incoming.length}</span> : null}
              </button>
              <button
                type="button"
                className="channel-row"
                aria-current={view === 'discover' ? 'page' : undefined}
                onClick={() => {
                  setView('discover');
                  setNavOpen(false);
                }}
              >
                <Icon name="compass" size={16} />
                <span style={{ flex: 1 }}>Topluluk keşfet</span>
              </button>
              <div className="sidebar-section">
                <div className="sidebar-label">Özel mesajlar</div>
                {boot.dms.length === 0 ? <p className="hint">Henüz özel mesaj yok.</p> : null}
                {boot.dms.map((dm) => (
                  <button
                    key={dm.id}
                    type="button"
                    className="channel-row"
                    aria-current={view === 'dm' && dmId === dm.id ? 'page' : undefined}
                    onClick={() => openDm(dm.id)}
                  >
                    <Avatar
                      user={{
                        displayName: dm.name ?? (dm.members.map((member) => member.displayName).join(', ') || 'Grup'),
                        avatarColor: dm.iconColor,
                        avatarUrl: dm.members.find((member) => member.id !== me.id)?.avatarUrl ?? null,
                        status: online[dm.members.find((member) => member.id !== me.id)?.id ?? ''],
                      }}
                      size={24}
                      showStatus={dm.type === 'direct'}
                    />
                    <span className="truncate" style={{ flex: 1 }}>
                      {(dm.name ?? dm.members.filter((member) => member.id !== me.id).map((member) => member.displayName).join(', ')) ||
                        'Grup sohbeti'}
                    </span>
                    {(unread[dm.id] ?? dm.unread) > 0 ? <span className="badge">{unread[dm.id] ?? dm.unread}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="me-bar">
          <button
            type="button"
            className="row"
            style={{ gap: 8, flex: 1, minWidth: 0, background: 'none', border: 0, color: 'inherit', padding: 0 }}
            onClick={() => setProfileId(me.id)}
            aria-label="Profilim"
          >
            <Avatar user={{ ...me, status: online[me.id] ?? me.status }} size={32} showStatus />
            <span style={{ minWidth: 0, textAlign: 'left' }}>
              <span className="truncate" style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>
                {me.displayName}
              </span>
              <span className="muted truncate" style={{ display: 'block', fontSize: 11 }}>
                {me.customStatus || `@${me.username}`}
              </span>
            </span>
          </button>
          <button type="button" className="icon-btn" aria-label="Bildirimler" onClick={openNotifications}>
            <Icon name="bell" size={18} />
            {unreadNotifications > 0 ? <span className="badge">{unreadNotifications}</span> : null}
          </button>
          <button type="button" className="icon-btn" aria-label="Ayarlar" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={18} />
          </button>
        </div>
      </aside>

      <main className="main">
        <button type="button" className="icon-btn mobile-back" aria-label="Kanalları aç" onClick={() => setNavOpen(true)}>
          <Icon name="menu" size={20} />
        </button>

        {voiceChannel && socketRef.current ? (
          <VoiceRoom
            socket={socketRef.current}
            channel={voiceChannel}
            me={me}
            iceServers={boot.voice.iceServers}
            turnConfigured={boot.voice.turnConfigured}
            members={activeServer?.members ?? []}
            myPermissions={activeServer?.myPermissions ?? 0}
            onLeave={() => setVoiceChannel(null)}
          />
        ) : view === 'discover' ? (
          <DiscoverView
            onJoined={async (joinedId) => {
              await refresh();
              openServer(joinedId);
            }}
            onBack={() => setView('friends')}
          />
        ) : view === 'friends' ? (
          <FriendsView
            me={me}
            friends={boot.friends}
            dms={boot.dms}
            online={online}
            onReload={refresh}
            onOpenDm={openDm}
            onStartDm={startDm}
            onOpenProfile={setProfileId}
          />
        ) : channelScope ? (
          <Chat
            scope={channelScope}
            me={me}
            socket={socketRef.current}
            members={activeServer?.members ?? []}
            myPermissions={activeServer?.myPermissions ?? 0}
            onOpenProfile={setProfileId}
            onMembersToggle={() => undefined}
            onBack={() => setNavOpen(true)}
            onScopeChanged={async () => {
              setUnread((prev) => ({ ...prev, [channelScope.channel.id]: 0 }));
              await refresh();
            }}
          />
        ) : dmScope ? (
          <Chat
            scope={dmScope}
            me={me}
            socket={socketRef.current}
            members={[]}
            myPermissions={0}
            onOpenProfile={setProfileId}
            onMembersToggle={() => undefined}
            onBack={() => setNavOpen(true)}
            onScopeChanged={async () => {
              setUnread((prev) => ({ ...prev, [dmScope.dm.id]: 0 }));
              await refresh();
            }}
          />
        ) : (
          <div className="messages">
            <div className="messages-inner">
              <EmptyState
                icon="compass"
                title="Bir kanal seçin"
                description="Soldaki panelden bir kanal açın, bir topluluğa katılın veya arkadaşlarınızla özel sohbet başlatın."
                action={
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                    Topluluk oluştur
                  </button>
                }
              />
            </div>
          </div>
        )}

        {notifOpen ? (
          <div className="notif-panel" role="dialog" aria-label="Bildirimler">
            <div className="row-between" style={{ padding: '10px 12px' }}>
              <strong>Bildirimler</strong>
              <button type="button" className="icon-btn" aria-label="Kapat" onClick={() => setNotifOpen(false)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            {boot.notifications.length === 0 ? (
              <p className="hint" style={{ padding: 12 }}>
                Henüz bildirim yok.
              </p>
            ) : (
              <div className="notif-list">
                {boot.notifications.map((notification) => (
                  <button
                    key={notification.id}
                    type="button"
                    className="notif-item"
                    onClick={() => {
                      setNotifOpen(false);
                      if (notification.dmId) openDm(notification.dmId);
                      else if (notification.serverId && notification.channelId)
                        openChannel(notification.serverId, notification.channelId);
                      else if (notification.type === 'friend_request') setView('friends');
                    }}
                  >
                    <Avatar
                      user={
                        notification.actor ?? {
                          displayName: 'ORBIT',
                          avatarColor: '#7c5cff',
                          avatarUrl: null,
                        }
                      }
                      size={30}
                    />
                    <span style={{ minWidth: 0, textAlign: 'left' }}>
                      <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>{notification.title}</span>
                      <span className="muted truncate" style={{ display: 'block', fontSize: 12 }}>
                        {notification.body}
                      </span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {relative(notification.createdAt)}
                      </span>
                    </span>
                    {!notification.readAt ? <span className="badge">yeni</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </main>

      {createOpen ? (
        <CreateServerModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (server) => {
            setCreateOpen(false);
            await refresh();
            openServer(server.id);
          }}
        />
      ) : null}

      {inviteOpen ? (
        <InviteModal
          server={activeServer}
          onClose={() => setInviteOpen(false)}
          onJoined={async (joinedId) => {
            setInviteOpen(false);
            await refresh();
            openServer(joinedId);
          }}
        />
      ) : null}

      {profileId ? (
        <ProfileModal
          userId={profileId}
          onClose={() => setProfileId(null)}
          onStartDm={async (targetId) => {
            setProfileId(null);
            await startDm(targetId);
          }}
          onChanged={refresh}
          onOpenSettings={() => {
            setProfileId(null);
            setSettingsOpen(true);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <UserSettingsModal
          me={me}
          onClose={() => setSettingsOpen(false)}
          onSaved={(user) => setBoot((prev) => (prev ? { ...prev, user } : prev))}
          onLogout={logout}
        />
      ) : null}

      {serverSettingsOpen && activeServer ? (
        <ServerSettingsModal
          server={activeServer}
          onClose={() => setServerSettingsOpen(false)}
          onChanged={refresh}
          onDeleted={() => {
            setServerSettingsOpen(false);
            setServerId(null);
            setChannelId(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
