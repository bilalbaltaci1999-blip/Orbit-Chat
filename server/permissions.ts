/**
 * Sunucu tarafı yetki motoru.
 * Tüm kritik kontroller burada hesaplanır; istemciden gelen izin bilgisine asla güvenilmez.
 */
import { db, newId, now } from './db';
import { ALL_PERMISSIONS, PERMISSIONS } from '../shared/permissions';

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, string>;

  constructor(status: number, message: string, code?: string, details?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ServerRow {
  id: string;
  name: string;
  description: string;
  icon_color: string;
  icon_url: string | null;
  banner_url: string | null;
  owner_id: string;
  is_public: number;
  created_at: number;
}

export interface MemberRow {
  server_id: string;
  user_id: string;
  nickname: string | null;
  joined_at: number;
  timeout_until: number | null;
}

export interface RoleRow {
  id: string;
  server_id: string;
  name: string;
  color: string;
  icon: string | null;
  position: number;
  permissions: number;
  is_default: number;
  created_at: number;
}

export interface ChannelRow {
  id: string;
  server_id: string;
  category_id: string | null;
  name: string;
  topic: string;
  type: 'text' | 'voice' | 'forum' | 'announcement';
  position: number;
  slowmode_seconds: number;
  is_private: number;
  created_at: number;
}

export interface MemberContext {
  server: ServerRow;
  member: MemberRow;
  userId: string;
  isOwner: boolean;
  permissions: number;
  roleIds: string[];
  everyoneRoleId: string | null;
  highestPosition: number;
}

const qServer = db.prepare('SELECT * FROM servers WHERE id = ?');
const qMember = db.prepare('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?');
const qChannel = db.prepare('SELECT * FROM channels WHERE id = ?');
const qRoles = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position ASC');
const qMemberRoleIds = db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?');

export function getServerRow(serverId: string): ServerRow | null {
  return (qServer.get(serverId) as ServerRow | undefined) ?? null;
}

export function getChannelRow(channelId: string): ChannelRow | null {
  return (qChannel.get(channelId) as ChannelRow | undefined) ?? null;
}

export function getMemberRow(serverId: string, userId: string): MemberRow | null {
  return (qMember.get(serverId, userId) as MemberRow | undefined) ?? null;
}

export function getServerRoles(serverId: string): RoleRow[] {
  return qRoles.all(serverId) as RoleRow[];
}

export function getMemberRoleIds(serverId: string, userId: string): string[] {
  return (qMemberRoleIds.all(serverId, userId) as { role_id: string }[]).map((r) => r.role_id);
}

/** @everyone + üye rollerinin izin birleşimi. */
export function basePermissions(serverId: string, userId: string, roleIds?: string[]): number {
  const roles = getServerRoles(serverId);
  const ids = new Set(roleIds ?? getMemberRoleIds(serverId, userId));
  let perms = 0;
  for (const role of roles) {
    if (role.is_default === 1 || ids.has(role.id)) perms |= role.permissions;
  }
  return perms;
}

export function memberContext(serverId: string, userId: string): MemberContext | null {
  const server = getServerRow(serverId);
  if (!server) return null;
  const member = getMemberRow(serverId, userId);
  if (!member) return null;
  const roles = getServerRoles(serverId);
  const roleIds = getMemberRoleIds(serverId, userId);
  const everyone = roles.find((r) => r.is_default === 1) ?? null;
  const isOwner = server.owner_id === userId;
  let permissions = 0;
  for (const role of roles) {
    if (role.is_default === 1 || roleIds.includes(role.id)) permissions |= role.permissions;
  }
  if (isOwner) permissions = ALL_PERMISSIONS;
  const highestPosition = roles
    .filter((r) => roleIds.includes(r.id))
    .reduce((max, r) => Math.max(max, r.position), 0);
  return {
    server,
    member,
    userId,
    isOwner,
    permissions,
    roleIds,
    everyoneRoleId: everyone?.id ?? null,
    highestPosition,
  };
}

export function requireMemberContext(serverId: string, userId: string): MemberContext {
  const ctx = memberContext(serverId, userId);
  if (!ctx) throw new ApiError(403, 'Bu sunucunun üyesi değilsiniz.', 'NOT_MEMBER');
  return ctx;
}

export function channelPermissions(ctx: MemberContext, channel: ChannelRow): number {
  if (ctx.isOwner) return ALL_PERMISSIONS;
  let perms = ctx.permissions;
  if ((perms & PERMISSIONS.ADMINISTRATOR) !== 0) return ALL_PERMISSIONS;
  if (channel.is_private === 1) perms &= ~PERMISSIONS.VIEW_CHANNEL;

  const overwrites = db
    .prepare('SELECT target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?')
    .all(channel.id) as { target_type: 'role' | 'member'; target_id: string; allow: number; deny: number }[];

  const apply = (o: { allow: number; deny: number }) => {
    perms = (perms & ~o.deny) | o.allow;
  };

  for (const o of overwrites) {
    if (o.target_type === 'role' && ctx.everyoneRoleId && o.target_id === ctx.everyoneRoleId) apply(o);
  }
  for (const o of overwrites) {
    if (o.target_type === 'role' && ctx.roleIds.includes(o.target_id)) apply(o);
  }
  for (const o of overwrites) {
    if (o.target_type === 'member' && o.target_id === ctx.userId) apply(o);
  }
  return perms;
}

export function canViewChannel(ctx: MemberContext, channel: ChannelRow): boolean {
  const perms = channelPermissions(ctx, channel);
  return (perms & PERMISSIONS.VIEW_CHANNEL) !== 0;
}

export function assertPermission(permissions: number, bit: number, message = 'Bu işlem için yetkiniz yok.'): void {
  if ((permissions & PERMISSIONS.ADMINISTRATOR) !== 0) return;
  if ((permissions & bit) !== bit) throw new ApiError(403, message, 'MISSING_PERMISSION');
}

/** Kanal erişimi + izin denetimi; kanal yoksa 404 fırlatır. */
export function requireChannelAccess(userId: string, channelId: string, bit?: number) {
  const channel = getChannelRow(channelId);
  if (!channel) throw new ApiError(404, 'Kanal bulunamadı.', 'CHANNEL_NOT_FOUND');
  const ctx = requireMemberContext(channel.server_id, userId);
  const permissions = channelPermissions(ctx, channel);
  if ((permissions & PERMISSIONS.VIEW_CHANNEL) === 0) {
    throw new ApiError(403, 'Bu kanala erişiminiz yok.', 'NO_CHANNEL_ACCESS');
  }
  if (bit) assertPermission(permissions, bit);
  return { channel, ctx, permissions };
}

export function logModAction(input: {
  serverId: string;
  actorId: string | null;
  targetId: string | null;
  action: string;
  reason?: string;
  expiresAt?: number | null;
}): void {
  db.prepare(
    `INSERT INTO mod_actions (id, server_id, actor_id, target_id, action, reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('mod'),
    input.serverId,
    input.actorId,
    input.targetId,
    input.action,
    input.reason ?? '',
    now(),
    input.expiresAt ?? null,
  );
}

/** Rol hiyerarşisi: hedef üyenin en yüksek rolü aktörden yüksekse işlem yapılamaz. */
export function assertHierarchy(ctx: MemberContext, targetUserId: string): void {
  if (targetUserId === ctx.server.owner_id) {
    throw new ApiError(403, 'Sunucu sahibi üzerinde işlem yapılamaz.', 'OWNER_PROTECTED');
  }
  if (ctx.isOwner) return;
  const targetRoles = getServerRoles(ctx.server.id).filter((r) => getMemberRoleIds(ctx.server.id, targetUserId).includes(r.id));
  const targetHighest = targetRoles.reduce((max, r) => Math.max(max, r.position), 0);
  if (targetHighest >= ctx.highestPosition) {
    throw new ApiError(403, 'Bu üyenin rolü sizinkinden yüksek veya eşit.', 'ROLE_HIERARCHY');
  }
}
