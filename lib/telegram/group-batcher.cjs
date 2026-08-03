// SPDX-License-Identifier: Apache-2.0 AND MIT
'use strict';

// Portions derived from Codex-tg-Bridge/src/group-batcher.mjs (MIT).
// Copyright (c) 2026 Codex-tg-Bridge contributors. See THIRD_PARTY_NOTICES.md.

const DEFAULT_TIMING = Object.freeze({
  singleMessageMs: 1000,
  sameSenderIdleMs: 1800,
  sameSenderMaxMs: 3000,
  multiSenderIdleMs: 2200,
  multiSenderMaxMs: 5000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isStopInstruction(text) {
  const normalized = String(text || '')
    .replace(/@[A-Za-z0-9_]+/g, '')
    .replace(/[，,。.!！?？~～\s]/g, '');
  return /^(?:大家)?(?:先)?(?:别|不要)(?:再)?回(?:复)?(?:了)?$/.test(normalized)
    || /^(?:大家)?(?:先)?(?:安静|停|暂停|停止回复|别说话|不要说话)(?:一下|一会儿|了)?$/.test(normalized);
}

function isNonConversationalBotMessage(text) {
  const value = String(text || '');
  return value.startsWith('[bridge-status]')
    || /我这次没有顺利接上，错误已经留在本机日志里/.test(value)
    || /You've hit your usage limit|try again at .*?(?:AM|PM)|rate limit/i.test(value);
}

function parseBatchReplies(raw, validMessageIds = []) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const validIds = new Set(validMessageIds.map(Number));
  const unwrapped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  const candidate = firstBrace >= 0 && lastBrace > firstBrace
    ? unwrapped.slice(firstBrace, lastBrace + 1)
    : unwrapped;

  try {
    const parsed = JSON.parse(candidate);
    const items = Array.isArray(parsed) ? parsed : parsed.replies;
    if (!Array.isArray(items)) throw new Error('replies is not an array');

    const replies = items
      .map((item) => {
        if (typeof item === 'string') return { text: item.trim(), replyToMessageId: null };
        const replyText = String(item?.text || '').trim();
        const requestedId = Number(item?.replyToMessageId);
        return {
          text: replyText,
          replyToMessageId: validIds.has(requestedId) ? requestedId : null,
        };
      })
      .filter((item) => item.text);
    // A silence reaction makes deliberate no-reply distinguishable from a missed update.
    const react = typeof parsed.react === 'string' ? parsed.react.trim() : null;
    if (react) replies._react = react;
    return replies;
  } catch {
    // The group protocol is a security boundary. Never publish malformed/raw
    // model output into a public group.
    return [];
  }
}

class PriorityTaskQueue {
  constructor({ maxSize = 100 } = {}) {
    this.running = false;
    this.sequence = 0;
    this.tasks = [];
    this.maxSize = maxSize;
  }

  run(task, priority = 0) {
    return new Promise((resolve, reject) => {
      if (this.tasks.length >= this.maxSize) {
        reject(new Error(`task queue full (${this.maxSize})`));
        return;
      }
      this.tasks.push({ task, priority, sequence: this.sequence++, resolve, reject });
      this.tasks.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;

    while (this.tasks.length) {
      const next = this.tasks.shift();
      try {
        next.resolve(await next.task());
      } catch (error) {
        next.reject(error);
      }
    }

    this.running = false;
  }
}

class GroupConversationBatcher {
  constructor({
    generateReplies,
    sendReply,
    notifyFailure,
    onBatchComplete = null,
    onReact = null,
    log = console.log,
    timing = {},
    getTiming = null,
    isImportantMessage = null,
    unimportantSupersedeThreshold = 5,
    maxPendingMessages = 100,
    contextDemotionMs = 0,
  }) {
    this.generateReplies = generateReplies;
    this.sendReply = sendReply;
    this.notifyFailure = notifyFailure;
    this.onBatchComplete = typeof onBatchComplete === 'function' ? onBatchComplete : null;
    this.onReact = typeof onReact === 'function' ? onReact : null;
    this.log = log;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.getTiming = typeof getTiming === 'function' ? getTiming : null;
    // 草稿防抖：只有"重要"消息才作废进行中的草稿。默认人类消息重要、bot 消息不重要。
    this.isImportantMessage = typeof isImportantMessage === 'function'
      ? isImportantMessage
      : (message) => !message.senderIsBot;
    // 不重要消息攒到这个数量也视为语境大变，触发重写（0 或负数 = 关闭该兜底）。
    this.unimportantSupersedeThreshold = unimportantSupersedeThreshold;
    this.maxPendingMessages = Math.max(1, Number(maxPendingMessages) || 100);
    // Optional age degradation prevents an adapter from serially replying to stale traffic.
    // 早于此毫秒数的消息标 contextOnly=true——调用方应把它们渲染成"前情背景、
    // 无需回复"。慢模型生成期间积压的旧消息由此免除回复义务，回复只对最新语境。
    // 0 = 关闭（默认，三处共用方保持旧行为）。至少保留最新一条为回复目标。
    this.contextDemotionMs = Math.max(0, Number(contextDemotionMs) || 0);
    this.chats = new Map();
  }

  getState(chatId) {
    const key = String(chatId);
    if (!this.chats.has(key)) {
      this.chats.set(key, {
        pending: [],
        firstPendingAt: 0,
        timer: null,
        processing: false,
        revision: 0,
        importantRevision: 0,
        muted: false,
        botPausedUntil: 0,
        lastFailureNoticeAt: 0,
      });
    }
    return this.chats.get(key);
  }

  timingFor(chatId, state) {
    const override = this.getTiming ? this.getTiming(String(chatId), state) : null;
    return { ...this.timing, ...(override || {}) };
  }

  enqueue(message) {
    const chatId = String(message.chatId);
    const state = this.getState(chatId);
    let settleResolve;
    let settleReject;
    const completion = new Promise((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    completion.catch(() => {});
    const delivery = { resolve: settleResolve, reject: settleReject, settled: false };
    const finish = (value) => {
      if (delivery.settled) return;
      delivery.settled = true;
      delivery.resolve(value);
    };

    if (message.senderIsBot && isNonConversationalBotMessage(message.text)) {
      this.log(`忽略 bridge 状态消息 chat=${chatId} from=${message.senderId}`);
      finish({ suppressed: true, reason: 'bridge-status' });
      return { accepted: false, reason: 'bridge-status', completion };
    }

    if (!message.senderIsBot && isStopInstruction(message.text)) {
      state.muted = true;
      for (const pending of state.pending) this.settleMessage(pending, { suppressed: true, reason: 'stop-instruction' });
      state.pending = [];
      state.firstPendingAt = 0;
      state.revision += 1;
      state.importantRevision += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      this.log(`群聊进入静默 chat=${chatId} revision=${state.revision}`);
      finish({ suppressed: true, reason: 'stop-instruction' });
      return { accepted: true, stopped: true, completion };
    }

    if (state.muted) {
      if (message.senderIsBot) {
        this.log(`静默中忽略 bot 消息 chat=${chatId} from=${message.senderId}`);
        finish({ suppressed: true, reason: 'muted' });
        return { accepted: false, reason: 'muted', completion };
      }
      state.muted = false;
      this.log(`Owner message cleared silence chat=${chatId}`);
    }

    if (message.senderIsBot && Date.now() < state.botPausedUntil) {
      this.log(`故障熔断中忽略 bot 消息 chat=${chatId} from=${message.senderId}`);
      finish({ suppressed: true, reason: 'failure-circuit' });
      return { accepted: false, reason: 'failure-circuit', completion };
    }

    if (state.pending.length >= this.maxPendingMessages) {
      const error = new Error(`group queue full chat=${chatId} limit=${this.maxPendingMessages}`);
      delivery.settled = true;
      delivery.reject(error);
      return { accepted: false, reason: 'queue-full', completion };
    }

    const receivedAt = Number(message.receivedAt || Date.now());
    if (!state.pending.length) state.firstPendingAt = receivedAt;
    state.pending.push({ ...message, chatId, receivedAt, _delivery: delivery });
    state.revision += 1;
    if (this.isImportantMessage(message)) state.importantRevision += 1;

    if (!state.processing) this.schedule(chatId, state);
    return { accepted: true, stopped: false, completion };
  }

  settleMessage(message, value, error = null) {
    const delivery = message?._delivery;
    if (!delivery || delivery.settled) return;
    delivery.settled = true;
    if (error) delivery.reject(error);
    else delivery.resolve(value);
  }

  settleBatch(batch, value, error = null) {
    for (const message of batch) this.settleMessage(message, value, error);
  }

  schedule(chatId, state) {
    if (state.timer) clearTimeout(state.timer);
    if (!state.pending.length) return;

    const now = Date.now();
    const timing = this.timingFor(chatId, state);
    const senderCount = new Set(state.pending.map((message) => message.senderId)).size;
    let deadline;

    if (state.pending.length === 1) {
      deadline = state.firstPendingAt + timing.singleMessageMs;
    } else if (senderCount === 1) {
      deadline = Math.min(
        state.firstPendingAt + timing.sameSenderMaxMs,
        now + timing.sameSenderIdleMs,
      );
    } else {
      deadline = Math.min(
        state.firstPendingAt + timing.multiSenderMaxMs,
        now + timing.multiSenderIdleMs,
      );
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      this.flush(chatId).catch((error) => this.log(`群聊批处理崩溃 chat=${chatId}: ${error.message}`));
    }, Math.max(0, deadline - now));
  }

  async flush(chatId) {
    const state = this.getState(chatId);
    if (state.processing || !state.pending.length || state.muted) return;

    state.processing = true;
    let carry = [];
    let superseding = false;
    let activeBatch = [];

    try {
      while (!state.muted && (carry.length || state.pending.length)) {
        const batch = [...carry, ...state.pending];
        activeBatch = batch;
        carry = [];
        state.pending = [];
        state.firstPendingAt = 0;
        // 超龄降级：每轮组批时统一重算（不是只加不减——supersede 开启时同一
        // 消息对象会随 carry 进入多轮，标记必须按当轮时间重新判定）。全部超龄
        // 时保底最新一条仍是回复目标，否则回复目标区为空、下游协议没有可引用
        // 的 messageId。
        if (this.contextDemotionMs > 0 && batch.length) {
          const cutoff = Date.now() - this.contextDemotionMs;
          for (const message of batch) message.contextOnly = message.receivedAt < cutoff;
          if (batch.every((message) => message.contextOnly)) {
            batch[batch.length - 1].contextOnly = false;
          }
          const demoted = batch.filter((message) => message.contextOnly).length;
          if (demoted) this.log(`超龄降级 chat=${chatId}：${demoted}/${batch.length} 条转前情背景（免答）`);
        }
        const revisionAtGeneration = state.revision;
        const importantAtGeneration = state.importantRevision;
        const startedAt = Date.now();

        let replies;
        try {
          replies = await this.generateReplies(batch, { superseding });
        } catch (error) {
          state.botPausedUntil = Date.now() + 5 * 60 * 1000;
          const containsHuman = batch.some((message) => !message.senderIsBot);
          if (
            containsHuman
            && this.notifyFailure
            && Date.now() - state.lastFailureNoticeAt > 5 * 60 * 1000
          ) {
            state.lastFailureNoticeAt = Date.now();
            try {
              await this.notifyFailure(chatId, error, batch);
            } catch (noticeError) {
              this.log(`故障私聊通知失败 chat=${chatId}: ${noticeError.message}`);
            }
          }
          this.log(`群聊生成失败 chat=${chatId}: ${error.message}`);
          this.settleBatch(batch, null, error);
          activeBatch = [];
          superseding = false;
          continue;
        }

        if (state.muted) {
          this.log(`静默指令取消草稿 chat=${chatId}`);
          this.settleBatch(batch, { suppressed: true, reason: 'muted-during-generation' });
          activeBatch = [];
          break;
        }

        // 草稿防抖：普通 bot 刷屏不再作废草稿；只有重要消息（人类/点名）或
        // 不重要消息攒到阈值（语境大变）才推翻重写。
        const unimportantDrift = (state.revision - revisionAtGeneration)
          - (state.importantRevision - importantAtGeneration);
        const supersededByImportant = state.importantRevision !== importantAtGeneration;
        const supersededByDrift = this.unimportantSupersedeThreshold > 0
          && unimportantDrift >= this.unimportantSupersedeThreshold;

        if (supersededByImportant || supersededByDrift) {
          carry = [...batch, ...state.pending];
          state.pending = [];
          state.firstPendingAt = 0;
          superseding = true;
          this.log(
            `新语境取消旧草稿 chat=${chatId} revision=${revisionAtGeneration}->${state.revision}`
            + ` 原因=${supersededByImportant ? '重要消息' : `低重要漂移x${unimportantDrift}`}`,
          );
          continue;
        }

        const shouldSend = () => !state.muted && state.importantRevision === importantAtGeneration;
        let fullySent = true;
        // 沉默+react（2026-07-26）：replies 为空但带 _react 时，给最后一条消息贴表情
        if (!replies.length && replies._react && shouldSend() && this.onReact) {
          const lastMsg = batch[batch.length - 1];
          if (lastMsg?.messageId) {
            try { await this.onReact(chatId, lastMsg.messageId, replies._react); }
            catch (e) { this.log(`react 失败 chat=${chatId}: ${e.message}`); }
          }
        }
        for (const [replyIndex, reply] of replies.entries()) {
          if (!shouldSend()) break;
          const sent = await this.sendReply(chatId, reply, batch, shouldSend, { replyIndex });
          if (sent === false) {
            if (shouldSend()) {
              throw new Error(`sendReply returned false without a superseding message chat=${chatId}`);
            }
            fullySent = false;
            break;
          }
        }

        if (!fullySent || !shouldSend()) {
          carry = [...batch, ...state.pending];
          state.pending = [];
          state.firstPendingAt = 0;
          superseding = true;
          this.log(`发送阶段语境变化，重排批次 chat=${chatId}`);
          continue;
        }

        if (this.onBatchComplete) await this.onBatchComplete(chatId, batch, replies);
        this.settleBatch(batch, { sent: true, replyCount: replies.length });
        activeBatch = [];

        this.log(
          `群聊批次完成 chat=${chatId} messages=${batch.length} replies=${replies.length} elapsed_ms=${Date.now() - startedAt}`,
        );
        superseding = false;
      }
    } catch (error) {
      this.settleBatch(activeBatch, null, error);
      throw error;
    } finally {
      state.processing = false;
      if (state.pending.length && !state.muted) this.schedule(chatId, state);
    }
  }

  async waitForIdle(chatId, timeoutMs = 10000) {
    const startedAt = Date.now();
    for (;;) {
      const state = this.getState(chatId);
      if (!state.processing && !state.pending.length && !state.timer) return;
      if (Date.now() - startedAt > timeoutMs) throw new Error('group batcher idle timeout');
      await sleep(20);
    }
  }
}

module.exports = {
  DEFAULT_TIMING,
  GroupConversationBatcher,
  PriorityTaskQueue,
  isNonConversationalBotMessage,
  isStopInstruction,
  parseBatchReplies,
};
