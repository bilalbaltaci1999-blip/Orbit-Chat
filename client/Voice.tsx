/** Sesli/görüntülü oda: WebRTC mesh, mikrofon/kamera/ekran paylaşımı, katılımcı yönetimi. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { Channel, IceServerConfig, MeUser, PublicUser, ServerMember, VoicePeerState } from '@shared/types';
import { PERMISSIONS, hasPermission } from '@shared/permissions';
import { Avatar, Icon, fullTime, useToast } from './ui';

interface VoiceRoomProps {
  socket: Socket;
  channel: Channel;
  me: MeUser;
  iceServers: IceServerConfig[];
  turnConfigured: boolean;
  members: ServerMember[];
  myPermissions: number;
  onLeave: () => void;
}

interface PeerEntry {
  user: PublicUser | null;
  state: VoicePeerState;
  stream: MediaStream | null;
}

const EMPTY_STATE: VoicePeerState = {
  userId: '',
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  speaking: false,
};

export default function VoiceRoom({
  socket,
  channel,
  me,
  iceServers,
  turnConfigured,
  members,
  myPermissions,
  onLeave,
}: VoiceRoomProps) {
  const toast = useToast();
  const [joined, setJoined] = useState(false);
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [peers, setPeers] = useState<Record<string, PeerEntry>>({});
  const [speaking, setSpeaking] = useState(false);

  const localStream = useRef<MediaStream | null>(null);
  const videoStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const mediaEls = useRef(new Map<string, HTMLVideoElement>());
  const analysers = useRef(new Map<string, { ctx: AudioContext; analyser: AnalyserNode; data: Uint8Array }>());
  const rafRef = useRef<number>(0);
  const localPreview = useRef<HTMLVideoElement>(null);
  const canModerate = hasPermission(myPermissions, PERMISSIONS.TIMEOUT_MEMBERS);

  const signal = useCallback(
    (to: string, data: unknown) => socket.emit('voice:signal', { to, data }),
    [socket],
  );

  const attachStream = useCallback((peerId: string, stream: MediaStream) => {
    setPeers((prev) => ({
      ...prev,
      [peerId]: {
        user: prev[peerId]?.user ?? null,
        state: prev[peerId]?.state ?? { ...EMPTY_STATE, userId: peerId },
        stream,
      },
    }));
    const element = mediaEls.current.get(peerId);
    if (element && element.srcObject !== stream) {
      element.srcObject = stream;
      void element.play().catch(() => undefined);
    }
  }, []);

  const createPeer = useCallback(
    (peerId: string, initiator: boolean): RTCPeerConnection => {
      const existing = pcs.current.get(peerId);
      if (existing) return existing;
      const pc = new RTCPeerConnection({ iceServers });
      pcs.current.set(peerId, pc);

      if (localStream.current) {
        for (const track of localStream.current.getAudioTracks()) pc.addTrack(track, localStream.current);
      }
      const outgoingVideo = screenStream.current ?? videoStream.current;
      if (outgoingVideo) {
        for (const track of outgoingVideo.getVideoTracks()) pc.addTrack(track, outgoingVideo);
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) signal(peerId, { candidate: event.candidate });
      };
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) attachStream(peerId, stream);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          pc.restartIce();
        }
      };

      if (initiator) {
        void (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            signal(peerId, { description: pc.localDescription });
          } catch {
            /* sinyal hatası kullanıcıya bağlantı durumu olarak yansır */
          }
        })();
      }
      return pc;
    },
    [iceServers, signal, attachStream],
  );

  const renegotiate = useCallback(async () => {
    for (const [peerId, pc] of pcs.current) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal(peerId, { description: pc.localDescription });
      } catch {
        /* yeniden anlaşma başarısızsa bağlantı mevcut haliyle sürer */
      }
    }
  }, [signal]);

  useEffect(() => {
    let cancelled = false;

    const onSignal = async (payload: { from: string; data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      const pc = createPeer(payload.from, false);
      try {
        if (payload.data.description) {
          await pc.setRemoteDescription(payload.data.description);
          if (payload.data.description.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signal(payload.from, { description: pc.localDescription });
          }
        } else if (payload.data.candidate) {
          await pc.addIceCandidate(payload.data.candidate);
        }
      } catch {
        /* geçersiz/geç kalan sinyal yok sayılır */
      }
    };

    const onPeers = (payload: { peers: { userId: string; user: PublicUser | null; state: VoicePeerState }[] }) => {
      setPeers((prev) => {
        const next = { ...prev };
        for (const peer of payload.peers) {
          next[peer.userId] = { user: peer.user, state: peer.state, stream: prev[peer.userId]?.stream ?? null };
        }
        return next;
      });
      for (const peer of payload.peers) createPeer(peer.userId, true);
    };

    const onUserJoined = (payload: { userId: string; user: PublicUser | null; state: VoicePeerState }) => {
      setPeers((prev) => ({
        ...prev,
        [payload.userId]: { user: payload.user, state: payload.state, stream: prev[payload.userId]?.stream ?? null },
      }));
    };

    const onUserLeft = (payload: { userId: string }) => {
      pcs.current.get(payload.userId)?.close();
      pcs.current.delete(payload.userId);
      analysers.current.delete(payload.userId);
      setPeers((prev) => {
        const next = { ...prev };
        delete next[payload.userId];
        return next;
      });
    };

    const onState = (payload: { userId: string; state: VoicePeerState }) => {
      setPeers((prev) => {
        const entry = prev[payload.userId];
        if (!entry) return prev;
        return { ...prev, [payload.userId]: { ...entry, state: payload.state } };
      });
    };

    const onForcedMute = () => {
      setMuted(true);
      localStream.current?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      toast.push('Bir moderatör mikrofonunuzu kapattı.', 'info');
    };

    socket.on('voice:signal', onSignal);
    socket.on('voice:peers', onPeers);
    socket.on('voice:user-joined', onUserJoined);
    socket.on('voice:user-left', onUserLeft);
    socket.on('voice:state', onState);
    socket.on('voice:forced-mute', onForcedMute);

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStream.current = stream;
      } catch {
        if (!cancelled) {
          setNotice('Mikrofon izni verilmedi. Dinleme modunda katılıyorsunuz.');
        }
      }
      if (cancelled) return;
      socket.emit('voice:join', { channelId: channel.id }, (response: { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (response?.error) setNotice(response.error);
        else setJoined(true);
      });
    };
    void start();

    return () => {
      cancelled = true;
      socket.emit('voice:leave');
      socket.off('voice:signal', onSignal);
      socket.off('voice:peers', onPeers);
      socket.off('voice:user-joined', onUserJoined);
      socket.off('voice:user-left', onUserLeft);
      socket.off('voice:state', onState);
      socket.off('voice:forced-mute', onForcedMute);
      for (const pc of pcs.current.values()) pc.close();
      pcs.current.clear();
      for (const { ctx } of analysers.current.values()) void ctx.close();
      analysers.current.clear();
      for (const stream of [localStream.current, videoStream.current, screenStream.current]) {
        stream?.getTracks().forEach((track) => track.stop());
      }
      localStream.current = null;
      videoStream.current = null;
      screenStream.current = null;
    };
  }, [socket, channel.id, createPeer, signal, toast]);

  /* Konuşma göstergesi: yerel ve uzak akışların ses seviyesi. */
  useEffect(() => {
    if (!joined) return;
    const contexts: AudioContext[] = [];

    const watch = (key: string, stream: MediaStream | null) => {
      if (!stream || stream.getAudioTracks().length === 0) return;
      if (analysers.current.has(key)) return;
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analysers.current.set(key, { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
        contexts.push(ctx);
      } catch {
        /* ses analizi desteklenmiyorsa gösterge devre dışı kalır */
      }
    };

    watch('local', localStream.current);
    for (const [peerId, entry] of Object.entries(peers)) watch(peerId, entry.stream);

    const tick = () => {
      const local = analysers.current.get('local');
      if (local) {
        local.analyser.getByteFrequencyData(local.data as Uint8Array<ArrayBuffer>);
        const average = local.data.reduce((sum, value) => sum + value, 0) / local.data.length;
        setSpeaking(average > 18);
        if (socket.connected) socket.emit('voice:state', { speaking: average > 18 });
      }
      setPeers((prev) => {
        let changed = false;
        const next: Record<string, PeerEntry> = { ...prev };
        for (const [peerId, entry] of Object.entries(prev)) {
          const analyser = analysers.current.get(peerId);
          if (!analyser) continue;
          analyser.analyser.getByteFrequencyData(analyser.data as Uint8Array<ArrayBuffer>);
          const average = analyser.data.reduce((sum, value) => sum + value, 0) / analyser.data.length;
          const isSpeaking = average > 18;
          if (isSpeaking !== entry.state.speaking) {
            next[peerId] = { ...entry, state: { ...entry.state, speaking: isSpeaking } };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      rafRef.current = window.setTimeout(tick, 400);
    };
    tick();

    return () => {
      window.clearTimeout(rafRef.current);
      for (const ctx of contexts) void ctx.close();
    };
  }, [joined, peers, socket]);

  useEffect(() => {
    const element = localPreview.current;
    if (!element) return;
    const stream = screenStream.current ?? videoStream.current;
    if (stream) {
      element.srcObject = stream;
      void element.play().catch(() => undefined);
    } else {
      element.srcObject = null;
    }
  }, [cameraOn, screenOn]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    localStream.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    socket.emit('voice:state', { muted: next });
  };

  const toggleDeafen = () => {
    const next = !deafened;
    setDeafened(next);
    for (const element of mediaEls.current.values()) element.muted = next;
    socket.emit('voice:state', { deafened: next });
  };

  const toggleCamera = async () => {
    if (cameraOn) {
      videoStream.current?.getVideoTracks().forEach((track) => track.stop());
      videoStream.current = null;
      setCameraOn(false);
      socket.emit('voice:state', { camera: false });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      videoStream.current = stream;
      setCameraOn(true);
      socket.emit('voice:state', { camera: true });
      await renegotiate();
    } catch {
      toast.push('Kamera izni verilmedi veya kamera bulunamadı.', 'error');
    }
  };

  const toggleScreen = async () => {
    if (screenOn) {
      screenStream.current?.getVideoTracks().forEach((track) => track.stop());
      screenStream.current = null;
      setScreenOn(false);
      socket.emit('voice:state', { screen: false });
      await renegotiate();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStream.current = stream;
      setScreenOn(true);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        screenStream.current = null;
        setScreenOn(false);
        socket.emit('voice:state', { screen: false });
        void renegotiate();
      });
      socket.emit('voice:state', { screen: true });
      await renegotiate();
    } catch {
      toast.push('Ekran paylaşımı başlatılamadı.', 'error');
    }
  };

  const forceMute = (userId: string) => {
    socket.emit('voice:force-mute', { userId, muted: true });
    toast.push('Katılımcı susturuldu.', 'success');
  };

  const peerEntries = Object.entries(peers);
  const memberOf = (userId: string) => members.find((m) => m.userId === userId) ?? null;

  return (
    <section className="voice-stage" aria-label={`${channel.name} sesli kanalı`}>
      <div className="row-between" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <div className="row">
          <Icon name="volume" size={18} />
          <strong>{channel.name}</strong>
          <span className="chip">{peerEntries.length + 1} katılımcı</span>
          {!joined ? <span className="chip">bağlanıyor…</span> : null}
        </div>
        <button type="button" className="btn btn-danger btn-sm" onClick={onLeave}>
          <Icon name="phoneOff" size={14} /> Ayrıl
        </button>
      </div>

      {notice ? <div className="hint" style={{ padding: '8px 14px' }}>{notice}</div> : null}
      {!turnConfigured ? (
        <div className="hint" style={{ padding: '8px 14px' }}>
          TURN sunucusu yapılandırılmadı. Katılımcılar simetrik NAT arkasındaysa bağlantı kurulamayabilir.
        </div>
      ) : null}

      <div className="voice-grid">
        <div className={`voice-tile${speaking ? ' speaking' : ''}`}>
          <video ref={localPreview} muted playsInline autoPlay className="voice-video" />
          {!cameraOn && !screenOn ? (
            <div className="voice-placeholder">
              <Avatar user={me} size={64} />
              <strong>{me.displayName}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {screenOn ? 'Ekran paylaşıyor' : cameraOn ? 'Kamera açık' : 'Siz'}
              </span>
            </div>
          ) : null}
          <div className="voice-tile-bar">
            <span className="truncate">{me.displayName} (siz)</span>
            {muted ? <Icon name="micOff" size={14} /> : <Icon name="mic" size={14} />}
          </div>
        </div>

        {peerEntries.map(([peerId, entry]) => (
          <div key={peerId} className={`voice-tile${entry.state.speaking ? ' speaking' : ''}`}>
            <video
              className="voice-video"
              playsInline
              autoPlay
              muted={deafened}
              ref={(element) => {
                if (!element) return;
                mediaEls.current.set(peerId, element);
                if (entry.stream && element.srcObject !== entry.stream) {
                  element.srcObject = entry.stream;
                  void element.play().catch(() => undefined);
                }
              }}
            />
            {!entry.state.camera && !entry.state.screen && !entry.stream?.getVideoTracks().length ? (
              <div className="voice-placeholder">
                <Avatar user={entry.user ?? { displayName: '?', avatarColor: '#444', avatarUrl: null }} size={64} />
                <strong>{entry.user?.displayName ?? 'Katılımcı'}</strong>
              </div>
            ) : null}
            <div className="voice-tile-bar">
              <span className="truncate">{entry.user?.displayName ?? 'Katılımcı'}</span>
              {entry.state.muted ? <Icon name="micOff" size={14} /> : null}
              {entry.state.screen ? <Icon name="screen" size={14} /> : null}
              {canModerate ? (
                <button type="button" className="icon-btn" onClick={() => forceMute(peerId)} aria-label="Sustur">
                  <Icon name="micOff" size={13} />
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="composer-bar" style={{ borderTop: '1px solid var(--line)' }}>
        <button type="button" className={`btn ${muted ? 'btn-danger' : 'btn-ghost'} btn-sm`} onClick={toggleMute} aria-pressed={muted}>
          <Icon name={muted ? 'micOff' : 'mic'} size={16} /> {muted ? 'Sessiz' : 'Mikrofon'}
        </button>
        <button type="button" className={`btn ${deafened ? 'btn-danger' : 'btn-ghost'} btn-sm`} onClick={toggleDeafen} aria-pressed={deafened}>
          <Icon name={deafened ? 'headphonesOff' : 'headphones'} size={16} /> {deafened ? 'Sağır' : 'Ses'}
        </button>
        <button type="button" className={`btn ${cameraOn ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={toggleCamera} aria-pressed={cameraOn}>
          <Icon name={cameraOn ? 'video' : 'videoOff'} size={16} /> Kamera
        </button>
        <button type="button" className={`btn ${screenOn ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={toggleScreen} aria-pressed={screenOn}>
          <Icon name="screen" size={16} /> Ekran
        </button>
      </div>

      <div style={{ padding: '8px 14px 16px' }}>
        <div className="sidebar-label">Katılımcılar</div>
        {[{ userId: me.id, user: me as PublicUser | null, state: { ...EMPTY_STATE, muted, deafened, camera: cameraOn, screen: screenOn, speaking } }, ...peerEntries.map(([userId, entry]) => ({ userId, user: entry.user, state: entry.state }))].map(
          (participant) => (
            <div key={participant.userId} className="member-row">
              <Avatar
                user={participant.user ?? { displayName: '?', avatarColor: '#444', avatarUrl: null }}
                size={26}
                showStatus
              />
              <span className="truncate" style={{ flex: 1 }}>
                {participant.user?.displayName ?? 'Katılımcı'}
                {participant.userId === me.id ? ' (siz)' : ''}
                {memberOf(participant.userId)?.nickname ? ` · ${memberOf(participant.userId)?.nickname}` : ''}
              </span>
              {participant.state.muted ? <Icon name="micOff" size={14} /> : null}
              {participant.state.speaking ? <span className="chip">konuşuyor</span> : null}
              {participant.userId !== me.id && canModerate && !participant.state.muted ? (
                <button type="button" className="icon-btn" onClick={() => forceMute(participant.userId)} aria-label="Sustur">
                  <Icon name="micOff" size={13} />
                </button>
              ) : null}
            </div>
          ),
        )}
        <div className="hint" style={{ marginTop: 8 }}>
          Katılım: {fullTime(Date.now())}
        </div>
      </div>
    </section>
  );
}
