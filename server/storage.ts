/** Dosya yükleme: boyut/tür sınırları, güvenli dosya adları ve erişim denetimi. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db, newId, now, UPLOAD_DIR } from './db';
import { ApiError, channelPermissions, getChannelRow, memberContext } from './permissions';
import { PERMISSIONS } from '../shared/permissions';

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // SVG aktif içerik barındırabileceğinden yükleme listesine alınmıyor.
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/zip',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new ApiError(400, `Desteklenmeyen dosya türü: ${file.mimetype}`, 'UNSUPPORTED_FILE'));
      return;
    }
    cb(null, true);
  },
});

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'dosya';
}

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export function saveFile(input: {
  buffer: Buffer;
  originalName: string;
  mime: string;
  uploaderId: string;
}): StoredFile {
  if (input.buffer.length > MAX_FILE_BYTES) {
    throw new ApiError(413, 'Dosya 25 MB sınırını aşıyor.', 'FILE_TOO_LARGE');
  }
  const id = newId('fil');
  const ext = path.extname(input.originalName).slice(0, 12).replace(/[^.\w]/g, '');
  const storageName = `${id}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storageName), input.buffer, { mode: 0o640 });
  const name = sanitizeName(input.originalName);
  db.prepare(
    'INSERT INTO files (id, uploader_id, name, mime, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.uploaderId, name, input.mime, input.buffer.length, storageName, now());
  return { id, name, mime: input.mime, size: input.buffer.length, url: `/api/files/${id}` };
}

export function filePathFor(id: string): { absolute: string; name: string; mime: string; size: number } | null {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
    | { name: string; mime: string; size: number; storage_path: string }
    | undefined;
  if (!row) return null;
  const absolute = path.join(UPLOAD_DIR, path.basename(row.storage_path));
  if (!absolute.startsWith(UPLOAD_DIR) || !fs.existsSync(absolute)) return null;
  return { absolute, name: row.name, mime: row.mime, size: row.size };
}

/** Dosyanın görüntülenebilmesi için kullanıcının ilgili kanal/DM'e erişimi olmalı. */
export function canAccessFile(fileId: string, userId: string): boolean {
  const links = db
    .prepare(
      `SELECT m.channel_id, m.dm_id FROM message_files mf JOIN messages m ON m.id = mf.message_id WHERE mf.file_id = ?`,
    )
    .all(fileId) as { channel_id: string | null; dm_id: string | null }[];
  if (links.length === 0) {
    const owner = db.prepare('SELECT uploader_id FROM files WHERE id = ?').get(fileId) as
      | { uploader_id: string | null }
      | undefined;
    return owner?.uploader_id === userId;
  }
  for (const link of links) {
    if (link.dm_id) {
      const member = db.prepare('SELECT 1 FROM dm_members WHERE dm_id = ? AND user_id = ?').get(link.dm_id, userId);
      if (member) return true;
    }
    if (link.channel_id) {
      const channel = getChannelRow(link.channel_id);
      if (!channel) continue;
      const ctx = memberContext(channel.server_id, userId);
      if (!ctx) continue;
      if ((channelPermissions(ctx, channel) & PERMISSIONS.VIEW_CHANNEL) !== 0) return true;
    }
  }
  return false;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
