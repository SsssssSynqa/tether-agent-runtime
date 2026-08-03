// SPDX-License-Identifier: Apache-2.0 AND MIT
'use strict';

// Portions derived from Codex-tg-Bridge/src/telegram-image-utils.mjs (MIT).
// Copyright (c) 2026 Codex-tg-Bridge contributors. See THIRD_PARTY_NOTICES.md.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(?:png|jpe?g|webp|gif)$/i;
const TEXT_MIME_RE = /^text\/|^(?:application\/(?:json|xml|javascript|x-javascript|typescript|x-ndjson)|image\/svg\+xml)$/i;
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.zsh',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.svg',
]);
const TEXTUTIL_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt']);

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

function getTelegramMessageText(message) {
  return String(message?.text || message?.caption || '').trim();
}

function getTelegramMessageEntities(message) {
  return message?.entities || message?.caption_entities || [];
}

function getImageRefs(message) {
  const refs = [];

  if (Array.isArray(message?.photo) && message.photo.length) {
    const photo = message.photo.at(-1);
    refs.push({
      kind: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || photo.file_id,
      width: photo.width || null,
      height: photo.height || null,
      fileSize: photo.file_size || null,
      mimeType: 'image/jpeg',
    });
  }

  const document = message?.document;
  if (document?.file_id && IMAGE_MIME_RE.test(String(document.mime_type || ''))) {
    refs.push({
      kind: 'document',
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || document.file_id,
      width: null,
      height: null,
      fileSize: document.file_size || null,
      mimeType: document.mime_type,
      fileName: document.file_name || null,
    });
  }

  return refs;
}

function getFileRefs(message) {
  const refs = [];

  const document = message?.document;
  if (document?.file_id && !IMAGE_MIME_RE.test(String(document.mime_type || ''))) {
    refs.push({
      kind: 'document',
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || document.file_id,
      fileSize: document.file_size || null,
      mimeType: document.mime_type || 'application/octet-stream',
      fileName: document.file_name || 'telegram-file',
    });
  }

  for (const [kind, media] of [
    ['audio', message?.audio],
    ['voice', message?.voice],
    ['video', message?.video],
    ['video_note', message?.video_note],
    ['animation', message?.animation],
    ['sticker', message?.sticker],
  ]) {
    if (!media?.file_id) continue;
    refs.push({
      kind,
      fileId: media.file_id,
      fileUniqueId: media.file_unique_id || media.file_id,
      fileSize: media.file_size || null,
      mimeType: media.mime_type || 'application/octet-stream',
      fileName: media.file_name || `${kind}-${media.file_unique_id || media.file_id}`,
      duration: media.duration || null,
      width: media.width || null,
      height: media.height || null,
    });
  }

  return refs;
}

function hasTelegramImages(message) {
  return getImageRefs(message).length > 0;
}

function hasTelegramFiles(message) {
  return getFileRefs(message).length > 0;
}

function hasTelegramAttachments(message) {
  return hasTelegramImages(message) || hasTelegramFiles(message);
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {}
}

function extensionFor(filePath, mimeType) {
  const fromPath = path.extname(filePath || '').toLowerCase();
  if (fromPath) return fromPath;
  return MIME_EXTENSIONS.get(String(mimeType || '').toLowerCase()) || '.img';
}

