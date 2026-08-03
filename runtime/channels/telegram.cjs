// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sendWithMissingReplyFallback } = require('../../telegram-reply-fallback.js');
const { sendWithGroupRateLimit } = require('../../lib/telegram/group-rate-limit.cjs');
const { isLoopbackHostname } = require('../config-loader.cjs');

const DEFAULT_POLL_RETRY_DELAY_MS = 1000;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 40_000;
const LONG_POLL_GRACE_MS = 15_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function markAmbiguousDelivery(error, method) {
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Telegram request failed'));
  if (method !== 'getUpdates') {
    wrapped.deliveryAmbiguous = true;
    wrapped.manualRetryOnly = true;
  }
  return wrapped;
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
      senderDisplayName: [message.from?.first_name, message.from?.last_name]
        .filter(Boolean).join(' ') || message.from?.username || senderId,
      senderIsBot: message.from?.is_bot === true,
      owner,
      isGroup,
      sentAt: Number.isFinite(Number(message.date))
        ? new Date(Number(message.date) * 1000).toISOString()
        : null,
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

function createDurableUpdateHandler({ channel, inbox, dispatcher, log = console.error } = {}) {
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
    dispatcher.processUpdate(update).catch((error) => {
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
  noReplyGroupIds = [],
  rateLimitedGroupIds = [],
  rateLimitStateDir = null,
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
      return normalizeTelegramUpdate(update, {
        ownerIds,
        allowedGroupIds,
        privateOwnerOnly: true,
      });
    },
    async send(message) {
      const source = message?.sourceMessage?.metadata || {};
      if (!source.chatId) throw new Error('Telegram delivery lacks source chatId');
      const text = String(message.text || '');
      const chunks = splitTelegramText(text);
      const results = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const params = { chat_id: source.chatId, text: chunks[index] };
        if (index === 0 && source.telegramMessageId) {
          params.reply_parameters = {
            message_id: source.telegramMessageId,
            allow_sending_without_reply: true,
          };
        }
        try {
          results.push(await sendWithGroupRateLimit(
            source.chatId,
            () => api.sendMessage(params, { noReplyGroupIds }),
            {
              rateLimitedGroupIds,
              ...(rateLimitStateDir ? { stateDir: rateLimitStateDir } : {}),
              log,
            },
          ));
        } catch (error) {
          if (index > 0) {
            const ambiguous = error instanceof Error
              ? error
              : new Error(String(error || 'Telegram partial delivery failed'));
            ambiguous.deliveryAmbiguous = true;
            ambiguous.manualRetryOnly = true;
            ambiguous.partialDeliveryCount = index;
            throw ambiguous;
          }
          throw error;
        }
      }
      return results;
    },
    async ingestUpdate(update) {
      if (!handler) throw new Error('Telegram channel is not attached');
      const normalized = channel.normalizeUpdate(update);
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
  normalizeTelegramUpdate,
  splitTelegramText,
  telegramRequestTimeoutMs,
};
