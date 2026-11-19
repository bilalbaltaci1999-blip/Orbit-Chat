/** Basit bellek içi hız sınırlayıcı (spam ve brute-force koruması). */
import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  hits: number[];
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
    const key = options.key ? options.key(req) : `${req.ip ?? 'unknown'}`;
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
