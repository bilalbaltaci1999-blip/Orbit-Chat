/** ORBIT sunucusu — API, statik istemci, realtime ve hata yönetimi. */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from './db';
import { cleanupSessions, requireAuth } from './auth';
import { initRealtime } from './realtime';
import { buildBootstrap } from './bootstrap';
import { ApiError } from './permissions';
import { isPrivateAddress } from './rateLimit';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import serverRoutes from './routes/servers';
import channelRoutes from './routes/channels';
import socialRoutes from './routes/social';
import extraRoutes from './routes/extras';

runMigrations();

const app = express();
app.disable('x-powered-by');
// Cloudflare + nginx arkasında: yalnızca özel/loopback atlamalara güven.
app.set('trust proxy', (ip: string) => isPrivateAddress(ip));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'ORBIT', uptime: Math.round(process.uptime()) });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api', channelRoutes);
app.use('/api', socialRoutes);
app.use('/api', extraRoutes);

app.get('/api/bootstrap', requireAuth, (req, res) => {
  res.json(buildBootstrap(req.user!));
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { message: 'Uç nokta bulunamadı.', code: 'NOT_FOUND' } });
});

const clientDir = path.join(__dirname, '..', 'client');
if (fs.existsSync(clientDir)) {
  app.use(
    express.static(clientDir, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }
  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.too.large') {
    res.status(413).json({ error: { message: 'Yüklenen veri çok büyük.', code: 'PAYLOAD_TOO_LARGE' } });
    return;
  }
  if (typeof anyErr?.message === 'string' && anyErr.message.includes('File too large')) {
    res.status(413).json({ error: { message: 'Dosya boyutu sınırı aşıldı.', code: 'FILE_TOO_LARGE' } });
    return;
  }
  console.error('[orbit] beklenmeyen hata:', anyErr?.message ?? err);
  res.status(500).json({ error: { message: 'Sunucu hatası. Lütfen tekrar deneyin.', code: 'INTERNAL_ERROR' } });
});

const server = http.createServer(app);
initRealtime(server);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`[orbit] http://0.0.0.0:${port} üzerinde çalışıyor`);
});

const cleanup = setInterval(() => {
  try {
    cleanupSessions();
  } catch (error) {
    console.error('[orbit] oturum temizliği başarısız:', (error as Error).message);
  }
}, 30 * 60_000);
cleanup.unref();

function shutdown(signal: string): void {
  console.log(`[orbit] ${signal} alındı, kapatılıyor`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
