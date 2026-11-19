/** ORBIT istemci/sunucu ortak tip tanımları. */

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  bio: string;
  status: UserStatus;
  customStatus: string;
  createdAt: number;
}

export interface MeUser extends PublicUser {
  email: string;
  theme: 'dark' | 'light';
  settings: UserSettings;
}

export interface UserSettings {
  dmPrivacy: 'everyone' | 'friends';
  notificationsEnabled: boolean;
  soundsEnabled: boolean;
  pushEnabled: boolean;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string;
  icon: string | null;
  position: number;
  permissions: number;
  isDefault: boolean;
}

export interface ServerMember {
  userId: string;
  username: string;
  displayName: string;
  nickname: string | null;
  avatarColor: string;
  avatarUrl: string | null;
  status: UserStatus;
  customStatus: string;
  roleIds: string[];
  joinedAt: number;
  timeoutUntil: number | null;
}

export interface Channel {
  id: string;
  serverId: string;
  categoryId: string | null;
  name: string;
  topic: string;
  type: 'text' | 'voice' | 'forum' | 'announcement';
  position: number;
  slowmodeSeconds: number;
  isPrivate: boolean;
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface Server {
  id: string;
  name: string;
  description: string;
  iconColor: string;
  iconUrl: string | null;
  ownerId: string;
  isPublic: boolean;
  createdAt: number;
  memberCount: number;
}

export interface ServerDetail extends Server {
  channels: Channel[];
  categories: Category[];
  roles: Role[];
  members: ServerMember[];
  myPermissions: number;
}

export interface FileAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface PollOption {
  id: string;
  label: string;
  votes: number;
  voters: string[];
}

export interface Poll {
  id: string;
  question: string;
  allowMultiple: boolean;
  closesAt: number | null;
  options: PollOption[];
  myVotes: string[];
}

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
  users: string[];
}

export interface Message {
  id: string;
  channelId: string | null;
  dmId: string | null;
  author: PublicUser | null;
  content: string;
  title: string | null;
  parentId: string | null;
  parentPreview: { id: string; authorName: string; content: string } | null;
  type: 'text' | 'system';
  pinned: boolean;
  editedAt: number | null;
  createdAt: number;
  reactions: Reaction[];
  files: FileAttachment[];
  poll: Poll | null;
  replyCount: number;
}

export interface DmChannel {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  iconColor: string;
  ownerId: string | null;
  members: PublicUser[];
  lastMessageAt: number | null;
  unread: number;
  createdAt: number;
}

export interface FriendRequest {
  id: string;
  user: PublicUser;
  createdAt: number;
}

export interface FriendsPayload {
  friends: PublicUser[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: PublicUser[];
}

export interface Notification {
  id: string;
  type: 'mention' | 'dm' | 'friend_request' | 'friend_accept' | 'server_event' | 'system';
  title: string;
  body: string;
  serverId: string | null;
  channelId: string | null;
  dmId: string | null;
  messageId: string | null;
  actor: PublicUser | null;
  readAt: number | null;
  createdAt: number;
}

export interface InvitePreview {
  code: string;
  server: Server;
  memberCount: number;
  expiresAt: number | null;
}

export interface ServerEvent {
  id: string;
  serverId: string;
  channelId: string | null;
  title: string;
  description: string;
  startsAt: number;
  endsAt: number | null;
  createdBy: PublicUser | null;
  attendees: { userId: string; status: 'going' | 'interested' }[];
}

export interface ModLogEntry {
  id: string;
  action: string;
  actor: PublicUser | null;
  target: PublicUser | null;
  reason: string;
  createdAt: number;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Bootstrap {
  user: MeUser;
  servers: ServerDetail[];
  dms: DmChannel[];
  friends: FriendsPayload;
  notifications: Notification[];
  unread: Record<string, number>;
  voice: { iceServers: IceServerConfig[]; turnConfigured: boolean };
}

export interface VoicePeerState {
  userId: string;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
}

export interface VoiceParticipant extends PublicUser {
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, string>;
}
