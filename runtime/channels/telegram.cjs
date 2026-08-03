// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendWithMissingReplyFallback } = require('../../telegram-reply-fallback.js');
const { sendWithGroupRateLimit } = require('../../lib/telegram/group-rate-limit.cjs');
const { isLoopbackHostname } = require('../config-loader.cjs');

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
    const response = await fetchImpl(`${normalizedBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
    return payload;
  };
  return {
    call,
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
      senderId,
      owner,
      isGroup,
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

function createTelegramChannel({
  id = 'telegram',
  api,
  ownerIds = [],
  allowedGroupIds = [],
  noReplyGroupIds = [],
  rateLimitedGroupIds = [],
  rateLimitStateDir = null,
  offsetStore,
  pollTimeoutSeconds = 30,
  log = console.log,
} = {}) {
  if (!api?.call || !api?.sendMessage) throw new Error('Telegram channel requires an API client');
  if (!offsetStore?.read || !offsetStore?.write) throw new Error('Telegram channel requires an offset store');
  let handler = null;
  let stopped = false;
  let running = null;

  const channel = {
    id: String(id),
    onMessage(next) { handler = next; },
    async send(message) {
      const source = message?.sourceMessage?.metadata || {};
      if (!source.chatId) throw new Error('Telegram delivery lacks source chatId');
      const text = String(message.text || '');
      if (Array.from(text).length > 4096) {
        throw new Error('Telegram adapter refuses non-atomic output above 4096 characters');
      }
      const params = { chat_id: source.chatId, text };
      if (source.telegramMessageId) {
        params.reply_parameters = {
          message_id: source.telegramMessageId,
          allow_sending_without_reply: true,
        };
      }
      return sendWithGroupRateLimit(
        source.chatId,
        () => api.sendMessage(params, { noReplyGroupIds }),
        {
          rateLimitedGroupIds,
          ...(rateLimitStateDir ? { stateDir: rateLimitStateDir } : {}),
          log,
        },
      );
    },
    async ingestUpdate(update) {
      if (!handler) throw new Error('Telegram channel is not attached');
      const normalized = normalizeTelegramUpdate(update, {
        ownerIds,
        allowedGroupIds,
        privateOwnerOnly: true,
      });
      if (!normalized) return { ignored: true };
      return handler(normalized);
    },
    start() {
      if (!handler) throw new Error('Telegram channel is not attached');
      if (running) return running;
      stopped = false;
      running = (async () => {
        let offset = offsetStore.read();
        while (!stopped) {
          const payload = await api.call('getUpdates', {
            offset,
            timeout: Math.max(0, Number(pollTimeoutSeconds) || 30),
            allowed_updates: ['message', 'edited_message'],
          });
          for (const update of payload.result || []) {
            await channel.ingestUpdate(update);
            offset = Number(update.update_id) + 1;
            offsetStore.write(offset);
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
  normalizeTelegramUpdate,
};
