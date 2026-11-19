/** Basit bellek içi hız sınırlayıcı (spam ve brute-force koruması). */
import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  hits: number[];
}

const PRIVATE_ADDRESS =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;

function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/i, '').trim();
}

/** Ters proxy (nginx/Cloudflare) atlama adreslerini tanır. */
export function isPrivateAddress(raw: string): boolean {
  const ip = normalizeIp(raw ?? '');
  return ip.length > 0 && PRIVATE_ADDRESS.test(ip);
}

/**
 * Gerçek istemci IP'si. Uygulama Cloudflare + nginx arkasında çalıştığı için
 * req.ip tek bir proxy adresine düşer; bu yüzden güvenilir başlıklar kullanılır.
 * Aksi halde hız sınırları tüm kullanıcılar için tek kovada toplanır.
 */
export function clientIp(req: Request): string {
  const remote = normalizeIp(req.socket?.remoteAddress ?? '');
  const behindProxy = !remote || isPrivateAddress(remote);
  if (behindProxy) {
    const cf = req.headers['cf-connecting-ip'];
    const cfValue = Array.isArray(cf) ? cf[0] : cf;
    if (cfValue && cfValue.trim()) return normalizeIp(cfValue.split(',')[0]);
    const forwarded = req.headers['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = forwardedValue?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.ip ?? remote ?? 'unknown') || 'unknown';
}

export function rateLimit(options: {
  windowMs: number;
  max: number;
  message?: string;
  key?: (req: Request) => string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const buckets = new Map<string, Bucket>();
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - options.windowMs;
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }, Math.min(options.windowMs, 60_000));
  cleanup.unref?.();

  return (req, res, next) => {
    const key = options.key ? options.key(req) : clientIp(req);
    const stamp = Date.now();
    const cutoff = stamp - options.windowMs;
    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length >= options.max) {
      const retryAfter = Math.ceil((bucket.hits[0] + options.windowMs - stamp) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      res.status(429).json({
        error: options.message ?? 'Çok fazla istek gönderdiniz. Lütfen biraz bekleyin.',
        code: 'RATE_LIMITED',
      });
      return;
    }
    bucket.hits.push(stamp);
    buckets.set(key, bucket);
    next();
  };
}
