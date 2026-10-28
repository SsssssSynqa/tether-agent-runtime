// SPDX-License-Identifier: Apache-2.0 AND MIT
'use strict';

// Portions derived from Codex-tg-Bridge/src/telegram-image-utils.mjs (MIT).
// Copyright (c) 2026 Codex-tg-Bridge contributors. See THIRD_PARTY_NOTICES.md.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { MAX_IMAGE_BYTES: DEFAULT_MAX_IMAGE_BYTES } = require('../../request-parts-contract.js');
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_FETCH_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_MS = 500;
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

// 2026-10-03 审计 S27：缓存文件名前面还要拼「时间戳-chat-message-hash-」约 45 字节，
// 长中文名（3 字节/字）很容易超过 Linux 单个文件名 255 字节，ENAMETOOLONG 后附件被跳过。
// 原始文件名照旧记在 originalFileName 里，这里只截短落盘用的名字，保留扩展名。
const MAX_SAFE_NAME_BYTES = 150;
function sanitizeFileName(fileName, fallback = 'telegram-file') {
  const baseName = path.basename(String(fileName || fallback));
  const cleaned = baseName
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
  if (Buffer.byteLength(cleaned, 'utf8') <= MAX_SAFE_NAME_BYTES) return cleaned;
  let ext = path.extname(cleaned);
  if (Buffer.byteLength(ext, 'utf8') > 16) ext = '';
  let stem = cleaned.slice(0, cleaned.length - ext.length);
  while (stem && Buffer.byteLength(stem, 'utf8') + Buffer.byteLength(ext, 'utf8') + 1 > MAX_SAFE_NAME_BYTES) {
    stem = Array.from(stem).slice(0, -1).join('');
  }
  return `${stem}…${ext}`;
}

// 2026-10-03 审计 S26：durable 重放时同一条消息的附件以前每次都重新 getFile + 下载，
// 再以新的时间戳前缀另存一份（最大 20MB）。「chat-message-hash」这段对同一附件是确定的，
// 先在缓存目录里找已经落盘的那份，找到就直接复用。只复用，不删除任何已有文件。
function findCachedAttachment(cacheDir, chatId, messageId, hash) {
  const infix = `-${chatId}-${messageId}-${hash}`;
  try {
    const name = fs.readdirSync(cacheDir).find((entry) => entry.includes(infix) && !entry.endsWith('.part'));
    if (!name) return null;
    const filePath = path.join(cacheDir, name);
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 ? { path: filePath, size: stat.size } : null;
  } catch (_) {
    return null;
  }
}

function mimeForExtension(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  for (const [mime, mapped] of MIME_EXTENSIONS) if (mapped === ext) return mime;
  return null;
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

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(error) {
  const message = String(error?.message || error || 'unknown Telegram error');
  const causeCode = String(error?.cause?.code || '').trim();
  return causeCode && !message.includes(causeCode)
    ? `${message} (${causeCode})`
    : message;
}

function isRetryableFetchError(error) {
  const status = Number(error?.status || 0);
  if (Number(error?.retryAfter || 0) > 0) return true;
  if (status === 408 || status === 429 || status >= 500) return true;
  const diagnostic = `${error?.name || ''} ${describeFetchError(error)}`;
  return /fetch failed|timeout|aborted|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_/i
    .test(diagnostic);
}

function telegramHttpError(response, data, fallbackMessage) {
  const error = new Error(
    data?.description
      || (data == null ? fallbackMessage : '')
      || response.statusText
      || fallbackMessage,
  );
  error.status = response.status;
  error.retryAfter = Number(
    data?.parameters?.retry_after
      || response.headers.get('retry-after')
      || 0,
  );
  if (response.ok && data == null) error.retryable = true;
  return error;
}

async function withBoundedFetchRetry(operation, {
  stage,
  timeoutMs,
  maxAttempts = DEFAULT_FETCH_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  log = () => {},
} = {}) {
  const attempts = Math.max(1, Math.min(8, Number(maxAttempts) || DEFAULT_FETCH_ATTEMPTS));
  const budgetMs = Math.max(1, Number(timeoutMs) || 40000);
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;

    try {
      return await operation({ signal: AbortSignal.timeout(remainingMs) });
    } catch (error) {
      lastError = error;
      if (!error.telegramStage) error.telegramStage = stage;
      const retryable = error.retryable === true || isRetryableFetchError(error);
      if (!retryable || attempt === attempts) throw error;

      const retryAfterMs = Number(error.retryAfter || 0) > 0
        ? Math.min(Number(error.retryAfter) * 1000, 60000)
        : Math.min(Math.max(0, Number(retryBaseMs) || 0) * (2 ** (attempt - 1)), 5000);
      if ((Date.now() - startedAt) + retryAfterMs >= budgetMs) throw error;

      log(
        `[telegram-media] ${stage} 第 ${attempt}/${attempts} 次失败，`
        + `${retryAfterMs}ms 后重试：${describeFetchError(error)}`,
      );
      await sleep(retryAfterMs);
    }
  }

  throw lastError || new Error(`${stage || 'Telegram fetch'} timed out`);
}

