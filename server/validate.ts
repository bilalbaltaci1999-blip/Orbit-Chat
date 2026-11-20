/** Girdi doğrulama yardımcıları — tüm API uç noktaları tarafından kullanılır. */
import { ApiError } from './permissions';

export function str(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new ApiError(400, `${field} alanı metin olmalı.`, 'INVALID_INPUT');
  const out = opts.trim === false ? value : value.trim();
  const min = opts.min ?? 0;
  const max = opts.max ?? 4000;
  if (out.length < min) throw new ApiError(400, `${field} en az ${min} karakter olmalı.`, 'INVALID_INPUT');
  if (out.length > max) throw new ApiError(400, `${field} en fazla ${max} karakter olabilir.`, 'INVALID_INPUT');
  return out;
}

export function optionalStr(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return str(value, field, opts);
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return fallback;
}

export function int(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number {
  if (value === undefined || value === null || value === '') {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new ApiError(400, `${field} alanı gerekli.`, 'INVALID_INPUT');
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) throw new ApiError(400, `${field} sayı olmalı.`, 'INVALID_INPUT');
  const rounded = Math.trunc(num);
  if (opts.min !== undefined && rounded < opts.min) {
    throw new ApiError(400, `${field} en az ${opts.min} olmalı.`, 'INVALID_INPUT');
  }
  if (opts.max !== undefined && rounded > opts.max) {
    throw new ApiError(400, `${field} en fazla ${opts.max} olabilir.`, 'INVALID_INPUT');
  }
  return rounded;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  if (fallback !== undefined) return fallback;
  throw new ApiError(400, `${field} geçersiz değer.`, 'INVALID_INPUT');
}

export function email(value: unknown): string {
  const out = str(value, 'E-posta', { min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out)) {
    throw new ApiError(400, 'Geçerli bir e-posta adresi girin.', 'INVALID_EMAIL');
  }
  return out;
}

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const RESERVED = new Set(['orbit', 'admin', 'system', 'everyone', 'here', 'root', 'support', 'moderator']);

export function username(value: unknown): string {
  const out = str(value, 'Kullanıcı adı', { min: 3, max: 24 }).toLowerCase();
  if (!USERNAME_RE.test(out)) {
    throw new ApiError(
      400,
      'Kullanıcı adı 3-24 karakter olmalı; yalnızca harf, rakam, nokta ve alt çizgi içerebilir.',
      'INVALID_USERNAME',
    );
  }
  if (RESERVED.has(out)) throw new ApiError(400, 'Bu kullanıcı adı ayrılmış.', 'RESERVED_USERNAME');
  return out;
}

export function password(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'Şifre gerekli.', 'INVALID_PASSWORD');
  if (value.length < 8) throw new ApiError(400, 'Şifre en az 8 karakter olmalı.', 'WEAK_PASSWORD');
  if (value.length > 200) throw new ApiError(400, 'Şifre çok uzun.', 'INVALID_PASSWORD');
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new ApiError(400, 'Şifre en az bir harf ve bir rakam içermeli.', 'WEAK_PASSWORD');
  }
  return value;
}

export function idList(value: unknown, field: string, max = 100): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, `${field} liste olmalı.`, 'INVALID_INPUT');
  if (value.length > max) throw new ApiError(400, `${field} en fazla ${max} öğe içerebilir.`, 'INVALID_INPUT');
  return value.map((v) => str(v, field, { min: 1, max: 64 }));
}

export function color(value: unknown, field: string, fallback = '#7c5cff'): string {
  if (value === undefined || value === null || value === '') return fallback;
  const out = str(value, field, { min: 4, max: 9 });
  if (!/^#[0-9a-fA-F]{3,8}$/.test(out)) throw new ApiError(400, `${field} geçerli bir renk kodu olmalı.`, 'INVALID_COLOR');
  return out;
}
