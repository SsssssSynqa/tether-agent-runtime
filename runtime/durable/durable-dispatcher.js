// SPDX-License-Identifier: Apache-2.0
'use strict';

const { applyDurableFailure } = require('./durable-error-policy.js');

function createDurableDispatcher({
  inbox,
  dispatchUpdate,
  dispatchGroupBatch,
  dispatchGroupRun = null,
  notifyDeadLetter = async () => {},
  retryIntervalMs = 1000,
  log = console.log,
} = {}) {
  if (!inbox || typeof dispatchUpdate !== 'function' || typeof dispatchGroupBatch !== 'function') {
    throw new Error('DurableDispatcher 缺少 inbox/dispatchUpdate/dispatchGroupBatch');
  }
  let retryRunning = false;
  let timer = null;
  const activeGroupBatches = new Map();
  const activeUpdates = new Map();
  const activeChats = new Set();

  async function failOne(updateId, error) {
    // 断路器、结构性等待和 provider 全局容量故障统一走 paused：保留原文与
    // attempts，低频恢复；普通的消息级错误才消费 attempts 并最终 dead-letter。
    const state = applyDurableFailure(inbox, updateId, error);
    if (state.state === 'dead-letter') {
      try { await notifyDeadLetter(state); } catch (noticeError) {
        log(`[spool] dead-letter 通知失败 update=${updateId}: ${noticeError.message}`);
      }
    }
    return state;
  }

  async function processExactGroupBatch(record, { replay = true } = {}) {
    if (!record?.batchId) throw new Error('exact group replay 缺 batchId');
    if (activeGroupBatches.has(record.batchId)) return activeGroupBatches.get(record.batchId);
    const chatId = String(record.chatId ?? `batch:${record.batchId}`);
    const firstPendingId = record.updateIds
      .map(Number)
      .filter((id) => Number.isFinite(id) && !inbox.isDone(id))
      .sort((a, b) => a - b)[0];
    if (!Number.isFinite(firstPendingId)) return;
    const firstPendingUpdate = inbox.getState(firstPendingId)?.update || {
      update_id: firstPendingId,
      message: { chat: { id: record.chatId } },
    };
    if (activeChats.has(chatId) || inbox.hasEarlierBlockedEntry(firstPendingUpdate)) {
      return { deferred: true, reason: 'same-chat-active' };
    }
    activeChats.add(chatId);
    const task = (async () => {
      const pendingIds = record.updateIds
        .map(Number)
        .filter((id) => Number.isFinite(id) && !inbox.isDone(id));
      if (!pendingIds.length) return;
      // markProcessing 也要在 try 内：批量标记中途抛错时，前面已标记的 id
      // 需要走同一个 failOne 收口进正常重试链，而不是留在 processing 态
      // 等下一次启动恢复才被发现。
      try {
        for (const id of pendingIds) inbox.markProcessing(id, replay);
        await dispatchGroupBatch(record);
        for (const id of pendingIds) inbox.markDone(id);
      } catch (error) {
        for (const id of pendingIds) await failOne(id, error);
        throw error;
      }
    })().finally(() => {
      activeGroupBatches.delete(record.batchId);
      activeChats.delete(chatId);
    });
    activeGroupBatches.set(record.batchId, task);
    return task;
  }

  async function processUpdate(update, { replay = false } = {}) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId) || inbox.isDone(updateId)) return;
    if (activeUpdates.has(updateId)) return activeUpdates.get(updateId);
    const chatId = inbox.chatIdForUpdate(update);
    if (activeChats.has(chatId) || inbox.hasEarlierBlockedEntry(update)) {
      return { deferred: true, reason: 'same-chat-active' };
    }
    activeChats.add(chatId);
    const task = (async () => {
      inbox.markProcessing(updateId, replay);
      try {
        await dispatchUpdate(update, { replay });
        inbox.markDone(updateId);
      } catch (error) {
        await failOne(updateId, error);
        throw error;
      }
    })().finally(() => {
      activeUpdates.delete(updateId);
      activeChats.delete(chatId);
    });
    activeUpdates.set(updateId, task);
    return task;
  }

  async function processEntry(entry, { replay = true } = {}) {
    const record = inbox.groupBatchForUpdate(entry.updateId);
    if (record) return processExactGroupBatch(record, { replay });
    return processUpdate(entry.update, { replay });
  }

  async function processEntryRun(entries, phase) {
    const processedBatches = new Set();
    for (let index = 0; index < entries.length;) {
      const entry = entries[index];
      const record = inbox.groupBatchForUpdate(entry.updateId);
      if (record) {
        index += 1;
        if (processedBatches.has(record.batchId)) continue;
        processedBatches.add(record.batchId);
        try { await processExactGroupBatch(record, { replay: true }); } catch (error) {
          log(`[spool] ${phase}重放失败 batch=${record.batchId}: ${error.message}`);
          return false;
        }
        continue;
      }

      const chatType = entry.update?.message?.chat?.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';
      if (isGroup && typeof dispatchGroupRun === 'function') {
        const run = [];
        while (index < entries.length) {
          const candidate = entries[index];
          const candidateType = candidate.update?.message?.chat?.type;
          if (
            inbox.groupBatchForUpdate(candidate.updateId)
            || (candidateType !== 'group' && candidateType !== 'supergroup')
          ) break;
          run.push(candidate);
          index += 1;
        }
        try {
          await dispatchGroupRun(run, { replay: true, phase });
        } catch (error) {
          log(`[spool] ${phase}重放群 pending 失败 updates=${run.map((item) => item.updateId).join(',')}: ${error.message}`);
          return false;
        }
        continue;
      }

      index += 1;
      try { await processEntry(entry, { replay: true }); } catch (error) {
        log(`[spool] ${phase}重放失败 update=${entry.updateId}: ${error.message}`);
        return false;
      }
    }
    return true;
  }

  async function replayAll() {
    const entriesByChat = new Map();
    for (const entry of inbox.pendingEntries()) {
      const record = inbox.groupBatchForUpdate(entry.updateId);
      const chatId = record ? String(record.chatId) : inbox.chatIdForEntry(entry);
      if (!entriesByChat.has(chatId)) entriesByChat.set(chatId, []);
      entriesByChat.get(chatId).push(entry);
    }
    await Promise.all([...entriesByChat.values()].map((entries) => processEntryRun(entries, '启动')));
  }

  async function retryDue() {
    if (retryRunning) return;
    retryRunning = true;
    try {
      // 每个 chat 只取从队首开始、已经到期且未 inflight 的连续 run；不同 chat 并发。
      // 群 run 会整体重新灌回 batcher，私聊仍在 processEntryRun 内逐条严格串行。
      await Promise.all(inbox.dueEntryRunsInOrder().map((entries) => processEntryRun(entries, '运行时')));
    } finally { retryRunning = false; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => retryDue().catch((error) => log(`[spool] retry loop 崩溃：${error.message}`)), retryIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { processUpdate, processExactGroupBatch, replayAll, retryDue, start, stop };
}

module.exports = { createDurableDispatcher };
