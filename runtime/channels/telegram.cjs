// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendWithMissingReplyFallback } = require('../../telegram-reply-fallback.js');
const { sendWithGroupRateLimit } = require('../../lib/telegram/group-rate-limit.cjs');
const {
  buildMessageTextWithAttachments,
  downloadTelegramAttachmentsWithApi,
  transcribeImagesWithVision,
} = require('../../lib/telegram/image-utils.cjs');
const {
  buildTelegramGroupBatch,
  parseTelegramGroupReplyEnvelope,
  renderTelegramGroupReplyHistory,
} = require('./telegram-group.cjs');
const { isLoopbackHostname } = require('../config-loader.cjs');
const { createPollWatchdog } = require('../bridge/poll-watchdog.js');
const {
  ensureGroupGateCommandMenu,
  handleTelegramGateCommand,
  readDynamicGroups,
} = require('./telegram-gate.cjs');

const DEFAULT_POLL_RETRY_DELAY_MS = 1000;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 40_000;
const LONG_POLL_GRACE_MS = 15_000;
const DEFAULT_POLL_STALL_CHECK_MS = 30_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function markAmbiguousDelivery(error, method) {
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Telegram request failed'));
  if (/^(?:send|edit|delete|forward|copy|setMessageReaction)/.test(String(method || ''))) {
    wrapped.deliveryAmbiguous = true;
    wrapped.manualRetryOnly = true;
  }
  return wrapped;
}

async function readBoundedResponse(response, maxBytes) {
  const limit = Math.max(1, Number(maxBytes) || 1);
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > limit) {
    const error = new Error(`Telegram attachment exceeds ${limit} bytes`);
    error.code = 'TETHER_ATTACHMENT_TOO_LARGE';
    throw error;
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) {
      const error = new Error(`Telegram attachment exceeds ${limit} bytes`);
      error.code = 'TETHER_ATTACHMENT_TOO_LARGE';
      throw error;
    }
    return buffer;
  }
  const chunks = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        const error = new Error(`Telegram attachment exceeds ${limit} bytes`);
        error.code = 'TETHER_ATTACHMENT_TOO_LARGE';
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    if (total > limit) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

function telegramRequestTimeoutMs(method, params = {}) {
  if (method !== 'getUpdates') return DEFAULT_TELEGRAM_TIMEOUT_MS;
  const serverTimeoutMs = Math.max(0, Number(params.timeout) || 0) * 1000;
  return Math.max(DEFAULT_TELEGRAM_TIMEOUT_MS, serverTimeoutMs + LONG_POLL_GRACE_MS);
}

function splitTelegramText(text, limit = 4096) {
  const characters = Array.from(String(text || ''));
  if (characters.length <= limit) return [characters.join('')];
  const chunks = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''));
  }
  return chunks;
}

