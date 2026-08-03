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
} = require('../../lib/telegram/image-utils.cjs');
const {
  buildTelegramGroupBatch,
  parseTelegramGroupReplyEnvelope,
  renderTelegramGroupReplyHistory,
} = require('./telegram-group.cjs');
const { isLoopbackHostname } = require('../config-loader.cjs');

const DEFAULT_POLL_RETRY_DELAY_MS = 1000;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 40_000;
const LONG_POLL_GRACE_MS = 15_000;

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
  const call = async (method, params = {}) => {
    let response;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      telegramRequestTimeoutMs(method, params),
    );
    timer.unref?.();
    try {
      response = await fetchImpl(`${normalizedBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (error) {
      throw markAmbiguousDelivery(error, method);
    } finally {
      clearTimeout(timer);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw markAmbiguousDelivery(error, method);
    }
    if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
    return payload;
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

function createDurableUpdateHandler({
  channel,
  inbox,
  dispatcher,
  groupCoordinator = null,
  log = console.error,
} = {}) {
  if (!channel?.normalizeUpdate) throw new Error('Durable Telegram ingress requires a channel');
  if (!inbox?.receive || !inbox?.getState) throw new Error('Durable Telegram ingress requires an inbox');
  if (typeof dispatcher?.processUpdate !== 'function') {
    throw new Error('Durable Telegram ingress requires a dispatcher');
  }
  return async (update) => {
    if (!channel.normalizeUpdate(update)) return { ignored: true };
    const updateId = Number(update.update_id);
    const prior = inbox.getState(updateId);
    const accepted = inbox.receive(update);
    if (!accepted) return { duplicate: true };
    if (prior && prior.state !== 'received') {
      return { durable: true, deferredToRetry: true };
    }
    const task = groupCoordinator && channel.isGroupUpdate(update)
      ? groupCoordinator.ingestUpdate(update)
      : dispatcher.processUpdate(update);
    task.catch((error) => {
      log(`[tether] durable Telegram dispatch failed update=${updateId}: ${error.message}`);
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
  pollTimeoutSeconds = 30,
  pollRetryDelayMs = DEFAULT_POLL_RETRY_DELAY_MS,
  log = console.log,
} = {}) {
  if (!api?.call || !api?.sendMessage) throw new Error('Telegram channel requires an API client');
  if (!offsetStore?.read || !offsetStore?.write) throw new Error('Telegram channel requires an offset store');
  let handler = null;
  let rawUpdateHandler = null;
  let stopped = false;
  let running = null;
  let botIdentity = { id: null, username: null };
  const groupPolicies = allowedGroups && typeof allowedGroups === 'object'
    ? new Map(Object.entries(allowedGroups).map(([chatId, policy]) => [
        String(chatId),
        policy && typeof policy === 'object' ? { ...policy } : {},
      ]))
    : new Map(allowedGroupIds.map((chatId) => [String(chatId), {}]));
  const effectiveAllowedGroupIds = [...groupPolicies.keys()];
  const attachmentRoot = path.resolve(attachmentDirectory || path.join(process.cwd(), '.tether-attachments'));
  const imageCacheDir = path.join(attachmentRoot, 'images');
  const fileCacheDir = path.join(attachmentRoot, 'files');

  async function sendText(chatId, text, replyToMessageId, progress) {
    const chunks = splitTelegramText(text);
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
    normalizeUpdate(update) {
      const normalized = normalizeTelegramUpdate(update, {
        ownerIds,
        allowedGroupIds: effectiveAllowedGroupIds,
        privateOwnerOnly: true,
      });
      if (
        normalized?.metadata?.isGroup
        && groupPolicies.get(String(normalized.metadata.chatId))?.enabled === false
      ) return null;
      return normalized;
    },
    isGroupUpdate: isTelegramGroupUpdate,
    async initialize() {
      const payload = await api.call('getMe', {});
      const identity = payload?.result || payload;
      botIdentity = {
        id: identity?.id == null ? null : String(identity.id),
        username: identity?.username == null ? null : String(identity.username),
      };
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
        { includeLocalPaths: false },
      );
      if (!text && !images.length && !files.length) return null;
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
      };
      return {
        ...normalized,
        text,
        respond: groupShouldRespond({ ...normalized, text }, policy, botIdentity),
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
      const built = buildTelegramGroupBatch(messages);
      const sourceParts = messages.flatMap((message) => message.sourceParts || []);
      const last = messages.at(-1);
      return {
        messageId: `telegram:group-batch:${record.batchId}`,
        text: built.historyText,
        providerText: built.providerText,
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
      return handler(message);
    },
    async ingestUpdate(update) {
      if (!handler) throw new Error('Telegram channel is not attached');
      const prepared = await channel.prepareUpdate(update);
      if (!prepared) return { ignored: true };
      return handler(prepared);
    },
    start() {
      if (!handler) throw new Error('Telegram channel is not attached');
      if (running) return running;
      stopped = false;
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
            for (const update of payload.result || []) {
              if (rawUpdateHandler) await rawUpdateHandler(update);
              else await channel.ingestUpdate(update);
              offset = Number(update.update_id) + 1;
              offsetStore.write(offset);
            }
          } catch (error) {
            if (stopped) break;
            log(`[tether] Telegram poll/ingress retry: ${error.message}`);
            await sleep(Math.max(100, Number(pollRetryDelayMs) || DEFAULT_POLL_RETRY_DELAY_MS));
          }
        }
      })().finally(() => { running = null; });
      return running;
    },
    stop() { stopped = true; },
  };
  return channel;
}

module.exports = {
  createFileOffsetStore,
  createTelegramApi,
  createTelegramChannel,
  createDurableUpdateHandler,
  attachmentReferences,
  groupShouldRespond,
  isTelegramGroupUpdate,
  normalizeTelegramUpdate,
  readBoundedResponse,
  splitTelegramText,
  telegramRequestTimeoutMs,
};
