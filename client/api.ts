/** ORBIT API istemcisi — çerez tabanlı oturum, hata normalizasyonu, dosya yükleme. */
import type {
  Bootstrap,
  Channel,
  DmChannel,
  FileAttachment,
  FriendsPayload,
  InvitePreview,
  MeUser,
  Message,
  ModLogEntry,
  Notification,
  PublicUser,
  Role,
  ServerDetail,
  ServerEvent,
  SessionInfo,
  UserSettings,
} from '@shared/types';

const BASE = '/api';

export class ApiFailure extends Error {
  status: number;
  code?: string;
  details?: Record<string, string>;

  constructor(message: string, status: number, code?: string, details?: Record<string, string>) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiFailure('Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.', 0, 'NETWORK');
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const data = (payload ?? {}) as { error?: unknown; message?: unknown; code?: string; details?: Record<string, string> };
    const message =
      typeof data.error === 'string'
        ? data.error
        : typeof data.message === 'string'
          ? data.message
          : `İstek başarısız oldu (${response.status}).`;
    throw new ApiFailure(message, response.status, data.code, data.details);
  }

  return (payload ?? {}) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, json('POST', body ?? {})),
  patch: <T>(path: string, body?: unknown) => request<T>(path, json('PATCH', body ?? {})),
  put: <T>(path: string, body?: unknown) => request<T>(path, json('PUT', body ?? {})),
  del: <T>(path: string, body?: unknown) => request<T>(path, json('DELETE', body)),

  upload: async (file: File, channelId?: string): Promise<FileAttachment> => {
    const form = new FormData();
    form.append('file', file);
    if (channelId) form.append('channelId', channelId);
    const result = await request<{ file: FileAttachment }>('/files', { method: 'POST', body: form });
    return result.file;
  },
};

/* ---------------------------------- auth ---------------------------------- */

export const authApi = {
  login: (email: string, password: string) => api.post<{ user: MeUser }>('/auth/login', { email, password }),
  register: (input: { email: string; username: string; displayName: string; password: string }) =>
    api.post<{ user: MeUser }>('/auth/register', input),
  logout: () => api.post<{ ok: boolean }>('/auth/logout'),
  bootstrap: () => api.get<Bootstrap>('/auth/bootstrap'),
  sessions: () => api.get<{ sessions: SessionInfo[] }>('/auth/sessions'),
  revokeSession: (id: string) => api.del<{ ok: boolean }>(`/auth/sessions/${id}`),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: boolean }>('/auth/change-password', { currentPassword, newPassword }),
  forgotPassword: (email: string) =>
    api.post<{ ok: boolean; message?: string; resetUrl?: string; delivery?: string }>('/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) => api.post<{ ok: boolean }>('/auth/reset-password', { token, password }),
};

/* --------------------------------- kullanıcı ------------------------------- */

export const usersApi = {
  me: () => api.get<{ user: MeUser }>('/users/me'),
  updateMe: (patch: { displayName?: string; username?: string; bio?: string; customStatus?: string; status?: string }) =>
    api.patch<{ user: MeUser }>('/users/me', patch),
  updateSettings: (patch: Partial<UserSettings> & { theme?: 'dark' | 'light' }) =>
    api.patch<{ settings: UserSettings }>('/users/me/settings', patch),
  uploadAvatar: async (file: File) => {
    const form = new FormData();
    form.append('avatar', file);
    return request<{ avatarUrl: string }>('/users/me/avatar', { method: 'POST', body: form });
  },
  search: (q: string) => api.get<{ users: PublicUser[] }>(`/users/search?q=${encodeURIComponent(q)}`),
  profile: (id: string) => api.get<{ user: PublicUser; friendship: { status: string; requestId: string | null } }>(`/users/${id}`),
};

/* ---------------------------------- sunucu --------------------------------- */

