/** Arkadaşlar, arkadaşlık istekleri, engelleme ve sunucu keşfi ekranları. */
import { useEffect, useMemo, useState } from 'react';
import type { DmChannel, FriendsPayload, MeUser, PublicUser, Server } from '@shared/types';
import { ApiFailure, discoverApi, socialApi } from './api';
import { Avatar, EmptyState, Icon, Spinner, relative, useToast } from './ui';

interface FriendsProps {
  me: MeUser;
  friends: FriendsPayload;
  dms: DmChannel[];
  online: Record<string, string>;
  onReload: () => Promise<void>;
  onOpenDm: (dmId: string) => void;
  onStartDm: (userId: string) => void;
  onOpenProfile: (userId: string) => void;
}

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export default function FriendsView({
  me,
  friends,
  dms,
  online,
  onReload,
  onOpenDm,
  onStartDm,
  onOpenProfile,
}: FriendsProps) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('online');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  const statusOf = (user: PublicUser) => online[user.id] ?? user.status;

  const onlineFriends = friends.friends.filter((friend) => {
    const status = statusOf(friend);
    return status === 'online' || status === 'idle' || status === 'dnd';
  });

  const list = tab === 'online' ? onlineFriends : friends.friends;

  const addFriend = async () => {
    const value = username.trim().replace(/^@/, '');
    if (value.length < 2) return;
    setBusy(true);
    try {
      const result = await socialApi.sendRequest(value);
      toast.push(
        result.status === 'friends'
          ? 'Bu kullanıcı zaten arkadaşınız.'
          : result.status === 'outgoing'
            ? 'İstek zaten gönderilmiş.'
            : 'Arkadaşlık isteği gönderildi.',
        'success',
      );
      setUsername('');
      await onReload();
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'İstek gönderilemedi.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      toast.push(message, 'success');
      await onReload();
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'İşlem başarısız.', 'error');
    }
  };

  const groupDms = useMemo(() => dms.filter((dm) => dm.type === 'group'), [dms]);

  return (
    <section className="main" aria-label="Arkadaşlar">
      <header className="main-head">
        <Icon name="users" size={18} />
        <strong style={{ flex: 1 }}>Arkadaşlar</strong>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setTab('add')}>
          <Icon name="plus" size={14} /> Arkadaş ekle
        </button>
      </header>

      <div className="row" style={{ padding: '10px 14px', gap: 8, borderBottom: '1px solid var(--line-soft)', flexWrap: 'wrap' }}>
        {(
          [
            ['online', `Çevrimiçi (${onlineFriends.length})`],
            ['all', `Tümü (${friends.friends.length})`],
            ['pending', `Bekleyen (${friends.incoming.length})`],
            ['blocked', `Engellenen (${friends.blocked.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="messages">
        <div className="messages-inner">
          {tab === 'add' ? (
            <div className="card" style={{ maxWidth: 520 }}>
              <h3 style={{ marginTop: 0 }}>Arkadaş ekle</h3>
              <p className="muted" style={{ fontSize: 13 }}>
                Kullanıcı adıyla arkadaşlık isteği gönderin.
              </p>
              <div className="row" style={{ marginTop: 10 }}>
                <input
                  className="input"
                  placeholder="kullanici_adi"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addFriend()}
                  autoFocus
                />
                <button type="button" className="btn btn-primary" onClick={addFriend} disabled={busy}>
                  {busy ? 'Gönderiliyor…' : 'İstek gönder'}
                </button>
              </div>
              {friends.outgoing.length ? (
                <>
                  <div className="sidebar-label" style={{ marginTop: 18 }}>Gönderilen istekler</div>
                  {friends.outgoing.map((request) => (
                    <div key={request.id} className="member-row">
                      <Avatar user={request.user} size={30} showStatus />
                      <span style={{ flex: 1 }}>{request.user.displayName}</span>
                      <span className="muted" style={{ fontSize: 12 }}>bekliyor</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => act(() => socialApi.decline(request.id), 'İstek iptal edildi.')}
                      >
                        İptal
                      </button>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}

          {tab === 'pending' ? (
            friends.incoming.length === 0 ? (
              <EmptyState icon="users" title="Bekleyen istek yok" description="Yeni arkadaşlık istekleri burada görünür." />
            ) : (
              friends.incoming.map((request) => (
                <div key={request.id} className="member-row">
                  <Avatar user={request.user} size={38} showStatus />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{request.user.displayName}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      @{request.user.username} · {relative(request.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => act(() => socialApi.accept(request.id), 'Arkadaşlık isteği kabul edildi.')}
                  >
                    Kabul et
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => act(() => socialApi.decline(request.id), 'İstek reddedildi.')}
                  >
                    Reddet
                  </button>
                </div>
              ))
            )
          ) : null}

          {tab === 'blocked' ? (
            friends.blocked.length === 0 ? (
              <EmptyState icon="ban" title="Engellenen kullanıcı yok" description="Engellediğiniz kullanıcılar burada listelenir." />
            ) : (
              friends.blocked.map((user) => (
                <div key={user.id} className="member-row">
                  <Avatar user={user} size={34} />
                  <span style={{ flex: 1 }}>{user.displayName}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => act(() => socialApi.unblock(user.id), 'Engel kaldırıldı.')}
                  >
                    Engeli kaldır
                  </button>
                </div>
              ))
            )
          ) : null}

          {tab === 'online' || tab === 'all' ? (
            list.length === 0 ? (
              <EmptyState
                icon="users"
                title={tab === 'online' ? 'Çevrimiçi arkadaş yok' : 'Henüz arkadaşınız yok'}
                description="Arkadaş ekleyerek özel mesajlaşmaya başlayın."
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setTab('add')}>
                    Arkadaş ekle
                  </button>
                }
              />
            ) : (
              list.map((friend) => {
                const status = statusOf(friend);
                const dm = dms.find((channel) => channel.type === 'direct' && channel.members.some((m) => m.id === friend.id));
                return (
                  <div key={friend.id} className="member-row">
                    <button type="button" className="avatar-btn" onClick={() => onOpenProfile(friend.id)} aria-label={`${friend.displayName} profili`}>
                      <Avatar user={{ ...friend, status }} size={38} showStatus />
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong className="truncate" style={{ display: 'block' }}>{friend.displayName}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {friend.customStatus || `@${friend.username}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => (dm ? onOpenDm(dm.id) : onStartDm(friend.id))}
                    >
                      <Icon name="message" size={14} /> Mesaj
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => act(() => socialApi.removeFriend(friend.id), 'Arkadaşlıktan çıkarıldı.')}
                      aria-label="Arkadaşlıktan çıkar"
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                );
              })
            )
          ) : null}

          {groupDms.length ? (
            <>
              <div className="sidebar-label" style={{ marginTop: 18 }}>Grup sohbetleri</div>
              {groupDms.map((dm) => (
                <div key={dm.id} className="member-row">
                  <Avatar
                    user={{ displayName: dm.name ?? 'Grup', avatarColor: dm.iconColor, avatarUrl: null }}
                    size={34}
                    square
                  />
                  <span style={{ flex: 1 }} className="truncate">
                    {dm.name ?? dm.members.map((m) => m.displayName).join(', ')}
                  </span>
                  {dm.unread > 0 ? <span className="badge">{dm.unread}</span> : null}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenDm(dm.id)}>
                    Aç
                  </button>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

interface DiscoverProps {
  onJoined: (serverId: string) => Promise<void> | void;
  onBack: () => void;
}

interface DiscoveredServer extends Partial<Server> {
  id: string;
  name: string;
  description?: string;
  iconColor?: string;
  memberCount?: number;
  isPublic?: boolean;
  joined?: boolean;
}

export function DiscoverView({ onJoined, onBack }: DiscoverProps) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const search = async (value: string) => {
    setLoading(true);
    try {
      const result = await discoverApi.search(value);
      setServers(result.servers as DiscoveredServer[]);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Sunucular yüklenemedi.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void search('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const joinByCode = async () => {
    const value = code.trim().split('/').pop() ?? '';
    if (!value) return;
    setBusy(true);
    try {
      const result = await discoverApi.join(value);
      toast.push(`${result.server.name} sunucusuna katıldınız.`, 'success');
      setCode('');
      await onJoined(result.server.id);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Sunucuya katılınamadı.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const joinServer = async (serverId: string) => {
    setBusy(true);
    try {
      const result = await discoverApi.joinServer(serverId);
      toast.push('Topluluğa katıldınız.', 'success');
      await onJoined(result.serverId);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Sunucuya katılınamadı.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="main" aria-label="Sunucu keşfet">
      <header className="main-head">
        <button type="button" className="icon-btn mobile-only" onClick={onBack} aria-label="Geri">
          <Icon name="arrowLeft" size={18} />
        </button>
        <Icon name="compass" size={18} />
        <strong style={{ flex: 1 }}>Sunucu keşfet</strong>
      </header>
      <div className="messages">
        <div className="messages-inner">
          <div className="card">
            <div className="row">
              <input
                className="input"
                placeholder="Sunucu ara…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && search(query)}
              />
              <button type="button" className="btn btn-primary" onClick={() => search(query)}>
                <Icon name="search" size={15} /> Ara
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="input"
                placeholder="Davet kodu veya bağlantısı"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && joinByCode()}
              />
              <button type="button" className="btn btn-primary" onClick={joinByCode} disabled={busy || !code.trim()}>
                Katıl
              </button>
            </div>
          </div>

          {loading ? (
            <Spinner label="Sunucular yükleniyor…" />
          ) : servers.length === 0 ? (
            <EmptyState icon="compass" title="Herkese açık sunucu bulunamadı" description="Farklı bir arama deneyin veya davet koduyla katılın." />
          ) : (
            servers.map((server) => (
              <div key={server.id} className="member-row">
                <Avatar
                  user={{ displayName: server.name, avatarColor: server.iconColor ?? '#7c5cff', avatarUrl: null }}
                  size={40}
                  square
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{server.name}</strong>
                  <div className="muted truncate" style={{ fontSize: 12 }}>
                    {server.description || 'Açıklama yok'} · {server.memberCount ?? 0} üye
                  </div>
                </div>
                {server.joined ? (
                  <span className="chip">üye</span>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => joinServer(server.id)} disabled={busy}>
                    Katıl
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
