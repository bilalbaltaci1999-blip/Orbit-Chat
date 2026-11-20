/** Mesaj alanı: kanal/DM geçmişi, gönderme, düzenleme, tepki, pin, arama, dosya, anket, forum. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { Channel, DmChannel, FileAttachment, MeUser, Message, Poll, ServerMember } from '@shared/types';
import { PERMISSIONS, hasPermission } from '@shared/permissions';
import { ApiFailure, channelsApi, serversApi, socialApi } from './api';
import {
  Avatar,
  EMOJIS,
  EmptyState,
  Icon,
  Modal,
  dayLabel,
  fileSize,
  fullTime,
  renderContent,
  timeOfDay,
  useToast,
} from './ui';

interface ChatProps {
  scope: { kind: 'channel'; channel: Channel; serverId: string } | { kind: 'dm'; dm: DmChannel };
  me: MeUser;
  socket: Socket | null;
  members: ServerMember[];
  myPermissions: number;
  onOpenProfile: (userId: string) => void;
  onMembersToggle: () => void;
  onBack: () => void;
  onScopeChanged: () => void;
}

export default function Chat({
  scope,
  me,
  socket,
  members,
  myPermissions,
  onOpenProfile,
  onMembersToggle,
  onBack,
  onScopeChanged,
}: ChatProps) {
  const toast = useToast();
  const isChannel = scope.kind === 'channel';
  const scopeId = isChannel ? scope.channel.id : scope.dm.id;

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const [pins, setPins] = useState<Message[] | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Message[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [topics, setTopics] = useState<Message[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const canSend = !isChannel || hasPermission(myPermissions, PERMISSIONS.SEND_MESSAGES);
  const canManage = isChannel && hasPermission(myPermissions, PERMISSIONS.MANAGE_MESSAGES);
  const canPin = isChannel && hasPermission(myPermissions, PERMISSIONS.PIN_MESSAGES);
  const isForum = isChannel && scope.channel.type === 'forum';

  const sortMessages = (list: Message[]) => [...list].sort((a, b) => a.createdAt - b.createdAt);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (isChannel && scope.channel.type === 'forum') {
        const result = await channelsApi.topics(scope.channel.id);
        setTopics(sortMessages(result.topics));
        setMessages([]);
      } else if (isChannel) {
        const result = await channelsApi.messages(scope.channel.id);
        setMessages(sortMessages(result.messages));
      } else {
        const result = await socialApi.messages(scope.dm.id);
        setMessages(sortMessages(result.messages));
      }
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Mesajlar yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, [isChannel, scope]);

  useEffect(() => {
    setMessages([]);
    setTopics([]);
    setReplyTo(null);
    setEditing(null);
    setSearchResults(null);
    setSearch('');
    setShowPins(false);
    setTopicId(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    socket.emit('subscribe', isChannel ? { channelId: scopeId } : { dmId: scopeId });

    const belongs = (message: Message) =>
      isChannel ? message.channelId === scopeId : message.dmId === scopeId;

    const onCreate = (message: Message) => {
      if (!belongs(message)) return;
      if (message.parentId) {
        setMessages((prev) =>
          prev.some((m) => m.id === message.parentId)
            ? prev.map((m) => (m.id === message.parentId ? { ...m, replyCount: m.replyCount + 1 } : m))
            : prev,
        );
        if (topicId === message.parentId) setMessages((prev) => sortMessages([...prev, message]));
        return;
      }
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : sortMessages([...prev, message])));
    };
    const onUpdate = (message: Message) => {
      if (!belongs(message)) return;
      setMessages((prev) => prev.map((m) => (m.id === message.id ? message : m)));
      setTopics((prev) => prev.map((m) => (m.id === message.id ? message : m)));
    };
    const onDelete = (payload: { messageId: string }) => {
      setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
      setTopics((prev) => prev.filter((m) => m.id !== payload.messageId));
    };
    const onTyping = (payload: { scope: string; id: string; userId: string; displayName: string; at: number }) => {
      if (payload.id !== scopeId || payload.userId === me.id) return;
      setTyping((prev) => ({ ...prev, [payload.userId]: { name: payload.displayName, at: payload.at } }));
    };

    socket.on('message:create', onCreate);
    socket.on('message:update', onUpdate);
    socket.on('message:delete', onDelete);
    socket.on('typing', onTyping);
    return () => {
      socket.off('message:create', onCreate);
      socket.off('message:update', onUpdate);
      socket.off('message:delete', onDelete);
      socket.off('typing', onTyping);
    };
  }, [socket, scopeId, isChannel, me.id, topicId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTyping((prev) => {
        const next: Record<string, { name: string; at: number }> = {};
        const cutoff = Date.now() - 4000;
        for (const [id, entry] of Object.entries(prev)) if (entry.at > cutoff) next[id] = entry;
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  /* Okundu bilgisi her mesajda gönderilir; üst veri yenilemesi yalnızca kapsam ilk açıldığında
     yapılır. Aksi hâlde her gönderimde tüm önyükleme yeniden çekiliyor, mesaj listesi boşalıp
     yeniden yükleniyordu (yazarken kaybolma/flicker hatası). */
  const markedScopeRef = useRef<string | null>(null);
  const markRead = useCallback(() => {
    const run = isChannel ? channelsApi.markRead(scopeId) : socialApi.markRead(scopeId);
    const notify = markedScopeRef.current !== scopeId;
    markedScopeRef.current = scopeId;
    run
      .then(() => {
        if (notify) onScopeChanged();
      })
      .catch(() => undefined);
  }, [isChannel, scopeId, onScopeChanged]);

  useEffect(() => {
    if (messages.length) markRead();
  }, [messages.length, markRead]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, topicId]);

  const send = async () => {
    const text = content.trim();
    if ((!text && attachments.length === 0 && !isForum) || sending) return;
    if (isForum && !title.trim() && !topicId) {
      toast.push('Forum konusu için başlık gerekli.', 'error');
      return;
    }
    setSending(true);
    try {
      const payload = {
        content: text,
        parentId: replyTo?.id ?? (topicId ?? null),
        fileIds: attachments.map((f) => f.id),
        title: isForum && !topicId ? title.trim() : undefined,
        poll:
          pollQuestion.trim() && pollOptions.filter((o) => o.trim()).length >= 2
            ? {
                question: pollQuestion.trim(),
                options: pollOptions.map((o) => o.trim()).filter(Boolean),
                allowMultiple: false,
              }
            : undefined,
      };
      const result = isChannel
        ? await channelsApi.send(scope.channel.id, payload)
        : await socialApi.send(scope.dm.id, payload);
      if (isForum && !topicId) {
        setTopics((prev) => sortMessages([...prev, result.message]));
      } else {
        setMessages((prev) => (prev.some((m) => m.id === result.message.id) ? prev : sortMessages([...prev, result.message])));
      }
      setContent('');
      setTitle('');
      setAttachments([]);
      setReplyTo(null);
      setPollOpen(false);
      setPollQuestion('');
      setPollOptions(['', '']);
      setEmojiOpen(false);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Mesaj gönderilemedi.', 'error');
    } finally {
      setSending(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const attachment = await channelsApiUpload(file, isChannel ? scope.channel.id : undefined);
      setAttachments((prev) => [...prev, attachment]);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Dosya yüklenemedi.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const toggleReaction = async (message: Message, emoji: string) => {
    try {
      const result = await channelsApi.react(message.id, emoji);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? result.message : m)));
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Tepki eklenemedi.', 'error');
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const result = await channelsApi.edit(editing.id, editText.trim());
      setMessages((prev) => prev.map((m) => (m.id === editing.id ? result.message : m)));
      setEditing(null);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Mesaj düzenlenemedi.', 'error');
    }
  };

  const remove = async (message: Message) => {
    if (!window.confirm('Bu mesajı silmek istiyor musunuz?')) return;
    try {
      await channelsApi.remove(message.id);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
      toast.push('Mesaj silindi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Mesaj silinemedi.', 'error');
    }
  };

  const pin = async (message: Message) => {
    try {
      const result = await channelsApi.pin(message.id);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? result.message : m)));
      setPins(null);
      toast.push(result.message.pinned ? 'Mesaj sabitlendi.' : 'Sabitleme kaldırıldı.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Sabitleme başarısız.', 'error');
    }
  };

  const vote = async (message: Message, optionId: string) => {
    try {
      const result = await channelsApi.vote(message.id, optionId);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? result.message : m)));
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Oy kaydedilemedi.', 'error');
    }
  };

  const report = async (message: Message) => {
    if (!isChannel) return;
    const reason = window.prompt('Şikâyet nedeni:');
    if (!reason) return;
    try {
      await serversApi.createReport(scope.serverId, { reason, messageId: message.id });
      toast.push('Şikâyetiniz moderatörlere iletildi.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Şikâyet gönderilemedi.', 'error');
    }
  };

  const openPins = async () => {
    if (!isChannel) return;
    if (showPins) {
      setShowPins(false);
      return;
    }
    try {
      const result = await channelsApi.pins(scope.channel.id);
      setPins(result.messages);
      setShowPins(true);
    } catch {
      toast.push('Sabitlenen mesajlar yüklenemedi.', 'error');
    }
  };

  const runSearch = async () => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const result = await channelsApi.search(search.trim(), isChannel ? { channelId: scope.channel.id } : {});
      setSearchResults(result.messages);
    } catch (err) {
      toast.push(err instanceof ApiFailure ? err.message : 'Arama başarısız.', 'error');
    } finally {
      setSearching(false);
    }
  };

  const openTopic = async (topic: Message) => {
    setTopicId(topic.id);
    setMessages([topic]);
    try {
      const result = await channelsApi.thread(topic.id);
      setMessages(sortMessages([topic, ...result.messages]));
    } catch {
      toast.push('Konu yüklenemedi.', 'error');
    }
  };

  const typingNames = Object.values(typing).map((t) => t.name);
  const headerTitle = isChannel
    ? `${scope.channel.type === 'voice' ? '🔊' : scope.channel.type === 'forum' ? '💬' : '#'} ${scope.channel.name}`
    : (scope.dm.name ?? scope.dm.members.filter((m) => m.id !== me.id).map((m) => m.displayName).join(', ')) || 'Grup sohbeti';

  const renderPoll = (poll: Poll) => (
    <div className="poll">
      <div className="poll-q">{poll.question}</div>
      {poll.options.map((option) => {
        const voted = poll.myVotes.includes(option.id);
        const total = poll.options.reduce((sum, o) => sum + o.votes, 0) || 1;
        const percent = Math.round((option.votes / total) * 100);
        return (
          <button
            key={option.id}
            type="button"
            className={`poll-option${voted ? ' voted' : ''}`}
            onClick={() => vote(messageForPoll(poll.id), option.id)}
            aria-pressed={voted}
          >
            <span style={{ width: `${percent}%`, position: 'absolute', inset: 0, background: 'rgba(124,92,255,0.18)' }} />
            <span style={{ position: 'relative', flex: 1, textAlign: 'left' }}>{option.label}</span>
            <span style={{ position: 'relative' }}>{option.votes} · %{percent}</span>
          </button>
        );
      })}
      <div className="hint">
        {poll.options.reduce((sum, o) => sum + o.votes, 0)} oy
        {poll.closesAt ? ` · ${fullTime(poll.closesAt)} kapanır` : ''}
      </div>
    </div>
  );

  const messageForPoll = (pollId: string): Message => {
    const found = messages.find((m) => m.poll?.id === pollId) ?? messages[0];
    return found;
  };

  const renderMessage = (message: Message) => {
    const mine = message.author?.id === me.id;
    const author = message.author;
    const canEdit = mine && message.type !== 'system';
    const canDelete = mine || canManage;
    return (
      <div className="msg" key={message.id} id={`m-${message.id}`}>
        {author ? (
          <button type="button" className="avatar-btn" onClick={() => onOpenProfile(author.id)} aria-label={`${author.displayName} profili`}>
            <Avatar user={author} size={40} />
          </button>
        ) : (
          <Avatar user={{ displayName: '?', avatarColor: '#444', avatarUrl: null }} size={40} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="msg-head">
            <button type="button" className="link-btn" onClick={() => author && onOpenProfile(author.id)}>
              <strong>{author?.displayName ?? 'Bilinmeyen'}</strong>
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {timeOfDay(message.createdAt)}
            </span>
            {message.pinned ? <span className="chip">📌 sabit</span> : null}
            {message.editedAt ? <span className="muted" style={{ fontSize: 11 }}>(düzenlendi)</span> : null}
            {message.type === 'system' ? <span className="chip">sistem</span> : null}
          </div>
          {message.parentPreview ? (
            <div className="reply-preview">
              <Icon name="reply" size={13} />
              <strong>{message.parentPreview.authorName}</strong>
              <span className="truncate">{message.parentPreview.content}</span>
            </div>
          ) : null}
          {message.title ? <div style={{ fontWeight: 700, marginTop: 2 }}>{message.title}</div> : null}
          {editing?.id === message.id ? (
            <div className="composer-wrap" style={{ marginTop: 6 }}>
              <textarea
                className="textarea"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void saveEdit();
                  }
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={saveEdit}>
                  Kaydet
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                  İptal
                </button>
              </div>
            </div>
          ) : (
            <div className="msg-content">{renderContent(message.content)}</div>
          )}
          {message.files.length ? (
            <div className="msg-files">
              {message.files.map((file) =>
                file.mime.startsWith('image/') ? (
                  <a key={file.id} href={file.url} target="_blank" rel="noopener noreferrer">
                    <img className="msg-image" src={file.url} alt={file.name} loading="lazy" />
                  </a>
                ) : (
                  <a key={file.id} className="file-card" href={file.url} target="_blank" rel="noopener noreferrer">
                    <Icon name="file" size={18} />
                    <span className="truncate">{file.name}</span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {fileSize(file.size)}
                    </span>
                  </a>
                ),
              )}
            </div>
          ) : null}
          {message.poll ? renderPoll(message.poll) : null}
          {message.reactions.length ? (
            <div className="reactions">
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={`reaction${reaction.me ? ' me' : ''}`}
                  onClick={() => toggleReaction(message, reaction.emoji)}
                  aria-pressed={reaction.me}
                >
                  {reaction.emoji} {reaction.count}
                </button>
              ))}
            </div>
          ) : null}
          {message.replyCount > 0 && !topicId ? (
            <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => openTopic(message)}>
              {message.replyCount} yanıt
            </button>
          ) : null}
        </div>
        <div className="msg-actions">
          {EMOJIS.slice(0, 4).map((emoji) => (
            <button key={emoji} type="button" className="icon-btn" onClick={() => toggleReaction(message, emoji)} aria-label={`${emoji} tepkisi`}>
              <span style={{ fontSize: 14 }}>{emoji}</span>
            </button>
          ))}
          <button type="button" className="icon-btn" onClick={() => setReplyTo(message)} aria-label="Yanıtla">
            <Icon name="reply" size={15} />
          </button>
          {canPin ? (
            <button type="button" className="icon-btn" onClick={() => pin(message)} aria-label="Sabitle">
              <Icon name="pin" size={15} />
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                setEditing(message);
                setEditText(message.content);
              }}
              aria-label="Düzenle"
            >
              <Icon name="edit" size={15} />
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" className="icon-btn" onClick={() => remove(message)} aria-label="Sil">
              <Icon name="trash" size={15} />
            </button>
          ) : null}
          {isChannel ? (
            <button type="button" className="icon-btn" onClick={() => report(message)} aria-label="Şikâyet et">
              <Icon name="shield" size={15} />
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const listToRender = searchResults ?? (isForum && !topicId ? topics : messages);

  return (
    <section className="main" aria-label={headerTitle}>
      <header className="main-head">
        <button type="button" className="icon-btn mobile-only" onClick={onBack} aria-label="Geri">
          <Icon name="arrowLeft" size={18} />
        </button>
        {topicId ? (
          <button type="button" className="icon-btn" onClick={() => { setTopicId(null); void load(); }} aria-label="Konulara dön">
            <Icon name="arrowLeft" size={18} />
          </button>
        ) : null}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 8 }}>
            <Icon name={isChannel ? (scope.channel.type === 'voice' ? 'volume' : isForum ? 'message' : 'hash') : 'at'} size={18} />
            <strong className="truncate">{topicId ? 'Konu' : headerTitle}</strong>
          </div>
          <div className="muted truncate" style={{ fontSize: 12 }}>
            {isChannel ? scope.channel.topic || `${scope.channel.type} kanal` : `${scope.dm.members.length} üye`}
          </div>
        </div>
        {isChannel ? (
          <>
            <button type="button" className="icon-btn" onClick={openPins} aria-label="Sabitlenen mesajlar">
              <Icon name="pin" size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setSearch((s) => (s ? '' : ' '))} aria-label="Ara">
              <Icon name="search" size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={onMembersToggle} aria-label="Üye listesi">
              <Icon name="users" size={18} />
            </button>
          </>
        ) : null}
      </header>

      {search !== '' && isChannel ? (
        <div className="row" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line-soft)' }}>
          <input
            className="input"
            placeholder="Bu kanalda ara…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            autoFocus
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={runSearch} disabled={searching}>
            {searching ? '…' : 'Ara'}
          </button>
          {searchResults ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSearchResults(null)}>
              Temizle
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="messages">
        <div className="messages-inner">
          {showPins && pins ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row-between">
                <strong>Sabitlenen mesajlar</strong>
                <button type="button" className="icon-btn" onClick={() => setShowPins(false)} aria-label="Kapat">
                  <Icon name="close" size={16} />
                </button>
              </div>
              {pins.length === 0 ? <p className="muted">Henüz sabitlenen mesaj yok.</p> : null}
              {pins.map((message) => (
                <div key={message.id} className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
                  <Avatar user={message.author ?? { displayName: '?', avatarColor: '#444', avatarUrl: null }} size={24} />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 12 }}>{message.author?.displayName}</strong>
                    <div className="truncate" style={{ fontSize: 13 }}>
                      {message.content}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {loading ? (
            <div className="loader">
              <span className="spinner" />
              <span>Mesajlar yükleniyor…</span>
            </div>
          ) : error ? (
            <EmptyState
              icon="ban"
              title="Mesajlar yüklenemedi"
              description={error}
              action={
                <button type="button" className="btn btn-primary" onClick={() => load()}>
                  Yeniden dene
                </button>
              }
            />
          ) : listToRender.length === 0 ? (
            <EmptyState
              icon={isForum ? 'message' : 'hash'}
              title={isForum ? 'Henüz konu yok' : 'Sohbeti başlatın'}
              description={
                isForum
                  ? 'İlk forum konusunu oluşturarak tartışmayı başlatın.'
                  : 'Burada henüz mesaj yok. İlk mesajı siz gönderin.'
              }
            />
          ) : (
            listToRender.map((message, index) => {
              const previous = listToRender[index - 1];
              const showDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
              return (
                <div key={message.id}>
                  {showDay ? <div className="divider">{dayLabel(message.createdAt)}</div> : null}
                  {isForum && !topicId ? (
                    <button type="button" className="channel-row" style={{ width: '100%' }} onClick={() => openTopic(message)}>
                      <Icon name="message" size={16} />
                      <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                          {message.title ?? message.content.slice(0, 60)}
                        </span>
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          {message.author?.displayName} · {message.replyCount} yanıt · {timeOfDay(message.createdAt)}
                        </span>
                      </span>
                    </button>
                  ) : (
                    renderMessage(message)
                  )}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {typingNames.length ? (
        <div className="typing" aria-live="polite">
          {typingNames.slice(0, 3).join(', ')} yazıyor…
        </div>
      ) : null}

      <div className="composer-wrap">
        {replyTo ? (
          <div className="reply-preview" style={{ marginBottom: 6 }}>
            <Icon name="reply" size={13} />
            <strong>{replyTo.author?.displayName}</strong>
            <span className="truncate">{replyTo.content}</span>
            <button type="button" className="icon-btn" onClick={() => setReplyTo(null)} aria-label="Yanıtı iptal et">
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachments">
            {attachments.map((file) => (
              <span key={file.id} className="attachment-pill">
                <Icon name="file" size={13} /> {file.name}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setAttachments((prev) => prev.filter((f) => f.id !== file.id))}
                  aria-label="Dosyayı kaldır"
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {isForum && !topicId ? (
          <input
            className="input"
            placeholder="Konu başlığı"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={140}
            style={{ marginBottom: 6 }}
          />
        ) : null}
        {canSend ? (
          <div className="composer-bar">
            <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Dosya ekle" disabled={uploading}>
              <Icon name={uploading ? 'spinner' : 'plus'} size={18} />
            </button>
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = '';
              }}
            />
            <textarea
              ref={textRef}
              className="composer"
              placeholder={isChannel ? `#${scope.channel.name} kanalına mesaj gönder` : 'Mesaj gönder'}
              value={content}
              rows={1}
              maxLength={4000}
              onChange={(e) => {
                setContent(e.target.value);
                if (socket) socket.emit('typing', { scope: isChannel ? 'channel' : 'dm', id: scopeId });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="button" className="icon-btn" onClick={() => setEmojiOpen((v) => !v)} aria-label="Emoji">
              <Icon name="smile" size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setPollOpen(true)} aria-label="Anket oluştur">
              <Icon name="poll" size={18} />
            </button>
            <button type="button" className="btn btn-primary" onClick={send} disabled={sending} aria-label="Gönder">
              <Icon name="send" size={16} />
            </button>
          </div>
        ) : (
          <div className="hint">Bu kanala mesaj gönderme izniniz yok.</div>
        )}
        {emojiOpen ? (
          <div className="card" style={{ marginTop: 6 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="icon-btn"
                  onClick={() => setContent((prev) => prev + emoji)}
                  aria-label={`${emoji} ekle`}
                >
                  <span style={{ fontSize: 18 }}>{emoji}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {isChannel && scope.channel.slowmodeSeconds > 0 ? (
          <div className="hint">Yavaş mod: {scope.channel.slowmodeSeconds} sn</div>
        ) : null}
      </div>

      {pollOpen ? (
        <Modal
          title="Anket oluştur"
          onClose={() => setPollOpen(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setPollOpen(false)}>
                İptal
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setPollOpen(false);
                  toast.push('Anket mesaja eklenecek. Gönder’e basın.', 'info');
                }}
              >
                Ankete ekle
              </button>
            </>
          }
        >
          <div className="field">
            <label>Soru</label>
            <input className="input" value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} maxLength={200} />
          </div>
          {pollOptions.map((option, index) => (
            <div className="field" key={index}>
              <label>Seçenek {index + 1}</label>
              <input
                className="input"
                value={option}
                onChange={(e) => setPollOptions((prev) => prev.map((o, i) => (i === index ? e.target.value : o)))}
                maxLength={80}
              />
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPollOptions((prev) => [...prev, ''])}
            disabled={pollOptions.length >= 8}
          >
            Seçenek ekle
          </button>
        </Modal>
      ) : null}
    </section>
  );
}

/** api.upload kısayolu — kanal kimliğiyle dosya yükler. */
async function channelsApiUpload(file: File, channelId?: string): Promise<FileAttachment> {
  const { api } = await import('./api');
  return api.upload(file, channelId);
}