export const serversApi = {
  create: (input: { name: string; description?: string; iconColor?: string; isPublic?: boolean }) =>
    api.post<{ server: ServerDetail }>('/servers', input),
  detail: (id: string) => api.get<{ server: ServerDetail }>(`/servers/${id}`),
  update: (id: string, patch: { name?: string; description?: string; iconColor?: string; isPublic?: boolean }) =>
    api.patch<{ server: ServerDetail }>(`/servers/${id}`, patch),
  remove: (id: string) => api.del<{ ok: boolean }>(`/servers/${id}`),
  leave: (id: string) => api.post<{ ok: boolean }>(`/servers/${id}/leave`),
  transfer: (id: string, userId: string) => api.post<{ ok: boolean }>(`/servers/${id}/transfer`, { userId }),
  members: (id: string) => api.get<{ members: ServerDetail['members'] }>(`/servers/${id}/members`),
  updateMember: (id: string, userId: string, patch: { nickname?: string | null }) =>
    api.patch<{ ok: boolean }>(`/servers/${id}/members/${userId}`, patch),
  kick: (id: string, userId: string, reason?: string) =>
    api.del<{ ok: boolean }>(`/servers/${id}/members/${userId}`, { reason }),
  timeout: (id: string, userId: string, minutes: number, reason?: string) =>
    api.post<{ ok: boolean; timeoutUntil: number | null }>(`/servers/${id}/members/${userId}/timeout`, { minutes, reason }),
  setMemberRoles: (id: string, userId: string, roleIds: string[]) =>
    api.post<{ ok: boolean }>(`/servers/${id}/members/${userId}/roles`, { roleIds }),
  bans: (id: string) => api.get<{ bans: { user: PublicUser | null; reason: string; createdAt: number }[] }>(`/servers/${id}/bans`),
  ban: (id: string, userId: string, reason?: string) => api.post<{ ok: boolean }>(`/servers/${id}/bans`, { userId, reason }),
  unban: (id: string, userId: string) => api.del<{ ok: boolean }>(`/servers/${id}/bans/${userId}`),
  roles: (id: string) => api.get<{ roles: Role[] }>(`/servers/${id}/roles`),
  createRole: (id: string, input: { name: string; color?: string; permissions?: number; icon?: string | null }) =>
    api.post<{ role: Role }>(`/servers/${id}/roles`, input),
  updateRole: (id: string, roleId: string, patch: { name?: string; color?: string; permissions?: number; position?: number; icon?: string | null }) =>
    api.patch<{ role: Role }>(`/servers/${id}/roles/${roleId}`, patch),
  deleteRole: (id: string, roleId: string) => api.del<{ ok: boolean }>(`/servers/${id}/roles/${roleId}`),
  createCategory: (id: string, name: string) => api.post<{ category: { id: string; name: string } }>(`/servers/${id}/categories`, { name }),
  updateCategory: (id: string, categoryId: string, name: string) =>
    api.patch<{ ok: boolean }>(`/servers/${id}/categories/${categoryId}`, { name }),
  deleteCategory: (id: string, categoryId: string) => api.del<{ ok: boolean }>(`/servers/${id}/categories/${categoryId}`),
  invites: (id: string) =>
    api.get<{ invites: { code: string; uses: number; maxUses: number | null; expiresAt: number | null; createdAt: number }[] }>(
      `/servers/${id}/invites`,
    ),
  createInvite: (id: string, input: { channelId?: string | null; maxUses?: number; expiresInHours?: number }) =>
    api.post<{ invite: { code: string; expiresAt: number | null; maxUses: number | null } }>(`/servers/${id}/invites`, input),
  deleteInvite: (id: string, code: string) => api.del<{ ok: boolean }>(`/servers/${id}/invites/${code}`),
  voiceState: (id: string) => api.get<{ voice: Record<string, { userId: string; state: Record<string, boolean> }[]> }>(`/servers/${id}/voice`),
  modLog: (id: string) => api.get<{ entries: ModLogEntry[] }>(`/servers/${id}/mod-log`),
  reports: (id: string) =>
    api.get<{ reports: { id: string; reason: string; status: string; createdAt: number; reporter: PublicUser | null; target: PublicUser | null }[] }>(
      `/servers/${id}/reports`,
    ),
  createReport: (id: string, input: { reason: string; targetUserId?: string; messageId?: string }) =>
    api.post<{ ok: boolean }>(`/servers/${id}/reports`, input),
  updateReport: (id: string, reportId: string, status: 'open' | 'resolved' | 'dismissed') =>
    api.patch<{ ok: boolean }>(`/servers/${id}/reports/${reportId}`, { status }),
  stats: (id: string) =>
    api.get<{ stats: { members: number; messages: number; channels: number; online: number; createdAt: number } }>(`/servers/${id}/stats`),
  webhooks: (id: string) =>
    api.get<{ webhooks: { id: string; name: string; channelId: string; token: string; createdAt: number }[] }>(`/servers/${id}/webhooks`),
  createWebhook: (id: string, input: { name: string; channelId: string }) =>
    api.post<{ webhook: { id: string; name: string; token: string; channelId: string } }>(`/servers/${id}/webhooks`, input),
  deleteWebhook: (id: string, webhookId: string) => api.del<{ ok: boolean }>(`/servers/${id}/webhooks/${webhookId}`),
  events: (id: string) => api.get<{ events: ServerEvent[] }>(`/servers/${id}/events`),
  createEvent: (id: string, input: { title: string; description?: string; startsAt: number; endsAt?: number | null; channelId?: string | null }) =>
    api.post<{ event: ServerEvent }>(`/servers/${id}/events`, input),
  updateEvent: (id: string, eventId: string, input: { title: string; description?: string; startsAt: number; endsAt?: number | null }) =>
    api.patch<{ ok: boolean }>(`/servers/${id}/events/${eventId}`, input),
  deleteEvent: (id: string, eventId: string) => api.del<{ ok: boolean }>(`/servers/${id}/events/${eventId}`),
  rsvp: (id: string, eventId: string, status: 'going' | 'interested' | 'none') =>
    api.post<{ ok: boolean }>(`/servers/${id}/events/${eventId}/rsvp`, { status }),
};

