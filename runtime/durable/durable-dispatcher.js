// SPDX-License-Identifier: Apache-2.0
'use strict';

const { applyDurableFailure } = require('./durable-error-policy.js');

function createDurableDispatcher({
  inbox,
  dispatchUpdate,
  dispatchGroupBatch,
  dispatchGroupRun = null,
  albumPlanner = null,
  isRecoveryUpdate = () => false,
  notifyDeadLetter = async () => {},
  notifyDeliveryHeld = async () => {},
  retryIntervalMs = 1000,
  log = console.log,
} = {}) {
  if (!inbox || typeof dispatchUpdate !== 'function' || typeof dispatchGroupBatch !== 'function') {
    throw new Error('DurableDispatcher 缺少 inbox/dispatchUpdate/dispatchGroupBatch');
  }
  const retryingChats = new Set();
  let timer = null;
  let draining = false;
  const work = require('./maintenance-drain').createTaskDrain();
  const activeGroupBatches = new Map();
  const activeUpdates = new Map();
  const activeChats = new Set();

  async function failOne(updateId, error) {
    // 断路器、结构性等待和 provider 全局容量故障统一走 paused：保留原文与
    // attempts，低频恢复；普通的消息级错误才消费 attempts 并最终 dead-letter。
    const previous = inbox.getState(updateId);
    const state = applyDurableFailure(inbox, updateId, error);
    if (state.disposition === 'delivery-unknown-held-no-replay'
      && previous?.disposition !== state.disposition) {
      try { await notifyDeliveryHeld(state); } catch (noticeError) {
        log(`[spool] 扣稿通知失败 update=${updateId}: ${noticeError.message}`);
      }
    }
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

  async function processPrivateAlbum(record, { replay = false } = {}) {
    const primaryId = Number(record.primaryUpdateId);
    if (activeUpdates.has(primaryId)) return activeUpdates.get(primaryId);
    const pendingIds = record.updateIds.map(Number).filter((id) => !inbox.isDone(id));
    if (!pendingIds.length) return;
    const firstPending = record.updates.find((update) => Number(update.update_id) === pendingIds[0]);
    const chatId = String(record.chatId);
    if (activeChats.has(chatId) || inbox.hasEarlierBlockedEntry(firstPending)) {
      return { deferred: true, reason: 'same-chat-active' };
    }
    activeChats.add(chatId);
    const task = (async () => {
      try {
        for (const id of pendingIds) inbox.markProcessing(id, replay);
        await dispatchUpdate(record.updates[0], {
          replay,
          albumMessages: record.updates.slice(1).map((update) => update.message),
          relatedUpdateIds: record.updateIds,
          causalIds: record.causalIds,
          albumBatchId: record.batchId,
        });
        inbox.markAlbumDone(record);
      } catch (error) {
        for (const id of pendingIds) await failOne(id, error);
        throw error;
      }
    })().finally(() => {
      activeUpdates.delete(primaryId);
      activeChats.delete(chatId);
    });
    activeUpdates.set(primaryId, task);
    return task;
  }

  async function processUpdate(update, { replay = false } = {}) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId)) return;
    const frozenAlbum = inbox.albumBatchForUpdate?.(updateId);
    if (frozenAlbum) return processPrivateAlbum(frozenAlbum, { replay });
    if (inbox.isDone(updateId)) return;
    if (activeUpdates.has(updateId)) return activeUpdates.get(updateId);
    const chatId = inbox.chatIdForUpdate(update);
    const recovery = isRecoveryUpdate(update);
    if (activeChats.has(chatId) || (!recovery && inbox.hasEarlierBlockedEntry(update))) {
      return { deferred: true, reason: 'same-chat-active' };
    }
    if (!recovery && albumPlanner && update?.message?.chat?.type === 'private') {
      if (inbox.hasLegacyCompletedAlbumSibling(update)) {
        const error = new Error('旧相册存在已完成成员但无 frozen membership；结果归属未知，保留待人工核对，不自动再次入模');
        error.code = 'SYNER_ALBUM_IDENTITY_AMBIGUOUS';
        error.manualRetryOnly = true;
        await failOne(updateId, error);
        throw error;
      }
      const plan = albumPlanner.plan(update, inbox.pendingUpdates());
      if (plan.action === 'wait') return { deferred: true, reason: 'album-window' };
      if (plan.action === 'merge') {
        if (Number(plan.updates[0]?.update_id) !== updateId) return { deferred: true, reason: 'album-follower' };
        const record = inbox.markAlbumBatch(plan.updates);
        const result = await processPrivateAlbum(record, { replay });
        if (!result?.deferred) albumPlanner.forget(plan.batchKey);
        return result;
      }
    }
    activeChats.add(chatId);
    const task = (async () => {
      const memberIds = [updateId];
      // markProcessing 放 try 内：批量标记中途抛错时，已标记的 id 走同一个
      // failOne 收口进重试链（与 processExactGroupBatch 同一姿势）。
      try {
        for (const id of memberIds) inbox.markProcessing(id, replay);
        await dispatchUpdate(update, {
          replay,
          relatedUpdateIds: [updateId],
        });
        for (const id of memberIds) inbox.markDone(id);
      } catch (error) {
        for (const id of memberIds) await failOne(id, error);
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
    for (let index = 0; index < entries.length && !draining;) {
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
    await processRecoveryUpdates();
    const entriesByChat = new Map();
    for (const entry of inbox.pendingEntries()) {
      const record = inbox.groupBatchForUpdate(entry.updateId);
      const chatId = record ? String(record.chatId) : inbox.chatIdForEntry(entry);
      if (!entriesByChat.has(chatId)) entriesByChat.set(chatId, []);
      entriesByChat.get(chatId).push(entry);
    }
    await Promise.all([...entriesByChat.values()].map((entries) => processEntryRun(entries, '启动')));
  }

  // 2026-10-03 审计 S25：以前整个 retry loop 全局单飞，并 await 全部 run 跑完（群 run 要等
  // 整批发完，受限速群每条排 10 秒）。私聊被交给 retry loop 时，得等别的群批全部发完才会
  // 被看一眼，engine 侧私聊优先的设计在这里失效。改成按 chat 单飞：同一个 chat 仍严格串行，
  // 不同 chat 互不等待；正在重试的 chat 下一拍直接跳过。
  async function retryDue() {
    if (draining) return;
    await processRecoveryUpdates();
    const started = [];
    // 每个 chat 只取从队首开始、已经到期且未 inflight 的连续 run；不同 chat 并发。
    // 群 run 会整体重新灌回 batcher，私聊仍在 processEntryRun 内逐条严格串行。
    for (const entries of inbox.dueEntryRunsInOrder()) {
      if (draining) break;
      if (!entries?.length) continue;
      const record = inbox.groupBatchForUpdate(entries[0].updateId);
      const chatKey = String(record ? record.chatId : inbox.chatIdForEntry(entries[0]));
      if (retryingChats.has(chatKey)) continue;
      retryingChats.add(chatKey);
      started.push(processEntryRun(entries, '运行时').finally(() => retryingChats.delete(chatKey)));
    }
    await Promise.all(started);
  }

  async function processRecoveryUpdates() {
    // Select controls independently of the chat's blocked head, including after
    // restart. Live in-flight work still owns the chat; ordinary ordering stays.
    for (const entry of inbox.pendingEntries({ dueOnly: true })) {
      if (draining) break;
      if (!isRecoveryUpdate(entry.update)) continue;
      try { await processUpdate(entry.update, { replay: true }); }
      catch (error) { log(`[spool] 恢复命令失败 update=${entry.updateId}: ${error.message}`); }
    }
  }

  function start() {
    if (timer || draining) return;
    timer = setInterval(() => work.track(retryDue()).catch((error) => log(`[spool] retry loop 崩溃：${error.message}`)), retryIntervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    processUpdate: (...args) => work.track(processUpdate(...args)),
    processExactGroupBatch: (...args) => work.track(processExactGroupBatch(...args)),
    replayAll: (...args) => work.track(replayAll(...args)),
    retryDue: (...args) => work.track(retryDue(...args)),
    start, stop,
    beginDrain() { draining = true; stop(); },
    drain: () => work.drain(),
  };
}

module.exports = { createDurableDispatcher };