function createTelegramApi({ token, apiBase = 'https://api.telegram.org', fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error('Telegram token is required');
  const parsedBase = new URL(apiBase);
  const protocol = parsedBase.protocol;
  if (!['http:', 'https:'].includes(protocol)) throw new Error('Telegram apiBase must use http or https');
  if (protocol === 'http:' && !isLoopbackHostname(parsedBase.hostname)) {
    throw new Error('Telegram apiBase must use https unless the host is loopback');
  }
  if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error('Telegram apiBase must not contain credentials, query parameters, or fragments');
  }
  const normalizedBase = parsedBase.href.replace(/\/$/, '');
  const callOnce = async (method, params = {}) => {
    let response;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      telegramRequestTimeoutMs(method, params),
    );
    timer.unref?.();
    // 超时必须罩住 response.json()：headers 到了不等于 body 会流完，
    // 之前 clearTimeout 放在 fetch 的 finally 里，body 卡住就是无限挂
    //（2026-08-22 体检发现）。AbortSignal 对 body 读取同样生效，
    // 所以把 clearTimeout 挪到 json 解析完成之后即可。
    let payload;
    try {
      response = await fetchImpl(`${normalizedBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      payload = await response.json();
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !payload.ok) {
      const error = new Error(payload.description || `Telegram HTTP ${response.status}`);
      error.status = response.status;
      const retryAfter = Number(payload?.parameters?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }
    return payload;
  };

  // Transport-layer retry adapted from the production bridge implementation.
  // Tether 首发时把这层丢了：发送碰到一次网络抖动就整轮失败，durable 层的
  // Regenerating a whole turn is more costly than an occasional duplicate delivery.
  // 矩阵与源头一致：429 尊重 retry_after、5xx 与网络类错误指数退避、
  // 其余 4xx 是真实回答立刻冒上去。getUpdates 不走这层——poll 循环
  // 自带重试与 stall 检测，双层退避会拖长卡死判定。
  // 重试耗尽后才打投递歧义标记，manualRetryOnly 的最终语义不变。
  const RETRYABLE_NET_RE = /fetch failed|timeout|aborted|ECONNRESET|EPIPE/i;
  const call = async (method, params = {}) => {
    const maxAttempts = method === 'getUpdates' ? 1 : 4;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await callOnce(method, params);
      } catch (error) {
        lastError = error;
        const retryable = error.retryAfter > 0
          || error.status === 429
          || error.status >= 500
          || (error.status === undefined && RETRYABLE_NET_RE.test(String(error.message || '')));
        if (!retryable || attempt === maxAttempts) break;
        const waitMs = error.retryAfter > 0
          ? Math.min(error.retryAfter * 1000, 60_000)
          : Math.min(500 * (2 ** (attempt - 1)), 5_000);
        console.error(`[tether] telegram ${method} attempt ${attempt}/${maxAttempts} failed, retrying in ${waitMs}ms: ${error.message}`);
        // 普通 setTimeout,不 unref:unref 的定时器在 event loop 清空时不吊进程,
        // 这个 await 会永远悬挂(离线测试当场复现)。与源头 tgWithRetry 的 sleep 一致。
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    // 歧义标记只属于网络层失败（status 缺失 = 不知道请求到没到）。
    // API 有明确回复（4xx/5xx）时投递状态是确定的，保持原实现的语义原样抛。
    if (lastError && lastError.status !== undefined) throw lastError;
    throw markAmbiguousDelivery(lastError, method);
  };
  return {
    call,
    async downloadFile(filePath, {
      maxBytes,
      timeoutMs = 120_000,
    } = {}) {
      const segments = String(filePath || '').replace(/^\/+/, '').split('/');
      if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('Telegram file_path is unsafe');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 120_000));
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(
          `${normalizedBase}/file/bot${token}/${segments.map(encodeURIComponent).join('/')}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Telegram file HTTP ${response.status}`);
        const buffer = await readBoundedResponse(response, maxBytes);
        return {
          buffer,
          mimeType: response.headers?.get?.('content-type') || 'application/octet-stream',
        };
      } finally {
        clearTimeout(timer);
      }
    },
    sendMessage(params, { noReplyGroupIds = [] } = {}) {
      const safeParams = { ...params };
      if (new Set(noReplyGroupIds.map(String)).has(String(safeParams.chat_id))) {
        delete safeParams.reply_parameters;
      }
      return sendWithMissingReplyFallback(call, 'sendMessage', safeParams);
    },
  };
}

function normalizeTelegramUpdate(update, {
  ownerIds = [],
  allowedGroupIds = [],
  privateOwnerOnly = true,
} = {}) {
  const updateKind = update?.message ? 'message' : update?.edited_message ? 'edited_message' : null;
  const message = updateKind ? update[updateKind] : null;
  if (!message) return null;
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new Error('Telegram update requires a stable non-negative update_id');
  }
  const senderId = String(message.from?.id ?? '');
  const chatId = String(message.chat?.id ?? '');
  const owner = new Set(ownerIds.map(String)).has(senderId);
  const isGroup = ['group', 'supergroup'].includes(message.chat?.type);
  if (isGroup && !new Set(allowedGroupIds.map(String)).has(chatId)) return null;
  if (!isGroup && privateOwnerOnly && !owner) return null;
  return {
    // update_id identifies the causal event. An edited_message intentionally
    // reuses Telegram's message_id, but arrives as a new update and must not
    // collide with the original text in the append-only causal journal.
    messageId: `telegram:update:${update.update_id}`,
    text: String(message.text || message.caption || ''),
    metadata: {
      channel: 'telegram',
      updateId: update.update_id,
      updateKind,
      telegramMessageId: message.message_id,
      chatId,
      chatTitle: message.chat?.title || null,
      senderId,
      senderUsername: message.from?.username || null,
      senderDisplayName: [message.from?.first_name, message.from?.last_name]
        .filter(Boolean).join(' ') || message.from?.username || senderId,
      senderIsBot: message.from?.is_bot === true,
      owner,
      isGroup,
      replyToTelegramMessageId: message.reply_to_message?.message_id || null,
      replyToSenderId: message.reply_to_message?.from?.id == null
        ? null
        : String(message.reply_to_message.from.id),
      sentAt: Number.isFinite(Number(message.date))
        ? new Date(Number(message.date) * 1000).toISOString()
        : null,
    },
  };
}

function telegramMessageFromUpdate(update) {
  return update?.message || update?.edited_message || null;
}

function isTelegramGroupUpdate(update) {
  return ['group', 'supergroup'].includes(telegramMessageFromUpdate(update)?.chat?.type);
}

function textIncludesAny(text, patterns = []) {
  const normalized = String(text || '').toLocaleLowerCase();
  return (patterns || []).some((pattern) => normalized.includes(String(pattern).toLocaleLowerCase()));
}

function isNonConversationalGroupStatus(normalized) {
  if (normalized?.metadata?.senderIsBot !== true) return false;
  const text = String(normalized?.text || '');
  return text.startsWith('[bridge-status]')
    || /You've hit your usage limit|try again at .*?(?:AM|PM)|rate limit/i.test(text)
    || /did not complete successfully|runtime unavailable/i.test(text);
}

function groupShouldRespond(normalized, policy = {}, botIdentity = {}) {
  const metadata = normalized?.metadata || {};
  if (!metadata.isGroup) return true;
  if (policy.enabled === false) return false;
  if (policy.ignoreBotMessages === true && metadata.senderIsBot) return false;
  if (isNonConversationalGroupStatus(normalized)) return false;
  if (String(policy.mode || 'all') === 'all') return true;
  if (policy.ownerAlways !== false && metadata.owner === true) return true;
  if (
    metadata.replyToSenderId
    && botIdentity.id
    && String(metadata.replyToSenderId) === String(botIdentity.id)
  ) return true;
  const patterns = [
    ...(Array.isArray(policy.mentionPatterns) ? policy.mentionPatterns : []),
    ...(botIdentity.username ? [`@${botIdentity.username}`, botIdentity.username] : []),
  ];
  return textIncludesAny(normalized.text, patterns);
}

// 2026-08-30 Telegram albums: one user-visible "album" arrives as N updates that
// only share a media_group_id — no count field, no end marker. Feeding them one
// by one answers every photo separately. Albums land in a single poll batch in
// practice (Telegram delivers the members within milliseconds), so we merge
// within the batch: the head update keeps the siblings' raw messages and the
// whole group advances the offset together. A group split across two polls
// degrades to two turns — rare, and never loses a photo.
function mergeTelegramAlbums(updates) {
  const heads = new Map();
  const merged = [];
  for (const update of updates) {
    const message = update?.message;
    const albumId = message?.media_group_id;
    if (albumId === undefined || albumId === null || albumId === '') {
      merged.push(update);
      continue;
    }
    const key = `${message.chat?.id}:${message.message_thread_id ?? ''}:${albumId}`;
    const head = heads.get(key);
    if (!head) {
      heads.set(key, update);
      merged.push(update);
      continue;
    }
    if (!Array.isArray(head._albumSiblings)) head._albumSiblings = [];
    head._albumSiblings.push(message);
    head._albumMaxUpdateId = Math.max(
      Number(head._albumMaxUpdateId ?? head.update_id),
      Number(update.update_id),
    );
    // The album caption occasionally rides on a non-first member; keep it.
    if (head.message && !head.message.caption && message.caption) {
      head.message.caption = message.caption;
    }
  }
  return merged;
}

function attachmentReferences(images = [], files = [], attachmentRoot = null) {
  return [...images, ...files].map((item) => ({
    kind: item.source || (item.fileName ? 'file' : 'image'),
    fileName: item.fileName || null,
    mimeType: item.mimeType || null,
    bytes: Number(item.fileSize || 0),
    sha256: item.sha256 || null,
    archiveRef: attachmentRoot && item.path
      ? path.relative(path.resolve(attachmentRoot), path.resolve(item.path)).split(path.sep).join('/')
      : null,
    textPreviewStatus: item.textPreviewStatus || null,
  }));
}

function imageSourceParts(images = []) {
  return images.map((image) => ({
    type: 'image',
    mimeType: image.mimeType || 'application/octet-stream',
    data: fs.readFileSync(image.path).toString('base64'),
    sha256: image.sha256 || null,
  }));
}

function attachmentCacheRecords(images = []) {
  return images.map((image) => ({
    type: 'image',
    path: image.path,
    mimeType: image.mimeType || 'application/octet-stream',
    sha256: image.sha256 || null,
    bytes: Number(image.fileSize || 0),
  }));
}

function insideDirectory(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeAtomicPrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function createPendingGroupImageStore({ filePath, imageCacheDir, maxImageBytes, log }) {
  let chats = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.schemaVersion === 1 && parsed.chats && typeof parsed.chats === 'object') {
      chats = parsed.chats;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log(`[tether] pending group image state ignored: ${error.message}`);
  }
  const save = () => writeAtomicPrivateJson(filePath, { schemaVersion: 1, chats });
  const tokenFor = (messageId, attachment) => (
    `${Number(messageId)}:${String(attachment.sha256 || path.basename(attachment.path || 'image'))}`
  );
  const validateAttachment = (attachment) => {
    if (attachment?.type !== 'image' || !insideDirectory(attachment.path, imageCacheDir)) return null;
    const bytes = fs.readFileSync(attachment.path);
    if (bytes.length > Number(maxImageBytes)) return null;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (attachment.sha256 && attachment.sha256 !== sha256) return null;
    return {
      attachment: { ...attachment, sha256 },
      sourcePart: {
        type: 'image',
        mimeType: attachment.mimeType || 'application/octet-stream',
        data: bytes.toString('base64'),
        sha256,
      },
    };
  };
  return {
    record(message) {
      const metadata = message?.metadata || {};
      const chatId = String(metadata.chatId || '');
      const messageId = Number(metadata.telegramMessageId);
      const attachments = (message?.attachmentFiles || []).filter((item) => item?.type === 'image');
      if (!chatId || !Number.isSafeInteger(messageId) || !attachments.length) return [];
      const entries = Array.isArray(chats[chatId]) ? chats[chatId] : [];
      const existing = new Set(entries.flatMap((entry) => (
        (entry.attachments || []).map((item) => tokenFor(entry.messageId, item))
      )));
      const novel = attachments.filter((item) => !existing.has(tokenFor(messageId, item)));
      if (!novel.length) return [];
      entries.push({
        messageId,
        updateId: Number(metadata.updateId) || null,
        sentAt: metadata.sentAt || null,
        attachments: structuredClone(novel),
      });
      entries.sort((left, right) => left.messageId - right.messageId);
      if (entries.length > 50) entries.splice(0, entries.length - 50);
      chats[chatId] = entries;
      save();
      return novel.map((item) => tokenFor(messageId, item));
    },
    pending(chatId, throughMessageId = Number.POSITIVE_INFINITY, limit = Number.POSITIVE_INFINITY) {
      if (Number(limit) <= 0) return { sourceParts: [], records: [], tokens: [] };
      const sourceParts = [];
      const records = [];
      const tokens = [];
      for (const entry of Array.isArray(chats[String(chatId)]) ? chats[String(chatId)] : []) {
        if (Number(entry.messageId) > Number(throughMessageId)) continue;
        for (const attachment of entry.attachments || []) {
          let validated;
          try { validated = validateAttachment(attachment); } catch (error) {
            log(`[tether] pending group image unavailable message=${entry.messageId}: ${error.message}`);
            continue;
          }
          if (!validated) continue;
          tokens.push(tokenFor(entry.messageId, validated.attachment));
          sourceParts.push(validated.sourcePart);
          records.push({
            messageId: entry.messageId,
            sentAt: entry.sentAt || null,
            mimeType: validated.attachment.mimeType || null,
            sha256: validated.attachment.sha256 || null,
          });
          if (sourceParts.length >= Number(limit)) return { sourceParts, records, tokens };
        }
      }
      return { sourceParts, records, tokens };
    },
    consume(chatId, tokens = []) {
      const consumed = new Set(tokens.map(String));
      if (!consumed.size) return 0;
      const key = String(chatId);
      let removed = 0;
      const entries = [];
      for (const entry of Array.isArray(chats[key]) ? chats[key] : []) {
        const attachments = (entry.attachments || []).filter((attachment) => {
          const drop = consumed.has(tokenFor(entry.messageId, attachment));
          if (drop) removed += 1;
          return !drop;
        });
        if (attachments.length) entries.push({ ...entry, attachments });
      }
      if (entries.length) chats[key] = entries;
      else delete chats[key];
      if (removed) save();
      return removed;
    },
  };
}

function createFileOffsetStore(filePath) {
  const resolved = path.resolve(filePath);
  return {
    read() {
      try { return Number(fs.readFileSync(resolved, 'utf8').trim()) || 0; } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
    },
    write(offset) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
      const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.writeFileSync(temporary, `${Number(offset)}\n`, { mode: 0o600 });
      const descriptor = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, resolved);
      fs.chmodSync(resolved, 0o600);
    },
  };
}

// First-run backlog drop — ported from the source bridge (2026-08-22). On a
// green-field deployment the bot may have been sitting in chats for days; with
// no stored offset, the first getUpdates hands over every retained update and
// the agent answers stale messages as if they just arrived. Drain and discard
// instead: nothing is enqueued, nothing is answered, the offset lands past the
// backlog. Callers gate this on "no offset file exists" so an established
// deployment never loses its downtime backlog.
async function dropTelegramBacklog({ api, offsetStore, log = console.log } = {}) {
  if (!api?.call) throw new Error('Backlog drop requires an API client');
  if (!offsetStore?.write) throw new Error('Backlog drop requires an offset store');
  let offset = 0;
  let dropped = 0;
  for (;;) {
    const payload = await api.call('getUpdates', {
      offset,
      timeout: 0,
      limit: 100,
      allowed_updates: ['message', 'edited_message'],
    });
    const updates = payload.result || [];
    if (!updates.length) break;
    for (const update of updates) offset = Math.max(offset, Number(update.update_id) + 1);
    dropped += updates.length;
  }
  if (offset > 0) offsetStore.write(offset);
  log(`[tether] first-run backlog drop complete: discarded ${dropped} updates, offset=${offset}`);
  return { dropped, offset };
}

// Owner notifications adapted from the production bridge implementation.
// The source bridge tells its owner about dead-letters, failed group batches,
// and fatal states over Telegram itself; Tether's first release demoted all of
// those to local log lines, which nobody watches (the 8/9 "bridge fell silent"
// incident was exactly this gap). Best-effort by design: a notification failure
// must never break the failure path it reports on.
function createOwnerNotifier({ api, ownerIds = [], log = console.error } = {}) {
  const target = (ownerIds || []).map(String).filter(Boolean)[0] || null;
  return async (text) => {
    if (!target || !api?.sendMessage) return false;
    try {
      await api.sendMessage({ chat_id: target, text: String(text || '').slice(0, 4000) });
      return true;
    } catch (error) {
      log(`[tether] owner notification failed: ${error.message}`);
      return false;
    }
  };
}

function createDurableUpdateHandler({
  channel,
  inbox,
  dispatcher,
  groupCoordinator = null,
  // Ported from the source bridge (2026-08-22): a failed private turn used to
  // die silently here — durable retry keeps working, but the person on the
  // other end just sees nothing. One notice per update, on the first failure
  // only (retry-loop failures never pass through this handler again).
  turnFailureNotice = null,
  api = null,
  log = console.error,
} = {}) {
  if (!channel?.normalizeUpdate) throw new Error('Durable Telegram ingress requires a channel');
  if (!inbox?.receive || !inbox?.getState) throw new Error('Durable Telegram ingress requires an inbox');
  if (typeof dispatcher?.processUpdate !== 'function') {
    throw new Error('Durable Telegram ingress requires a dispatcher');
  }
  return async (update) => {
    if (await channel.handleControlUpdate?.(update)) return { control: true };
    if (!channel.normalizeUpdate(update)) return { ignored: true };
    const updateId = Number(update.update_id);
    const prior = inbox.getState(updateId);
    const accepted = inbox.receive(update);
    if (!accepted) return { duplicate: true };
    if (prior && prior.state !== 'received') {
      return { durable: true, deferredToRetry: true };
    }
    const isGroup = channel.isGroupUpdate(update);
    const task = groupCoordinator && isGroup
      ? groupCoordinator.ingestUpdate(update)
      : dispatcher.processUpdate(update);
    task.catch((error) => {
      log(`[tether] durable Telegram dispatch failed update=${updateId}: ${error.message}`);
      const chatId = telegramMessageFromUpdate(update)?.chat?.id;
      if (!isGroup && turnFailureNotice && api?.sendMessage && chatId != null) {
        api.sendMessage({ chat_id: chatId, text: String(turnFailureNotice) })
          .catch((noticeError) => log(`[tether] turn failure notice failed: ${noticeError.message}`));
      }
    });
    return { durable: true };
  };
}

function createTelegramChannel({
  id = 'telegram',
  api,
  ownerIds = [],
  allowedGroupIds = [],
  allowedGroups = null,
  gateCommandPrefix = null,
  gateCommandDisplayName = null,
  dynamicGroupsPath = null,
  dynamicGroupDefaults = null,
  registerGateCommandMenu = true,
  noReplyGroupIds = [],
  rateLimitedGroupIds = [],
  rateLimitStateDir = null,
  attachmentDirectory = null,
  maxImageBytes = 10 * 1024 * 1024,
  maxFileBytes = 20 * 1024 * 1024,
  maxFilePreviewChars = 12_000,
  maxQuotedChars = 1_000,
  groupMaxReplies = 6,
  groupAllowedReactions = [],
  groupRepairAttempts = 1,
  offsetStore,
  vision = null,
  pollTimeoutSeconds = 30,
  pollRetryDelayMs = DEFAULT_POLL_RETRY_DELAY_MS,
  pollMaxConsecutiveFailures = 100,
  pollFailureGiveUpMs = 10 * 60 * 1000,
  pollStallTimeoutMs = 0,
  onPollFatal = null,
  typingHeartbeatMs = 4000,
  groupOwnerMessagesPerMinute = 60,
  groupBotMessagesPerMinute = 12,
  groupUserMessagesPerMinute = 30,
  outboundSecrets = [],
  log = console.log,
} = {}) {
  if (!api?.call || !api?.sendMessage) throw new Error('Telegram channel requires an API client');
  if (!offsetStore?.read || !offsetStore?.write) throw new Error('Telegram channel requires an offset store');
  let handler = null;
  let rawUpdateHandler = null;
  let stopped = false;
  let running = null;
  let botIdentity = { id: null, username: null };
  let stallTimer = null;
  let lastPollProgressAt = 0;
  const staticGroupPolicies = allowedGroups && typeof allowedGroups === 'object'
    ? new Map(Object.entries(allowedGroups).map(([chatId, policy]) => [
        String(chatId),
        policy && typeof policy === 'object' ? { ...policy } : {},
      ]))
    : new Map(allowedGroupIds.map((chatId) => [String(chatId), {}]));
  const groupPolicies = new Map(staticGroupPolicies);
  const dynamicPath = dynamicGroupsPath ? path.resolve(dynamicGroupsPath) : null;
  const replaceDynamicPolicies = (groups) => {
    for (const chatId of [...groupPolicies.keys()]) {
      if (!staticGroupPolicies.has(chatId)) groupPolicies.delete(chatId);
    }
    for (const [chatId, policy] of Object.entries(groups || {})) {
      if (!staticGroupPolicies.has(String(chatId))) {
        groupPolicies.set(String(chatId), policy && typeof policy === 'object' ? { ...policy } : {});
      }
    }
  };
  if (gateCommandPrefix && dynamicPath) replaceDynamicPolicies(readDynamicGroups(dynamicPath));
  const attachmentRoot = path.resolve(attachmentDirectory || path.join(process.cwd(), '.tether-attachments'));
  const imageCacheDir = path.join(attachmentRoot, 'images');
  const fileCacheDir = path.join(attachmentRoot, 'files');
  const pendingGroupImageStore = createPendingGroupImageStore({
    filePath: path.join(attachmentRoot, 'pending-group-images.json'),
    imageCacheDir,
    maxImageBytes,
    log,
  });

  // Typing heartbeat — ported from the source bridge (2026-08-22). Generation
  // takes 10-30 seconds; without the indicator the chat looks dead the whole
  // time. Fire-and-forget: a failed chat action never affects the turn.
  function startTypingHeartbeat(chatId) {
    const intervalMs = Number(typingHeartbeatMs) || 0;
    if (intervalMs <= 0 || chatId == null) return () => {};
    const beat = () => {
      api.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    };
    beat();
    const timer = setInterval(beat, Math.max(1000, intervalMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Per-sender group ingress limits — ported from the source bridge
  // (2026-08-22). Without them one runaway bot or flooding member turns every
  // message into provider spend; the source ran these caps in production for
  // months. A limited message is not dropped: it degrades to respond=false and
  // still enters the continuous history as an observation.
  const groupSenderWindows = new Map();
  const groupBotRuns = new Map();

  function allowGroupSenderIngress(chatId, senderId, senderIsBot, owner) {
    const limit = owner
      ? Number(groupOwnerMessagesPerMinute)
      : senderIsBot
        ? Number(groupBotMessagesPerMinute)
        : Number(groupUserMessagesPerMinute);
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const key = `${chatId}:${senderId}`;
    const windowStart = Date.now() - 60_000;
    const recent = (groupSenderWindows.get(key) || []).filter((at) => at >= windowStart);
    if (recent.length >= limit) {
      groupSenderWindows.set(key, recent);
      return false;
    }
    recent.push(Date.now());
    groupSenderWindows.set(key, recent);
    return true;
  }

  // Bot-to-bot ping-pong guard: consecutive responded bot messages per chat,
  // reset by any human message. Policy-configurable, 0 disables.
  function allowBotRun(chatId, policy) {
    const limit = policy.maxConsecutiveBotMessages == null
      ? 8
      : Number(policy.maxConsecutiveBotMessages);
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const next = (groupBotRuns.get(String(chatId)) || 0) + 1;
    groupBotRuns.set(String(chatId), next);
    return next <= limit;
  }

  // Runs on the dispatcher's task, never on the polling loop, so a slow or hung
  // transcriber delays one message instead of stopping every channel.
  async function visionNotesForImages(images = []) {
    if (!vision || !images.length) return [];
    try {
      const { text, skipped } = await transcribeImagesWithVision(images, vision, { log });
      const header = skipped > 0
        ? `【图片视觉转写·${vision.model}·仅前 ${images.length - skipped} 张】`
        : `【图片视觉转写·${vision.model}】`;
      return [header, text];
    } catch (error) {
      // Honest degradation: say the eyes failed, never invent what was in frame.
      log(`[tether] vision transcribe failed: ${error.message}`);
      return [`（视觉转写失败：${String(error.message).slice(0, 120)}。请如实说明看不见画面内容，不要编造。）`];
    }
  }

  function clearStallTimer() {
    if (!stallTimer) return;
    clearInterval(stallTimer);
    stallTimer = null;
  }

  function startStallTimer() {
    clearStallTimer();
    const stallMs = Number(pollStallTimeoutMs) || 0;
    if (stallMs <= 0) return;
    const checkMs = Math.max(1000, Math.min(DEFAULT_POLL_STALL_CHECK_MS, stallMs));
    // idleMs 用墙钟，interval 走单调钟：整机睡眠（合盖）期间墙钟照走、tick 不跑，
    // 醒来第一个 tick 会把整段睡眠时长算成"卡死"。2026-08-21 实测报出 1034s/1870s，
    // 全是合盖时长，300s 阈值从未按设计生效过。
    // 修法：tick 之间的墙钟间隔远超 checkMs 就说明进程/整机被冻结过——
    // 重新基线化并跳过本轮，给轮询一个完整的 stallMs 窗口去证明自己还活着。
    let lastCheckAt = Date.now();
    stallTimer = setInterval(() => {
      if (stopped) return;
      const now = Date.now();
      const sinceLastCheck = now - lastCheckAt;
      lastCheckAt = now;
      if (sinceLastCheck > checkMs * 3) {
        lastPollProgressAt = now;
        log(`[tether] poll stall timer rebased after ${Math.round(sinceLastCheck / 1000)}s freeze (sleep/suspend), not a stall`);
        return;
      }
      const idleMs = now - lastPollProgressAt;
      if (idleMs < stallMs) return;
      clearStallTimer();
      const error = new Error(
        `Telegram polling stalled: no progress for ${Math.round(idleMs / 1000)}s`,
      );
      log(`[tether] ${error.message}`);
      if (typeof onPollFatal === 'function') onPollFatal(error);
    }, checkMs);
    stallTimer.unref?.();
  }

  // Outbound secret veil — the minimal port of the source bridge's outbound
  // redaction layer (2026-08-22). The framework cannot know an operator's
  // private redaction rules, but it does know its own credentials; a model that
  // quotes config or environment content must never leak a live token into a
  // chat. Values shorter than 8 characters are skipped to avoid mangling prose.
  const secretVeil = (outboundSecrets || [])
    .map((value) => String(value || ''))
    .filter((value) => value.length >= 8);

  function redactOutboundSecrets(text) {
    let out = String(text || '');
    for (const secret of secretVeil) out = out.split(secret).join('[redacted]');
    return out;
  }

  async function sendText(chatId, text, replyToMessageId, progress) {
    const chunks = splitTelegramText(redactOutboundSecrets(text));
    const results = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const params = { chat_id: chatId, text: chunks[index] };
      if (index === 0 && replyToMessageId) {
        params.reply_parameters = {
          message_id: replyToMessageId,
          allow_sending_without_reply: true,
        };
      }
      try {
        results.push(await sendWithGroupRateLimit(
          chatId,
          () => api.sendMessage(params, { noReplyGroupIds }),
          {
            rateLimitedGroupIds,
            ...(rateLimitStateDir ? { stateDir: rateLimitStateDir } : {}),
            log,
          },
        ));
        progress.sent += 1;
      } catch (error) {
        if (progress.sent > 0) {
          const ambiguous = error instanceof Error
            ? error
            : new Error(String(error || 'Telegram partial delivery failed'));
          ambiguous.deliveryAmbiguous = true;
          ambiguous.manualRetryOnly = true;
          ambiguous.partialDeliveryCount = progress.sent;
          throw ambiguous;
        }
        throw error;
      }
    }
    return results;
  }

  const channel = {
    id: String(id),
    onMessage(next) { handler = next; },
    onUpdate(next) {
      if (next != null && typeof next !== 'function') {
        throw new Error('Telegram raw update handler must be a function');
      }
      rawUpdateHandler = next || null;
    },
    async handleControlUpdate(update) {
      if (!gateCommandPrefix || !dynamicPath) return false;
      return handleTelegramGateCommand({
        update,
        prefix: gateCommandPrefix,
        displayName: gateCommandDisplayName,
        ownerIds,
        staticGroupPolicies,
        dynamicGroupsPath: dynamicPath,
        dynamicDefaults: dynamicGroupDefaults,
        replaceDynamicPolicies,
        api,
        log,
      });
    },
    normalizeUpdate(update) {
      const normalized = normalizeTelegramUpdate(update, {
        ownerIds,
        allowedGroupIds: [...groupPolicies.keys()],
        privateOwnerOnly: true,
      });
      if (
        normalized?.metadata?.isGroup
        && groupPolicies.get(String(normalized.metadata.chatId))?.enabled === false
      ) return null;
      return normalized;
    },
    isGroupUpdate: isTelegramGroupUpdate,
    recordPendingGroupImages(message) {
      return pendingGroupImageStore.record(message);
    },
    pendingGroupImages(chatId, throughMessageId, limit) {
      return pendingGroupImageStore.pending(chatId, throughMessageId, limit);
    },
    consumePendingGroupImages(chatId, tokens) {
      return pendingGroupImageStore.consume(chatId, tokens);
    },
    async initialize() {
      const payload = await api.call('getMe', {});
      const identity = payload?.result || payload;
      botIdentity = {
        id: identity?.id == null ? null : String(identity.id),
        username: identity?.username == null ? null : String(identity.username),
      };
      if (gateCommandPrefix && dynamicPath && registerGateCommandMenu !== false) {
        await ensureGroupGateCommandMenu(api, {
          prefix: gateCommandPrefix,
          displayName: gateCommandDisplayName,
          log,
        });
      }
      return { ...botIdentity };
    },
    async prepareUpdate(update) {
      const normalized = channel.normalizeUpdate(update);
      if (!normalized) return null;
      const rawMessage = telegramMessageFromUpdate(update);
      const policy = groupPolicies.get(String(normalized.metadata.chatId)) || {};
      const { images, files, notes } = await downloadTelegramAttachmentsWithApi(rawMessage, {
        api,
        imageCacheDir,
        fileCacheDir,
        log,
        maxImageBytes,
        maxFileBytes,
        maxPreviewChars: maxFilePreviewChars,
      });
      // Album siblings folded in by mergeTelegramAlbums: usually caption-less,
      // photo-only messages. One failed download logs a line instead of taking
      // the whole turn down with it.
      for (const sibling of Array.isArray(update?._albumSiblings) ? update._albumSiblings : []) {
        try {
          const more = await downloadTelegramAttachmentsWithApi(sibling, {
            api,
            imageCacheDir,
            fileCacheDir,
            log,
            maxImageBytes,
            maxFileBytes,
            maxPreviewChars: maxFilePreviewChars,
          });
          images.push(...more.images);
          files.push(...more.files);
          if (Array.isArray(more.notes) && Array.isArray(notes)) notes.push(...more.notes);
        } catch (error) {
          log(`[tether] album sibling download failed message=${sibling?.message_id}: ${error.message}`);
        }
      }
      const quotedText = String(
        rawMessage?.reply_to_message?.text || rawMessage?.reply_to_message?.caption || '',
      ).slice(0, Math.max(0, Number(maxQuotedChars) || 0));
      const quotedSender = [
        rawMessage?.reply_to_message?.from?.first_name,
        rawMessage?.reply_to_message?.from?.last_name,
      ].filter(Boolean).join(' ') || rawMessage?.reply_to_message?.from?.username || '';
      const baseText = quotedText
        ? `[Quoted ${quotedSender || 'message'}: ${quotedText}]\n${normalized.text}`
        : normalized.text;
      const text = buildMessageTextWithAttachments(
        baseText,
        images,
        files,
        notes,
        { includeLocalPaths: false, imageNotes: await visionNotesForImages(images) },
      );
      if (!text && !images.length && !files.length) return null;
      let respond = groupShouldRespond({ ...normalized, text }, policy, botIdentity);
      if (normalized.metadata.isGroup) {
        if (!normalized.metadata.senderIsBot) groupBotRuns.set(String(normalized.metadata.chatId), 0);
        if (respond && !allowGroupSenderIngress(
          normalized.metadata.chatId,
          normalized.metadata.senderId,
          normalized.metadata.senderIsBot,
          normalized.metadata.owner,
        )) {
          log(`[tether] group sender rate limited to observation chat=${normalized.metadata.chatId} sender=${normalized.metadata.senderId}`);
          respond = false;
        }
        if (respond && normalized.metadata.senderIsBot && !allowBotRun(normalized.metadata.chatId, policy)) {
          log(`[tether] consecutive bot cap reached, observing chat=${normalized.metadata.chatId}`);
          respond = false;
        }
      }
      const attachments = attachmentReferences(images, files, attachmentRoot);
      const semanticRawMessage = {
        messageId: normalized.messageId,
        conversationId: 'primary-continuous-session',
        channel: 'telegram',
        chatId: normalized.metadata.chatId,
        senderId: normalized.metadata.senderId,
        senderDisplayName: normalized.metadata.senderDisplayName,
        senderIsBot: normalized.metadata.senderIsBot,
        sentAt: normalized.metadata.sentAt,
        text,
        archiveRef: `telegram-inbox.jsonl#${normalized.metadata.updateId}`,
        ingestionCursor: `telegram:update:${normalized.metadata.updateId}`,
        attachmentRefs: attachments.map((item) => item.archiveRef || item.sha256).filter(Boolean),
        evidenceClass: 'conversation',
      };
      return {
        ...normalized,
        text,
        respond,
        sourceParts: imageSourceParts(images),
        attachmentFiles: attachmentCacheRecords(images),
        metadata: {
          ...normalized.metadata,
          attachments,
          attachmentRefs: attachments.map((item) => item.archiveRef || item.sha256).filter(Boolean),
          semanticRawMessages: [semanticRawMessage],
          groupPolicyMode: normalized.metadata.isGroup ? String(policy.mode || 'all') : null,
        },
      };
    },
    durablePreparedMessage(message) {
      // GroupConversationBatcher attaches an in-memory Promise resolver under
      // `_delivery`. It is deliberately process-local and cannot be cloned or
      // written to the durable inbox.
      const { _delivery: _runtimeDelivery, ...serializable } = message || {};
      const durable = structuredClone(serializable);
      delete durable.sourceParts;
      delete durable.providerText;
      delete durable.systemPrompt;
      return durable;
    },
    restoreDurablePreparedMessage(message) {
      const restored = structuredClone(message || {});
      const sourceParts = [];
      for (const attachment of restored.attachmentFiles || []) {
        if (attachment.type !== 'image' || !insideDirectory(attachment.path, imageCacheDir)) {
          const error = new Error('durable Telegram attachment path is outside the image cache');
          error.code = 'TETHER_ATTACHMENT_CACHE_INVALID';
          throw error;
        }
        const bytes = fs.readFileSync(attachment.path);
        if (bytes.length > Number(maxImageBytes)) {
          const error = new Error('durable Telegram image exceeds the configured limit');
          error.code = 'TETHER_ATTACHMENT_TOO_LARGE';
          throw error;
        }
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (attachment.sha256 && sha256 !== attachment.sha256) {
          const error = new Error('durable Telegram attachment checksum mismatch');
          error.code = 'TETHER_ATTACHMENT_CACHE_INVALID';
          throw error;
        }
        sourceParts.push({
          type: 'image',
          mimeType: attachment.mimeType || 'application/octet-stream',
          data: bytes.toString('base64'),
          sha256,
        });
      }
      return { ...restored, sourceParts };
    },
    createGroupBatchMessage(record, messages, options = {}) {
      const built = buildTelegramGroupBatch(messages, {
        allowedReactions: options.allowedReactions || groupAllowedReactions,
      });
      const pending = options.pendingGroupImages || { sourceParts: [], records: [], tokens: [] };
      const sourceParts = [
        ...(pending.sourceParts || []),
        ...messages.flatMap((message) => message.sourceParts || []),
      ].filter((part, index, all) => {
        const identity = part.sha256 || `${part.mimeType}:${part.data}`;
        return all.findIndex((candidate) => (
          (candidate.sha256 || `${candidate.mimeType}:${candidate.data}`) === identity
        )) === index;
      });
      const last = messages.at(-1);
      return {
        messageId: `telegram:group-batch:${record.batchId}`,
        text: built.historyText,
        providerText: [
          built.providerText,
          ...(pending.records?.length
            ? [`PRIOR_UNSEEN_GROUP_IMAGES ${JSON.stringify(pending.records)}`]
            : []),
        ].join('\n'),
        systemPrompt: built.systemPrompt,
        sourceParts,
        metadata: {
          ...(last?.metadata || {}),
          isGroup: true,
          groupBatch: true,
          groupBatchId: record.batchId,
          updateIds: [...record.updateIds],
          groupReplyTargetIds: built.targetMessageIds,
          groupMaxReplies: Number(options.maxReplies || groupMaxReplies),
          groupAllowedReactions: options.allowedReactions || groupAllowedReactions,
          attachments: messages.flatMap((message) => message.metadata?.attachments || []),
          attachmentRefs: messages.flatMap((message) => message.metadata?.attachmentRefs || []),
          semanticRawMessages: messages.flatMap(
            (message) => message.metadata?.semanticRawMessages || [],
          ),
          pendingContextImages: pending.records || [],
          pendingContextImageTokens: pending.tokens || [],
        },
      };
    },
    async prepareOutput({ result, messages, sourceMessage, respond }) {
      const metadata = sourceMessage?.metadata || {};
      if (!metadata.groupBatch) return result;
      const options = {
        maxReplies: metadata.groupMaxReplies || groupMaxReplies,
        allowedReactions: metadata.groupAllowedReactions || groupAllowedReactions,
      };
      let candidate = result;
      for (let attempt = 0; attempt <= Math.max(0, Number(groupRepairAttempts) || 0); attempt += 1) {
        const parsed = parseTelegramGroupReplyEnvelope(
          candidate.text,
          metadata.groupReplyTargetIds || [],
          options,
        );
        if (parsed.valid) return { ...candidate, text: JSON.stringify(parsed.envelope) };
        if (attempt >= Math.max(0, Number(groupRepairAttempts) || 0)) {
          const error = new Error(`Telegram group response contract invalid: ${parsed.reason}`);
          error.code = 'TETHER_RESPONSE_CONTRACT_INVALID';
          // The provider returned a complete, definitely invalid payload. This
          // is safe to reject and regenerate; unlike a network timeout it is
          // not an ambiguous inference.
          error.rejectedOutput = String(candidate.text || '');
          error.rejectedProviderId = candidate.providerId || null;
          throw error;
        }
        candidate = await respond({
          messages: [
            ...messages,
            { role: 'assistant', content: String(candidate.text || '').slice(0, 16_000) },
            {
              role: 'user',
              content: 'Repair the immediately preceding answer. Return only a valid JSON object that follows the Telegram group response contract.',
            },
          ],
          purpose: 'group-response-repair',
          sourceMessage,
        });
      }
      return candidate;
    },
    historyAssistantText(text, sourceMessage) {
      const metadata = sourceMessage?.metadata || {};
      if (!metadata.groupBatch) return String(text || '');
      return renderTelegramGroupReplyHistory(
        text,
        metadata.groupReplyTargetIds || [],
        {
          maxReplies: metadata.groupMaxReplies || groupMaxReplies,
          allowedReactions: metadata.groupAllowedReactions || groupAllowedReactions,
        },
      );
    },
    async send(message) {
      const source = message?.sourceMessage?.metadata || {};
      if (!source.chatId) throw new Error('Telegram delivery lacks source chatId');
      const progress = { sent: 0 };
      const results = [];
      if (source.groupBatch) {
        const parsed = parseTelegramGroupReplyEnvelope(
          message.text,
          source.groupReplyTargetIds || [],
          {
            maxReplies: source.groupMaxReplies || groupMaxReplies,
            allowedReactions: source.groupAllowedReactions || groupAllowedReactions,
          },
        );
        if (!parsed.valid) throw new Error(`Committed group reply is invalid: ${parsed.reason}`);
        for (const reply of parsed.envelope.replies) {
          results.push(...await sendText(source.chatId, reply.text, reply.replyToMessageId, progress));
        }
        if (parsed.envelope.react) {
          const target = (source.groupReplyTargetIds || []).at(-1);
          if (target) {
            try {
              results.push(await api.call('setMessageReaction', {
                chat_id: source.chatId,
                message_id: target,
                reaction: [{ type: 'emoji', emoji: parsed.envelope.react }],
              }));
              progress.sent += 1;
            } catch (error) {
              if (progress.sent > 0) {
                const ambiguous = error instanceof Error
                  ? error
                  : new Error(String(error || 'Telegram reaction delivery failed'));
                ambiguous.deliveryAmbiguous = true;
                ambiguous.manualRetryOnly = true;
                ambiguous.partialDeliveryCount = progress.sent;
                throw ambiguous;
              }
              throw error;
            }
          }
        }
        return results;
      }
      results.push(...await sendText(
        source.chatId,
        String(message.text || ''),
        source.telegramMessageId || null,
        progress,
      ));
      return results;
    },
    async ingestPreparedMessage(message) {
      if (!handler) throw new Error('Telegram channel is not attached');
      const stopTyping = message?.respond === false
        ? () => {}
        : startTypingHeartbeat(message?.metadata?.chatId);
      try {
        return await handler(message);
      } finally {
        stopTyping();
      }
    },
    async ingestUpdate(update) {
      if (!handler) throw new Error('Telegram channel is not attached');
      if (await channel.handleControlUpdate(update)) return { control: true };
      const prepared = await channel.prepareUpdate(update);
      if (!prepared) return { ignored: true };
      const stopTyping = prepared.respond === false
        ? () => {}
        : startTypingHeartbeat(prepared.metadata?.chatId);
      try {
        return await handler(prepared);
      } finally {
        stopTyping();
      }
    },
    start() {
      if (!handler) throw new Error('Telegram channel is not attached');
      if (running) return running;
      stopped = false;
      const watchdog = createPollWatchdog({
        maxConsecutiveFailures: Number(pollMaxConsecutiveFailures) || 100,
        maxFailureDurationMs: Number(pollFailureGiveUpMs) || 10 * 60 * 1000,
      });
      // A poll that keeps failing is visible to the watchdog above. A poll that
      // stops making progress without failing — a request that never settles,
      // or an ingress await that never resolves — is invisible to it, so the
      // stall timer runs outside the loop and reports the silent case too.
      lastPollProgressAt = Date.now();
      startStallTimer();
      running = (async () => {
        let offset = offsetStore.read();
        while (!stopped) {
          try {
            const payload = await api.call('getUpdates', {
              offset,
              timeout: Number.isFinite(Number(pollTimeoutSeconds))
                ? Math.max(0, Number(pollTimeoutSeconds))
                : 30,
              allowed_updates: ['message', 'edited_message'],
            });
            watchdog.recordSuccess();
            lastPollProgressAt = Date.now();
            for (const update of mergeTelegramAlbums(payload.result || [])) {
              if (rawUpdateHandler) await rawUpdateHandler(update);
              else await channel.ingestUpdate(update);
              // Album heads answer for their siblings: the offset must clear the
              // whole group, or a crash here would re-deliver members we already
              // folded into the head.
              offset = Math.max(offset, Number(update._albumMaxUpdateId ?? update.update_id) + 1);
              offsetStore.write(offset);
              lastPollProgressAt = Date.now();
            }
          } catch (error) {
            if (stopped) break;
            watchdog.recordFailure();
            log(`[tether] Telegram poll/ingress retry: ${error.message}`);
            if (watchdog.shouldGiveUp()) {
              const fatal = new Error(`Telegram polling gave up after repeated failures: ${error.message}`);
              fatal.cause = error;
              throw fatal;
            }
            await sleep(Math.max(100, Number(pollRetryDelayMs) || DEFAULT_POLL_RETRY_DELAY_MS));
          }
        }
      })().finally(() => { clearStallTimer(); running = null; });
      return running;
    },
    stop() { stopped = true; clearStallTimer(); },
  };
  return channel;
}

module.exports = {
  mergeTelegramAlbums,
  createFileOffsetStore,
  createOwnerNotifier,
  createTelegramApi,
  createTelegramChannel,
  createDurableUpdateHandler,
  dropTelegramBacklog,
  attachmentReferences,
  groupShouldRespond,
  isTelegramGroupUpdate,
  normalizeTelegramUpdate,
  readBoundedResponse,
  splitTelegramText,
  telegramRequestTimeoutMs,
};