/* ---------------------------------- kanal ---------------------------------- */

export const channelsApi = {
  create: (serverId: string, input: { name: string; type?: string; categoryId?: string | null; topic?: string; isPrivate?: boolean }) =>
    api.post<{ channel: Channel }>(`/servers/${serverId}/channels`, input),
  update: (
    channelId: string,
    patch: { name?: string; topic?: string; slowmodeSeconds?: number; isPrivate?: boolean; categoryId?: string | null; position?: number },
  ) => api.patch<{ channel: Channel }>(`/channels/${channelId}`, patch),
  remove: (channelId: string) => api.del<{ ok: boolean }>(`/channels/${channelId}`),
  overwrites: (channelId: string, overwrites: { targetType: 'role' | 'member'; targetId: string; allow: number; deny: number }[]) =>
    api.put<{ ok: boolean }>(`/channels/${channelId}/overwrites`, { overwrites }),
  markRead: (channelId: string) => api.post<{ ok: boolean }>(`/channels/${channelId}/read`),
  messages: (channelId: string, before?: number) =>
    api.get<{ messages: Message[] }>(`/channels/${channelId}/messages${before ? `?before=${before}` : ''}`),
  send: (channelId: string, input: { content: string; parentId?: string | null; fileIds?: string[]; title?: string; poll?: unknown }) =>
    api.post<{ message: Message }>(`/channels/${channelId}/messages`, input),
  pins: (channelId: string) => api.get<{ messages: Message[] }>(`/channels/${channelId}/pins`),
  topics: (channelId: string) => api.get<{ topics: Message[] }>(`/channels/${channelId}/topics`),
  thread: (messageId: string) => api.get<{ messages: Message[] }>(`/messages/${messageId}/thread`),
  edit: (messageId: string, content: string) => api.patch<{ message: Message }>(`/messages/${messageId}`, { content }),
  remove: (messageId: string) => api.del<{ ok: boolean }>(`/messages/${messageId}`),
  react: (messageId: string, emoji: string) => api.post<{ message: Message }>(`/messages/${messageId}/reactions`, { emoji }),
  pin: (messageId: string) => api.post<{ message: Message }>(`/messages/${messageId}/pin`),
  vote: (messageId: string, optionId: string) => api.post<{ message: Message }>(`/messages/${messageId}/vote`, { optionId }),
  search: (q: string, filters: { serverId?: string; channelId?: string } = {}) => {
    const params = new URLSearchParams({ q });
    if (filters.serverId) params.set('serverId', filters.serverId);
    if (filters.channelId) params.set('channelId', filters.channelId);
    return api.get<{ messages: Message[] }>(`/search?${params.toString()}`);
  },
};