function sanitizeFileName(fileName, fallback = 'telegram-file') {
  const baseName = path.basename(String(fileName || fallback));
  const cleaned = baseName
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function truncatePreview(text, maxChars) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n[预览已截断]`;
}

function looksLikeText(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.02;
}

function extractTextPreview(filePath, {
  mimeType = '',
  fileName = '',
  maxPreviewChars = 12000,
  log = () => {},
} = {}) {
  const extension = path.extname(fileName || filePath).toLowerCase();

  try {
    if (TEXT_MIME_RE.test(String(mimeType || '')) || TEXT_EXTENSIONS.has(extension)) {
      const buffer = fs.readFileSync(filePath);
      if (!looksLikeText(buffer)) {
        return { text: '', status: 'binary' };
      }
      return {
        text: truncatePreview(buffer.toString('utf8'), maxPreviewChars),
        status: 'ok',
      };
    }

    if (TEXTUTIL_EXTENSIONS.has(extension) && fs.existsSync('/usr/bin/textutil')) {
      const result = spawnSync(
        '/usr/bin/textutil',
        ['-convert', 'txt', '-stdout', filePath],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: Math.max(1024 * 1024, maxPreviewChars * 8),
        },
      );
      if (result.status === 0 && String(result.stdout || '').trim()) {
        return {
          text: truncatePreview(result.stdout, maxPreviewChars),
          status: 'ok',
        };
      }
      return { text: '', status: 'unreadable' };
    }
  } catch (error) {
    log(`文件文本预览失败 path=${filePath}: ${error.message}`);
    return { text: '', status: 'error' };
  }

  return { text: '', status: 'unsupported' };
}

async function fetchTelegramJson(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || response.statusText || 'unknown Telegram error');
  }
  return data.result;
}

async function downloadTelegramImages(message, {
  token,
  cacheDir,
  log = () => {},
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const refs = getImageRefs(message);
  const images = [];
  const notes = [];
  if (!refs.length) return { images, notes };

  if (!token) {
    return { images, notes: ['图片没有下载：缺少 Telegram bot token。'] };
  }

  ensurePrivateDir(cacheDir);
  const api = `https://api.telegram.org/bot${token}`;
  const fileApi = `https://api.telegram.org/file/bot${token}`;
  const chatId = String(message?.chat?.id || 'chat').replace(/[^-0-9A-Za-z_]/g, '_');
  const messageId = String(message?.message_id || Date.now()).replace(/[^0-9A-Za-z_]/g, '_');

  for (const [index, ref] of refs.entries()) {
    if (ref.fileSize && ref.fileSize > maxImageBytes) {
      notes.push(`第 ${index + 1} 张图片超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB，已跳过。`);
      continue;
    }

    try {
      const file = await fetchTelegramJson(`${api}/getFile`, { file_id: ref.fileId });
      if (file.file_size && file.file_size > maxImageBytes) {
        notes.push(`第 ${index + 1} 张图片超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const fileResponse = await fetch(`${fileApi}/${file.file_path}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!fileResponse.ok) {
        throw new Error(`download failed: ${fileResponse.status} ${fileResponse.statusText}`);
      }

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      if (buffer.length > maxImageBytes) {
        notes.push(`第 ${index + 1} 张图片超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const responseMimeType = fileResponse.headers.get('content-type')?.split(';')[0] || '';
      const mimeType = IMAGE_MIME_RE.test(responseMimeType)
        ? responseMimeType
        : ref.mimeType || 'application/octet-stream';
      const hash = crypto
        .createHash('sha256')
        .update(`${chatId}:${messageId}:${ref.fileUniqueId}:${index}`)
        .digest('hex')
        .slice(0, 16);
      const outPath = path.join(
        cacheDir,
        `${Date.now()}-${chatId}-${messageId}-${hash}${extensionFor(file.file_path, mimeType)}`,
      );
      fs.writeFileSync(outPath, buffer, { mode: 0o600 });

      images.push({
        path: outPath,
        mimeType,
        width: ref.width,
        height: ref.height,
        fileSize: buffer.length,
        source: ref.kind,
      });
    } catch (error) {
      log(`图片下载失败 chat=${message?.chat?.id || '?'} message=${message?.message_id || '?'}: ${error.message}`);
      notes.push(`第 ${index + 1} 张图片下载失败：${error.message}`);
    }
  }

  return { images, notes };
}

async function downloadTelegramFiles(message, {
  token,
  cacheDir,
  log = () => {},
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxPreviewChars = 12000,
} = {}) {
  const refs = getFileRefs(message);
  const files = [];
  const notes = [];
  if (!refs.length) return { files, notes };

  if (!token) {
    return { files, notes: ['文件没有下载：缺少 Telegram bot token。'] };
  }

  ensurePrivateDir(cacheDir);
  const api = `https://api.telegram.org/bot${token}`;
  const fileApi = `https://api.telegram.org/file/bot${token}`;
  const chatId = String(message?.chat?.id || 'chat').replace(/[^-0-9A-Za-z_]/g, '_');
  const messageId = String(message?.message_id || Date.now()).replace(/[^0-9A-Za-z_]/g, '_');

  for (const [index, ref] of refs.entries()) {
    if (ref.fileSize && ref.fileSize > maxFileBytes) {
      notes.push(`第 ${index + 1} 个文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已跳过。`);
      continue;
    }

    try {
      const file = await fetchTelegramJson(`${api}/getFile`, { file_id: ref.fileId });
      if (file.file_size && file.file_size > maxFileBytes) {
        notes.push(`第 ${index + 1} 个文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const fileResponse = await fetch(`${fileApi}/${file.file_path}`, {
        signal: AbortSignal.timeout(120000),
      });
      if (!fileResponse.ok) {
        throw new Error(`download failed: ${fileResponse.status} ${fileResponse.statusText}`);
      }

      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      if (buffer.length > maxFileBytes) {
        notes.push(`第 ${index + 1} 个文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const responseMimeType = fileResponse.headers.get('content-type')?.split(';')[0] || '';
      const mimeType = responseMimeType && responseMimeType !== 'application/octet-stream'
        ? responseMimeType
        : ref.mimeType || 'application/octet-stream';
      const hash = crypto
        .createHash('sha256')
        .update(`${chatId}:${messageId}:${ref.fileUniqueId}:${index}`)
        .digest('hex')
        .slice(0, 16);
      const safeName = sanitizeFileName(ref.fileName, `telegram-file-${index + 1}`);
      const outPath = path.join(cacheDir, `${Date.now()}-${chatId}-${messageId}-${hash}-${safeName}`);
      fs.writeFileSync(outPath, buffer, { mode: 0o600 });
      const preview = extractTextPreview(outPath, {
        mimeType,
        fileName: safeName,
        maxPreviewChars,
        log,
      });

      files.push({
        path: outPath,
        fileName: safeName,
        originalFileName: ref.fileName || null,
        mimeType,
        fileSize: buffer.length,
        source: ref.kind,
        duration: ref.duration || null,
        width: ref.width || null,
        height: ref.height || null,
        textPreview: preview.text,
        textPreviewStatus: preview.status,
      });
    } catch (error) {
      log(`文件下载失败 chat=${message?.chat?.id || '?'} message=${message?.message_id || '?'}: ${error.message}`);
      notes.push(`第 ${index + 1} 个文件下载失败：${error.message}`);
    }
  }

  return { files, notes };
}

async function downloadTelegramAttachments(message, {
  token,
  imageCacheDir,
  fileCacheDir,
  log = () => {},
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxPreviewChars = 12000,
} = {}) {
  const [{ images, notes: imageNotes }, { files, notes: fileNotes }] = await Promise.all([
    downloadTelegramImages(message, { token, cacheDir: imageCacheDir, log, maxImageBytes }),
    downloadTelegramFiles(message, { token, cacheDir: fileCacheDir, log, maxFileBytes, maxPreviewChars }),
  ]);

  return {
    images,
    files,
    notes: [...imageNotes, ...fileNotes],
  };
}

function summarizeImages(images = [], notes = []) {
  const parts = [];
  if (images.length) {
    parts.push(`已附带 ${images.length} 张图片视觉输入。`);
    for (const [index, image] of images.entries()) {
      const size = image.width && image.height ? `, ${image.width}x${image.height}` : '';
      parts.push(`图片 ${index + 1}: ${image.mimeType || 'unknown'}${size}`);
    }
  }
  if (notes.length) parts.push(...notes);
  return parts.join('\n');
}

function summarizeFiles(files = [], notes = []) {
  const parts = [];
  if (files.length) {
    parts.push(`已附带 ${files.length} 个文件，已下载到本机，Agent 可以按路径读取。`);
    for (const [index, file] of files.entries()) {
      const size = file.fileSize ? `, ${Math.round(file.fileSize / 1024)}KB` : '';
      const dimensions = file.width && file.height ? `, ${file.width}x${file.height}` : '';
      const duration = file.duration ? `, ${file.duration}s` : '';
      parts.push(
        `文件 ${index + 1}: ${file.fileName || '未命名'} (${file.mimeType || 'unknown'}${size}${dimensions}${duration})`,
      );
      parts.push(`本机路径: ${file.path}`);
      if (file.textPreview) {
        parts.push(`文本预览:\n${file.textPreview}`);
      } else if (file.textPreviewStatus && file.textPreviewStatus !== 'ok') {
        parts.push(`文本预览: 未自动抽取（${file.textPreviewStatus}）。`);
      }
    }
  }
  if (notes.length) parts.push(...notes);
  return parts.join('\n');
}

function buildMessageTextWithImages(text, images = [], notes = []) {
  const trimmed = String(text || '').trim();
  const imageSummary = summarizeImages(images, notes);
  if (!imageSummary) return trimmed;
  if (!trimmed) return `（发送了图片）\n${imageSummary}`;
  return `${trimmed}\n\n[图片附件]\n${imageSummary}`;
}

function buildMessageTextWithAttachments(text, images = [], files = [], notes = []) {
  const trimmed = String(text || '').trim();
  const imageSummary = summarizeImages(images);
  const fileSummary = summarizeFiles(files, notes);
  const summaries = [imageSummary, fileSummary].filter(Boolean).join('\n\n');
  if (!summaries) return trimmed;
  if (!trimmed) return `（发送了附件）\n${summaries}`;
  return `${trimmed}\n\n[附件]\n${summaries}`;
}

module.exports = {
  buildMessageTextWithAttachments,
  buildMessageTextWithImages,
  downloadTelegramAttachments,
  downloadTelegramFiles,
  downloadTelegramImages,
  extractTextPreview,
  getFileRefs,
  getImageRefs,
  getTelegramMessageEntities,
  getTelegramMessageText,
  hasTelegramAttachments,
  hasTelegramFiles,
  hasTelegramImages,
  summarizeFiles,
  summarizeImages,
};