async function fetchTelegramJson(url, params, {
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_FETCH_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  timeoutMs = 40000,
  log = () => {},
  stage = 'getFile',
} = {}) {
  return withBoundedFetchRetry(async ({ signal }) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw telegramHttpError(response, data, 'invalid Telegram JSON response');
    }
    return data.result;
  }, { stage, timeoutMs, maxAttempts, retryBaseMs, log });
}

async function fetchTelegramFile(url, {
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_FETCH_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  timeoutMs,
  log = () => {},
  stage = 'file-download',
} = {}) {
  return withBoundedFetchRetry(async ({ signal }) => {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      throw telegramHttpError(
        response,
        null,
        `download failed: ${response.status} ${response.statusText}`,
      );
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.split(';')[0] || '',
    };
  }, { stage, timeoutMs, maxAttempts, retryBaseMs, log });
}

async function downloadTelegramImages(message, {
  token,
  cacheDir,
  log = () => {},
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_FETCH_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
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
      const cached = findCachedAttachment(
        cacheDir,
        chatId,
        messageId,
        crypto.createHash('sha256').update(`${chatId}:${messageId}:${ref.fileUniqueId}:${index}`).digest('hex').slice(0, 16),
      );
      if (cached) {
        images.push({
          path: cached.path,
          mimeType: mimeForExtension(cached.path) || ref.mimeType || 'application/octet-stream',
          width: ref.width,
          height: ref.height,
          fileSize: cached.size,
          source: ref.kind,
        });
        continue;
      }
      const file = await fetchTelegramJson(`${api}/getFile`, { file_id: ref.fileId }, {
        fetchImpl,
        maxAttempts,
        retryBaseMs,
        timeoutMs: 40000,
        log,
        stage: 'image-getFile',
      });
      if (file.file_size && file.file_size > maxImageBytes) {
        notes.push(`第 ${index + 1} 张图片超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const downloaded = await fetchTelegramFile(`${fileApi}/${file.file_path}`, {
        fetchImpl,
        maxAttempts,
        retryBaseMs,
        timeoutMs: 60000,
        log,
        stage: 'image-file-download',
      });
      const { buffer } = downloaded;
      if (buffer.length > maxImageBytes) {
        notes.push(`第 ${index + 1} 张图片超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const responseMimeType = downloaded.mimeType;
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
      // 先写 .part 再改名：重放复用缓存时不会拿到写了一半的文件
      fs.writeFileSync(`${outPath}.part`, buffer, { mode: 0o600 });
      fs.renameSync(`${outPath}.part`, outPath);

      images.push({
        path: outPath,
        mimeType,
        width: ref.width,
        height: ref.height,
        fileSize: buffer.length,
        source: ref.kind,
      });
    } catch (error) {
      const detail = describeFetchError(error);
      log(
        `图片下载失败 stage=${error.telegramStage || 'unknown'} `
        + `chat=${message?.chat?.id || '?'} message=${message?.message_id || '?'}: ${detail}`,
      );
      notes.push(`第 ${index + 1} 张图片下载失败：${detail}`);
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
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_FETCH_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
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
      const cached = findCachedAttachment(
        cacheDir,
        chatId,
        messageId,
        crypto.createHash('sha256').update(`${chatId}:${messageId}:${ref.fileUniqueId}:${index}`).digest('hex').slice(0, 16),
      );
      if (cached) {
        const safeName = sanitizeFileName(ref.fileName, `telegram-file-${index + 1}`);
        const mimeType = ref.mimeType || 'application/octet-stream';
        const preview = extractTextPreview(cached.path, { mimeType, fileName: safeName, maxPreviewChars, log });
        files.push({
          path: cached.path,
          fileName: safeName,
          originalFileName: ref.fileName || null,
          mimeType,
          fileSize: cached.size,
          source: ref.kind,
          duration: ref.duration || null,
          width: ref.width || null,
          height: ref.height || null,
          textPreview: preview.text,
          textPreviewStatus: preview.status,
        });
        continue;
      }
      const file = await fetchTelegramJson(`${api}/getFile`, { file_id: ref.fileId }, {
        fetchImpl,
        maxAttempts,
        retryBaseMs,
        timeoutMs: 40000,
        log,
        stage: 'file-getFile',
      });
      if (file.file_size && file.file_size > maxFileBytes) {
        notes.push(`第 ${index + 1} 个文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const downloaded = await fetchTelegramFile(`${fileApi}/${file.file_path}`, {
        fetchImpl,
        maxAttempts,
        retryBaseMs,
        timeoutMs: 120000,
        log,
        stage: 'file-download',
      });
      const { buffer } = downloaded;
      if (buffer.length > maxFileBytes) {
        notes.push(`第 ${index + 1} 个文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已跳过。`);
        continue;
      }

      const responseMimeType = downloaded.mimeType;
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
      // 先写 .part 再改名：重放复用缓存时不会拿到写了一半的文件
      fs.writeFileSync(`${outPath}.part`, buffer, { mode: 0o600 });
      fs.renameSync(`${outPath}.part`, outPath);
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
      const detail = describeFetchError(error);
      log(
        `文件下载失败 stage=${error.telegramStage || 'unknown'} `
        + `chat=${message?.chat?.id || '?'} message=${message?.message_id || '?'}: ${detail}`,
      );
      notes.push(`第 ${index + 1} 个文件下载失败：${detail}`);
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

function deterministicAttachmentPath(cacheDir, message, ref, index, suffix = '') {
  const chatId = String(message?.chat?.id || 'chat').replace(/[^-0-9A-Za-z_]/g, '_');
  const messageId = String(message?.message_id || 'message').replace(/[^0-9A-Za-z_]/g, '_');
  const identity = crypto
    .createHash('sha256')
    .update(`${chatId}:${messageId}:${ref.fileUniqueId}:${index}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  return path.join(cacheDir, `${chatId}-${messageId}-${identity}${suffix}`);
}

async function downloadTelegramAttachmentsWithApi(message, {
  api,
  imageCacheDir,
  fileCacheDir,
  log = () => {},
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxPreviewChars = 12000,
} = {}) {
  const images = [];
  const files = [];
  const notes = [];
  const failures = [];
  const imageRefs = getImageRefs(message);
  const fileRefs = getFileRefs(message);
  if (!imageRefs.length && !fileRefs.length) return { images, files, notes };
  if (!api?.call || !api?.downloadFile) {
    throw new Error('Telegram attachment download requires call and downloadFile adapters');
  }
  if (imageRefs.length) ensurePrivateDir(imageCacheDir);
  if (fileRefs.length) ensurePrivateDir(fileCacheDir);

  const download = async (ref, index, maxBytes, cacheDir, type) => {
    if (Number(ref.fileSize || 0) > maxBytes) {
      notes.push(`${type} ${index + 1} exceeded the configured byte limit and was skipped.`);
      return null;
    }
    const remote = await api.call('getFile', { file_id: ref.fileId });
    const file = remote?.result || remote;
    if (!file?.file_path) throw new Error('Telegram getFile omitted file_path');
    if (Number(file.file_size || 0) > maxBytes) {
      notes.push(`${type} ${index + 1} exceeded the configured byte limit and was skipped.`);
      return null;
    }
    const downloaded = await api.downloadFile(file.file_path, { maxBytes });
    const buffer = Buffer.isBuffer(downloaded?.buffer)
      ? downloaded.buffer
      : Buffer.from(downloaded?.buffer || []);
    if (!buffer.length) throw new Error('Telegram attachment download returned zero bytes');
    if (buffer.length > maxBytes) {
      notes.push(`${type} ${index + 1} exceeded the configured byte limit and was skipped.`);
      return null;
    }
    const responseMimeType = String(downloaded?.mimeType || '').split(';')[0];
    const detectedMimeType = responseMimeType && responseMimeType !== 'application/octet-stream'
      ? responseMimeType
      : ref.mimeType || 'application/octet-stream';
    const mimeType = type === 'image' && !IMAGE_MIME_RE.test(detectedMimeType)
      ? ref.mimeType || detectedMimeType
      : detectedMimeType;
    if (type === 'image' && !IMAGE_MIME_RE.test(mimeType)) {
      throw new Error(`Telegram image has unsupported MIME type: ${mimeType}`);
    }
    const suffix = type === 'image'
      ? extensionFor(file.file_path, mimeType)
      : `-${sanitizeFileName(ref.fileName, `telegram-file-${index + 1}`)}`;
    const outPath = deterministicAttachmentPath(cacheDir, message, ref, index, suffix);
    fs.writeFileSync(outPath, buffer, { mode: 0o600 });
    fs.chmodSync(outPath, 0o600);
    return {
      path: outPath,
      mimeType,
      fileSize: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  };

  for (const [index, ref] of imageRefs.entries()) {
    try {
      const downloaded = await download(ref, index, maxImageBytes, imageCacheDir, 'image');
      if (!downloaded) continue;
      images.push({
        ...downloaded,
        width: ref.width,
        height: ref.height,
        source: ref.kind,
      });
    } catch (error) {
      log(`Telegram image download failed message=${message?.message_id || '?'}: ${error.message}`);
      failures.push(error);
    }
  }

  for (const [index, ref] of fileRefs.entries()) {
    try {
      const downloaded = await download(ref, index, maxFileBytes, fileCacheDir, 'file');
      if (!downloaded) continue;
      const fileName = sanitizeFileName(ref.fileName, `telegram-file-${index + 1}`);
      const preview = extractTextPreview(downloaded.path, {
        mimeType: downloaded.mimeType,
        fileName,
        maxPreviewChars,
        log,
      });
      files.push({
        ...downloaded,
        fileName,
        originalFileName: ref.fileName || null,
        source: ref.kind,
        duration: ref.duration || null,
        width: ref.width || null,
        height: ref.height || null,
        textPreview: preview.text,
        textPreviewStatus: preview.status,
      });
    } catch (error) {
      log(`Telegram file download failed message=${message?.message_id || '?'}: ${error.message}`);
      failures.push(error);
    }
  }

  if (failures.length) {
    const error = new AggregateError(
      failures,
      `Telegram attachment download failed for ${failures.length} item(s)`,
    );
    error.code = 'TETHER_ATTACHMENT_DOWNLOAD_FAILED';
    throw error;
  }

  return { images, files, notes };
}

function summarizeImages(images = [], notes = []) {
  const parts = [];
  if (images.length) {
    parts.push(`已附带 ${images.length} 张图片视觉输入（图只在收到它的这一轮看得见；之后的轮次里图已经不在了，有人再问图里的字或细节，要直说看不到、请对方重发或回复那张图，不许凭印象补）。`);
    for (const [index, image] of images.entries()) {
      const size = image.width && image.height ? `, ${image.width}x${image.height}` : '';
      parts.push(`图片 ${index + 1}: ${image.mimeType || 'unknown'}${size}`);
    }
  }
  if (notes.length) parts.push(...notes);
  return parts.join('\n');
}

function summarizeFiles(files = [], notes = [], { includeLocalPaths = true } = {}) {
  const parts = [];
  if (files.length) {
    parts.push(includeLocalPaths
      ? `已附带 ${files.length} 个文件，已下载到本机，Agent 可以按路径读取。`
      : `Attached files: ${files.length}. They were archived in Tether's private attachment store.`);
    for (const [index, file] of files.entries()) {
      const size = file.fileSize ? `, ${Math.round(file.fileSize / 1024)}KB` : '';
      const dimensions = file.width && file.height ? `, ${file.width}x${file.height}` : '';
      const duration = file.duration ? `, ${file.duration}s` : '';
      parts.push(
        `文件 ${index + 1}: ${file.fileName || '未命名'} (${file.mimeType || 'unknown'}${size}${dimensions}${duration})`,
      );
      if (includeLocalPaths) parts.push(`本机路径: ${file.path}`);
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

function buildMessageTextWithAttachments(text, images = [], files = [], notes = [], options = {}) {
  const trimmed = String(text || '').trim();
  const imageSummary = summarizeImages(images);
  const fileSummary = summarizeFiles(files, notes, options);
  const summaries = [imageSummary, fileSummary].filter(Boolean).join('\n\n');
  if (!summaries) return trimmed;
  if (!trimmed) return `（发送了附件）\n${summaries}`;
  return `${trimmed}\n\n[附件]\n${summaries}`;
}

module.exports = {
  buildMessageTextWithAttachments,
  buildMessageTextWithImages,
  downloadTelegramAttachments,
  downloadTelegramAttachmentsWithApi,
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
  sanitizeFileName,
  summarizeFiles,
  summarizeImages,
};