/* --------------------------------- sosyal --------------------------------- */

export const socialApi = {
  friends: () => api.get<{ friends: FriendsPayload }>('/friends'),
  sendRequest: (username: string) => api.post<{ status: string; requestId?: string }>('/friends/requests', { username }),
  accept: (requestId: string) => api.post<{ ok: boolean }>(`/friends/requests/${requestId}/accept`),
  decline: (requestId: string) => api.post<{ ok: boolean }>(`/friends/requests/${requestId}/decline`),
  removeFriend: (userId: string) => api.del<{ ok: boolean }>(`/friends/${userId}`),
  block: (userId: string) => api.post<{ ok: boolean }>(`/blocks/${userId}`),
  unblock: (userId: string) => api.del<{ ok: boolean }>(`/blocks/${userId}`),
  dms: () => api.get<{ dms: DmChannel[] }>('/dms'),
  openDm: (input: { userId?: string; userIds?: string[]; name?: string }) => api.post<{ dm: DmChannel }>('/dms', input),
  messages: (dmId: string, before?: number) =>
    api.get<{ messages: Message[] }>(`/dms/${dmId}/messages${before ? `?before=${before}` : ''}`),
  send: (dmId: string, input: { content: string; parentId?: string | null; fileIds?: string[] }) =>
    api.post<{ message: Message }>(`/dms/${dmId}/messages`, input),
  markRead: (dmId: string) => api.post<{ ok: boolean }>(`/dms/${dmId}/read`),
  rename: (dmId: string, name: string) => api.patch<{ ok: boolean }>(`/dms/${dmId}`, { name }),
  addMember: (dmId: string, userId: string) => api.post<{ ok: boolean }>(`/dms/${dmId}/members`, { userId }),
  removeMember: (dmId: string, userId: string) => api.del<{ ok: boolean }>(`/dms/${dmId}/members/${userId}`),
  notifications: () => api.get<{ notifications: Notification[]; unread: number }>('/notifications'),
  readNotifications: (id?: string) => api.post<{ unread: number }>('/notifications/read', id ? { id } : {}),
  clearNotifications: () => api.del<{ ok: boolean }>('/notifications'),
  pushKey: () => api.get<{ publicKey: string | null; configured: boolean }>('/push/key'),
  pushSubscribe: (subscription: unknown) => api.post<{ ok: boolean }>('/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => api.del<{ ok: boolean }>('/push/subscribe', { endpoint }),
};

/* --------------------------------- keşfet --------------------------------- */

export const discoverApi = {
  search: (q: string) => api.get<{ servers: (ServerDetail | { id: string; name: string; description: string; iconColor: string; memberCount: number; isPublic: boolean })[] }>(`/discover?q=${encodeURIComponent(q)}`),
  invite: (code: string) => api.get<{ invite: InvitePreview }>(`/invites/${encodeURIComponent(code)}`),
  join: (code: string) => api.post<{ server: ServerDetail }>(`/invites/${encodeURIComponent(code)}/join`),
  events: () => api.get<{ events: ServerEvent[] }>('/events'),
};
