/**
 * Gerçek zamanlı katman: Socket.IO üzerinden presence, yazıyor göstergesi,
 * mesaj yayını, bildirimler ve WebRTC sinyalleşmesi.
 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { db, newId, now } from './db';
import { userFromCookieHeader, type AuthUser } from './auth';
import { channelPermissions, getChannelRow, memberContext } from './permissions';
import { PERMISSIONS } from '../shared/permissions';
import { getUser, mapNotification } from './serialize';

let io: SocketServer | null = null;

interface VoiceState {
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
}

interface VoiceEntry {
  userId: string;
  serverId: string;
  channelId: string;
  state: VoiceState;
}

const voiceByChannel = new Map<string, Map<string, VoiceEntry>>();
const voiceByUser = new Map<string, string>();
const socketsByUser = new Map<string, Set<string>>();
const connectionCounts = new Map<string, number>();

export function getIo(): SocketServer {
  if (!io) throw new Error('Realtime katmanı başlatılmadı.');
  return io;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToChannel(channelId: string, event: string, payload: unknown): void {
  io?.to(`channel:${channelId}`).emit(event, payload);
}

export function emitToDm(dmId: string, event: string, payload: unknown): void {
  io?.to(`dm:${dmId}`).emit(event, payload);
}

export function emitToServer(serverId: string, event: string, payload: unknown): void {
  io?.to(`server:${serverId}`).emit(event, payload);
}

export function isOnline(userId: string): boolean {
  return (connectionCounts.get(userId) ?? 0) > 0;
}

/** Kullanıcıya bildirim kaydeder ve açık sekmelerine iletir. */
export function notify(input: {
  userId: string;
  type: 'mention' | 'dm' | 'friend_request' | 'friend_accept' | 'server_event' | 'system';
  title: string;
  body?: string;
  serverId?: string | null;
  channelId?: string | null;
  dmId?: string | null;
  messageId?: string | null;
  actorId?: string | null;
}): void {
  if (input.actorId && input.actorId === input.userId) return;
  const settings = db
    .prepare('SELECT notifications_enabled FROM user_settings WHERE user_id = ?')
    .get(input.userId) as { notifications_enabled: number } | undefined;
  const id = newId('ntf');
  const createdAt = now();
  db.prepare(
    `INSERT INTO notifications (id, user_id, type, title, body, server_id, channel_id, dm_id, message_id, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.type,
    input.title,
    input.body ?? '',
    input.serverId ?? null,
    input.channelId ?? null,
    input.dmId ?? null,
    input.messageId ?? null,
    input.actorId ?? null,
    createdAt,
  );
  if (settings && settings.notifications_enabled === 0) return;
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Parameters<typeof mapNotification>[0];
  emitToUser(input.userId, 'notification:new', mapNotification(row));
}

export function getVoiceState(serverId: string): Record<string, { userId: string; state: VoiceState }[]> {
  const out: Record<string, { userId: string; state: VoiceState }[]> = {};
  for (const [channelId, members] of voiceByChannel) {
    const channel = getChannelRow(channelId);
    if (!channel || channel.server_id !== serverId) continue;
    out[channelId] = [...members.values()].map((e) => ({ userId: e.userId, state: e.state }));
  }
  return out;
}

function voiceParticipants(channelId: string): { userId: string; state: VoiceState }[] {
  const map = voiceByChannel.get(channelId);
  if (!map) return [];
  return [...map.values()].map((e) => ({ userId: e.userId, state: e.state }));
}

function broadcastVoice(channelId: string): void {
  const channel = getChannelRow(channelId);
  if (!channel || !io) return;
  io.to(`server:${channel.server_id}`).emit('voice:update', {
    channelId,
    participants: voiceParticipants(channelId),
  });
}

function leaveVoice(userId: string): string | null {
  const channelId = voiceByUser.get(userId);
  if (!channelId) return null;
  const map = voiceByChannel.get(channelId);
  map?.delete(userId);
  if (map && map.size === 0) voiceByChannel.delete(channelId);
  voiceByUser.delete(userId);
  if (io) {
    io.to(`voice:${channelId}`).emit('voice:user-left', { channelId, userId });
    broadcastVoice(channelId);
  }
  return channelId;
}

function effectiveStatus(status: string): string {
  return status === 'invisible' ? 'offline' : status;
}

function broadcastPresence(userId: string, status: string, customStatus: string): void {
  io?.emit('presence', { userId, status: effectiveStatus(status), customStatus });
}

function updatePresence(userId: string, delta: number): void {
  const next = (connectionCounts.get(userId) ?? 0) + delta;
  if (next <= 0) {
    connectionCounts.delete(userId);
  } else {
    connectionCounts.set(userId, next);
  }
  const row = db.prepare('SELECT status, custom_status FROM users WHERE id = ?').get(userId) as
    | { status: string; custom_status: string }
    | undefined;
  if (!row) return;

  if (next <= 0) {
    const newStatus = row.status === 'invisible' ? 'invisible' : 'offline';
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now(), userId);
    broadcastPresence(userId, newStatus, row.custom_status);
  } else if (next === 1) {
    if (row.status === 'offline') {
      db.prepare("UPDATE users SET status = 'online', updated_at = ? WHERE id = ?").run(now(), userId);
      broadcastPresence(userId, 'online', row.custom_status);
    } else {
      broadcastPresence(userId, row.status, row.custom_status);
    }
  }
}

function dmRoomAllowed(dmId: string, userId: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM dm_members WHERE dm_id = ? AND user_id = ?').get(dmId, userId);
  return Boolean(row);
}

function channelRoomAllowed(channelId: string, userId: string): boolean {
  const channel = getChannelRow(channelId);
  if (!channel) return false;
  const ctx = memberContext(channel.server_id, userId);
  if (!ctx) return false;
  const perms = channelPermissions(ctx, channel);
  return (perms & PERMISSIONS.VIEW_CHANNEL) !== 0;
}

const typingThrottle = new Map<string, number>();

export function initRealtime(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 512 * 1024,
  });

  io.use((socket, next) => {
    const user = userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as AuthUser;
    socket.join(`user:${user.id}`);
    const set = socketsByUser.get(user.id) ?? new Set<string>();
    set.add(socket.id);
    socketsByUser.set(user.id, set);
    updatePresence(user.id, 1);

    socket.emit('ready', { userId: user.id, online: [...connectionCounts.keys()] });

    socket.on('subscribe', (payload: { channelId?: string; dmId?: string }) => {
      const channelId = typeof payload?.channelId === 'string' ? payload.channelId : null;
      const dmId = typeof payload?.dmId === 'string' ? payload.dmId : null;
      for (const room of socket.rooms) {
        if (room.startsWith('channel:') || room.startsWith('dm:')) socket.leave(room);
      }
      if (channelId && channelRoomAllowed(channelId, user.id)) {
        socket.join(`channel:${channelId}`);
        const channel = getChannelRow(channelId);
        if (channel) socket.join(`server:${channel.server_id}`);
      }
      if (dmId && dmRoomAllowed(dmId, user.id)) socket.join(`dm:${dmId}`);
    });

    socket.on('typing', (payload: { scope?: string; id?: string }) => {
      const scope = payload?.scope;
      const id = payload?.id;
      if (typeof id !== 'string' || (scope !== 'channel' && scope !== 'dm')) return;
      const key = `${user.id}:${scope}:${id}`;
      const stamp = now();
      const last = typingThrottle.get(key) ?? 0;
      if (stamp - last < 1500) return;
      typingThrottle.set(key, stamp);
      if (scope === 'channel' && !channelRoomAllowed(id, user.id)) return;
      if (scope === 'dm' && !dmRoomAllowed(id, user.id)) return;
      socket.to(`${scope}:${id}`).emit('typing', {
        scope,
        id,
        userId: user.id,
        displayName: user.displayName,
        at: stamp,
      });
    });

    socket.on('voice:join', (payload: { channelId?: string }, ack?: (res: unknown) => void) => {
      const channelId = payload?.channelId;
      if (typeof channelId !== 'string') return;
      const channel = getChannelRow(channelId);
      if (!channel || channel.type !== 'voice') {
        ack?.({ error: 'Sesli kanal bulunamadı.' });
        return;
      }
      const ctx = memberContext(channel.server_id, user.id);
      if (!ctx) {
        ack?.({ error: 'Bu sunucunun üyesi değilsiniz.' });
        return;
      }
      const perms = channelPermissions(ctx, channel);
      if ((perms & PERMISSIONS.CONNECT_VOICE) === 0) {
        ack?.({ error: 'Sesli kanala katılma yetkiniz yok.' });
        return;
      }
      leaveVoice(user.id);
      const existing = [...(voiceByChannel.get(channelId)?.values() ?? [])];
      const state: VoiceState = { muted: false, deafened: false, camera: false, screen: false, speaking: false };
      const map = voiceByChannel.get(channelId) ?? new Map<string, VoiceEntry>();
      map.set(user.id, { userId: user.id, serverId: channel.server_id, channelId, state });
      voiceByChannel.set(channelId, map);
      voiceByUser.set(user.id, channelId);
      socket.join(`voice:${channelId}`);
      socket.emit('voice:peers', {
        channelId,
        peers: existing.map((e) => ({ userId: e.userId, user: getUser(e.userId), state: e.state })),
      });
      socket.to(`voice:${channelId}`).emit('voice:user-joined', {
        channelId,
        userId: user.id,
        user: getUser(user.id),
        state,
      });
      broadcastVoice(channelId);
      ack?.({ ok: true, channelId });
    });

    socket.on('voice:leave', () => {
      leaveVoice(user.id);
    });

    socket.on('voice:state', (payload: Partial<VoiceState>) => {
      const channelId = voiceByUser.get(user.id);
      if (!channelId) return;
      const entry = voiceByChannel.get(channelId)?.get(user.id);
      if (!entry) return;
      const next: VoiceState = {
        muted: typeof payload?.muted === 'boolean' ? payload.muted : entry.state.muted,
        deafened: typeof payload?.deafened === 'boolean' ? payload.deafened : entry.state.deafened,
        camera: typeof payload?.camera === 'boolean' ? payload.camera : entry.state.camera,
        screen: typeof payload?.screen === 'boolean' ? payload.screen : entry.state.screen,
        speaking: typeof payload?.speaking === 'boolean' ? payload.speaking : entry.state.speaking,
      };
      entry.state = next;
      socket.to(`voice:${channelId}`).emit('voice:state', { channelId, userId: user.id, state: next });
      broadcastVoice(channelId);
    });

    socket.on('voice:signal', (payload: { to?: string; data?: unknown }) => {
      const target = payload?.to;
      if (typeof target !== 'string' || target === user.id) return;
      const channelId = voiceByUser.get(user.id);
      if (!channelId) return;
      if (voiceByUser.get(target) !== channelId) return;
      io?.to(`user:${target}`).emit('voice:signal', { from: user.id, channelId, data: payload.data });
    });

    socket.on('voice:force-mute', (payload: { userId?: string; muted?: boolean }) => {
      const targetId = payload?.userId;
      if (typeof targetId !== 'string' || typeof payload?.muted !== 'boolean') return;
      const channelId = voiceByUser.get(user.id);
      if (!channelId) return;
      const channel = getChannelRow(channelId);
      if (!channel) return;
      const ctx = memberContext(channel.server_id, user.id);
      if (!ctx) return;
      const perms = channelPermissions(ctx, channel);
      if ((perms & PERMISSIONS.TIMEOUT_MEMBERS) === 0) return;
      const entry = voiceByChannel.get(channelId)?.get(targetId);
      if (!entry) return;
      entry.state.muted = payload.muted;
      io?.to(`user:${targetId}`).emit('voice:forced-mute', { channelId, muted: payload.muted });
      broadcastVoice(channelId);
    });

    socket.on('disconnect', () => {
      const set = socketsByUser.get(user.id);
      set?.delete(socket.id);
      if (set && set.size === 0) socketsByUser.delete(user.id);
      leaveVoice(user.id);
      updatePresence(user.id, -1);
      for (const key of typingThrottle.keys()) {
        if (key.startsWith(`${user.id}:`)) typingThrottle.delete(key);
      }
    });
  });

  return io;
}

export function disconnectUserSockets(userId: string): void {
  const set = socketsByUser.get(userId);
  if (!set || !io) return;
  for (const socketId of set) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.disconnect(true);
  }
}
