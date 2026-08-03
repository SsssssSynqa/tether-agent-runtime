// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  fs.chmodSync(tmp, mode);
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, mode);
  // rename 的目录项也尽力落盘；部分平台不允许 fsync directory，那里安全忽略。
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) {}
}

function appendDurable(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const fd = fs.openSync(filePath, 'a', mode);
  try {
    fs.writeSync(fd, content, null, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.chmodSync(filePath, mode);
}

class DurableInbox {
  constructor({
    filePath,
    log = console.log,
    maxBytes = 20 * 1024 * 1024,
    maxAttempts = 6,
    retryBaseMs = 2000,
    retryMaxMs = 5 * 60 * 1000,
    corruptionPolicy = 'fail-closed',
  } = {}) {
    if (!filePath) throw new Error('DurableInbox 缺少 filePath');
    this.filePath = filePath;
    this.log = log;
    this.maxBytes = maxBytes;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 6);
    this.retryBaseMs = Math.max(100, Number(retryBaseMs) || 2000);
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(retryMaxMs) || 5 * 60 * 1000);
    if (!['fail-closed', 'salvage'].includes(corruptionPolicy)) {
      throw new Error(`Unknown durable inbox corruptionPolicy: ${corruptionPolicy}`);
    }
    this.corruptionPolicy = corruptionPolicy;
    this.states = new Map();
    this.updates = new Map();
    this.deliveries = new Map();
    this.groupBatches = new Map();
    this.groupBatchByUpdate = new Map();
    this.operationResults = new Map();
    this.inflight = new Set();
    this.appendsSinceCompactCheck = 0;
    this._load();
  }

  _load() {
    let text = '';
    try { text = fs.readFileSync(this.filePath, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    let malformed = 0;
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (Number.isFinite(Number(entry.updateId)) && entry.update) {
          this.updates.set(Number(entry.updateId), entry.update);
        }
        if (entry.state === 'outbound-ack' && entry.deliveryKey) {
          for (const updateId of entry.updateIds || []) {
            this.deliveries.set(`${Number(updateId)}:${entry.deliveryKey}`, entry);
          }
        } else if (entry.state === 'group-batch' && entry.batchId && Array.isArray(entry.updateIds)) {
          this.groupBatches.set(String(entry.batchId), entry);
          for (const updateId of entry.updateIds) {
            this.groupBatchByUpdate.set(Number(updateId), String(entry.batchId));
          }
        } else if (entry.state === 'operation-result' && entry.operationKey) {
          this.operationResults.set(String(entry.operationKey), entry);
        } else if (Number.isFinite(Number(entry.updateId))) {
          this.states.set(Number(entry.updateId), entry);
        }
      } catch (_) {
        malformed += 1;
        if (this.corruptionPolicy === 'fail-closed') {
          const failure = new Error(
            `Durable inbox ${path.basename(this.filePath)} is corrupt at line ${index + 1}`,
          );
          failure.code = 'DURABLE_INBOX_CORRUPT';
          failure.line = index + 1;
          throw failure;
        }
      }
    }
    if (malformed) this.log(`[spool] salvage mode ignored ${malformed} malformed records`);
    // 非终态但状态行与 updates 索引都没有原文 = 不可恢复的孤儿：两条恢复通道
    // 都会跳过它，attempts 永不增长，因此也永远不会进 dead-letter 或触发通知。
    // 不自动改它的状态（那是破坏性写入且会打扰 owner），只让它可见。
    const orphans = [...this.states.values()]
      .filter((entry) => !['done', 'dead-letter'].includes(entry.state))
      .filter((entry) => !entry.update && !this.updates.has(Number(entry.updateId)))
      .map((entry) => Number(entry.updateId));
    if (orphans.length) {
      this.log(
        `[spool] ⚠️ ${orphans.length} 条非终态记录已无原文，无法重放，需要人工处置：`
        + `${orphans.join(', ')}`,
      );
    }
  }

  append(entry) {
    const full = { at: new Date().toISOString(), ...entry };
    appendDurable(this.filePath, `${JSON.stringify(full)}\n`);
    if (Number.isFinite(Number(full.updateId)) && full.update) {
      this.updates.set(Number(full.updateId), full.update);
    }
    if (full.state === 'outbound-ack' && full.deliveryKey) {
      for (const updateId of full.updateIds || []) {
        this.deliveries.set(`${Number(updateId)}:${full.deliveryKey}`, full);
      }
    } else if (full.state === 'group-batch' && full.batchId && Array.isArray(full.updateIds)) {
      this.groupBatches.set(String(full.batchId), full);
      for (const updateId of full.updateIds) {
        this.groupBatchByUpdate.set(Number(updateId), String(full.batchId));
      }
    } else if (full.state === 'operation-result' && full.operationKey) {
      this.operationResults.set(String(full.operationKey), full);
    } else if (Number.isFinite(Number(full.updateId))) {
      this.states.set(Number(full.updateId), full);
    }
    this.appendsSinceCompactCheck += 1;
    if (this.appendsSinceCompactCheck >= 100) {
      this.appendsSinceCompactCheck = 0;
      this.compactIfNeeded();
    }
    return full;
  }

  receive(update) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId)) throw new Error('Telegram update 缺少合法 update_id');
    const current = this.states.get(updateId);
    if (['done', 'dead-letter', 'operator-paused'].includes(current?.state)) return false;
    if (this.inflight.has(updateId)) return false;
    if (!current || !current.update) this.append({ state: 'received', updateId, update });
    return true;
  }

  markProcessing(updateId, replay = false) {
    const id = Number(updateId);
    const prior = this.states.get(id);
    // 先落盘再标 inflight：append 抛错（磁盘满、权限抖动）时若 id 已在
    // inflight 里就没人清理了，而 inflight 同时是两条恢复通道的过滤条件和
    // 同 chat 顺序屏障——泄漏一个 id 就会把该 chat 堵死到进程重启为止。
    this.append({
      state: 'processing',
      updateId: id,
      replay: Boolean(replay),
      attempts: Number(prior?.attempts || 0),
      update: prior?.update || this.updates.get(id),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
    this.inflight.add(id);
  }

  markGroupQueued(updateId, preparedMessage, replay = false) {
    const id = Number(updateId);
    if (!Number.isFinite(id)) throw new Error('group-queued 缺少合法 updateId');
    if (!preparedMessage || typeof preparedMessage !== 'object') {
      throw new Error(`group-queued update ${id} 缺少 preparedMessage`);
    }
    const prior = this.states.get(id);
    const durableMessage = { ...preparedMessage };
    delete durableMessage._delivery;
    this.inflight.add(id);
    return this.append({
      state: 'group-queued',
      updateId: id,
      replay: Boolean(replay),
      attempts: Number(prior?.attempts || 0),
      update: prior?.update || this.updates.get(id),
      preparedMessage: durableMessage,
    });
  }

  markDone(updateId) {
    const id = Number(updateId);
    this.inflight.delete(id);
    this.append({ state: 'done', updateId: id, update: this.updates.get(id) });
  }

  archiveUnrecoverableOrphan(updateId, reason = 'operator-confirmed-original-unrecoverable') {
    const id = Number(updateId);
    if (!Number.isFinite(id)) throw new Error('orphan archive 缺少合法 updateId');
    const prior = this.states.get(id);
    if (!prior || ['done', 'dead-letter'].includes(prior.state)) {
      throw new Error(`update ${id} 不是可归档的非终态 orphan`);
    }
    if (prior.update || this.updates.has(id)) {
      throw new Error(`update ${id} 仍有原文，不能冒充不可恢复 orphan 归档`);
    }
    this.inflight.delete(id);
    return this.append({
      state: 'done',
      updateId: id,
      attempts: Number(prior.attempts || 0),
      disposition: 'unrecoverable-orphan-archived',
      archivedFromState: prior.state,
      reason: String(reason || 'operator-confirmed-original-unrecoverable').slice(0, 200),
    });
  }

  markFailed(updateId, error) {
    const id = Number(updateId);
    this.inflight.delete(id);
    const prior = this.states.get(id);
    const attempts = Number(prior?.attempts || 0) + 1;
    const deadLetter = attempts >= this.maxAttempts;
    const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(attempts - 1, 12)));
    return this.append({
      state: deadLetter ? 'dead-letter' : 'failed',
      updateId: id,
      update: prior?.update || this.updates.get(id),
      attempts,
      nextRetryAt: deadLetter ? null : Date.now() + delayMs,
      error: String(error?.message || error || '未知错误').slice(0, 500),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
  }

  requeueDeadLetter(updateId, reason = 'operator-requeue') {
    return this._requeueTerminal(updateId, ['dead-letter'], reason);
  }

  requeueDone(updateId, reason = 'operator-requeue-done') {
    return this._requeueTerminal(updateId, ['done'], reason);
  }

  requeueOperatorPaused(updateId, reason = 'operator-requeue-paused') {
    return this._requeueTerminal(updateId, ['operator-paused'], reason);
  }

  // failed 正常会自动重试，本不需要人工入口；但断链导致自动通道跳过它时，
  // 没有这个入口就连人工都救不了（只要 updates 索引里还留着原文就能救）。
  requeueFailed(updateId, reason = 'operator-requeue-failed') {
    return this._requeueTerminal(updateId, ['failed'], reason);
  }

  _requeueTerminal(updateId, allowedStates, reason) {
    const id = Number(updateId);
    const prior = this.states.get(id);
    const update = prior?.update || this.updates.get(id);
    if (!allowedStates.includes(prior?.state) || !update) {
      throw new Error(`update ${id} 不是可重排的 ${allowedStates.join('/')}`);
    }
    return this.append({
      state: 'received',
      updateId: id,
      update,
      attempts: 0,
      nextRetryAt: Date.now(),
      requeuedFrom: prior.state,
      reason: String(reason || 'operator-requeue').slice(0, 200),
    });
  }

  markPaused(updateId, error, retryAfterMs = 5 * 60 * 1000) {
    const id = Number(updateId);
    this.inflight.delete(id);
    const prior = this.states.get(id);
    return this.append({
      state: 'paused',
      updateId: id,
      update: prior?.update || this.updates.get(id),
      attempts: Number(prior?.attempts || 0),
      nextRetryAt: Date.now() + Math.max(30_000, Number(retryAfterMs) || 0),
      error: String(error?.message || error || '断路器暂停').slice(0, 500),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
  }

  markOperatorPaused(updateId, error) {
    const id = Number(updateId);
    this.inflight.delete(id);
    const prior = this.states.get(id);
    return this.append({
      state: 'operator-paused',
      updateId: id,
      update: prior?.update || this.updates.get(id),
      attempts: Number(prior?.attempts || 0),
      nextRetryAt: null,
      error: String(error?.message || error || '需要人工重排').slice(0, 500),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
  }

  // 状态行不一定自带 update：早期版本的 mark* 没有回填，链条中断后
  // 后续每一行都跟着丢原文。`updates` Map 是 journal 全量累积的原文索引，
  // 用它兜底可以让这类条目重新可恢复；两处都没有才是真正不可恢复的孤儿。
  _withUpdate(entry) {
    if (!entry || entry.update) return entry;
    const update = this.updates.get(Number(entry.updateId));
    return update ? { ...entry, update } : entry;
  }

  pendingEntries({ dueOnly = false, now = Date.now(), includeOperatorPaused = false } = {}) {
    return [...this.states.values()]
      .map((entry) => this._withUpdate(entry))
      .filter((entry) => !['done', 'dead-letter'].includes(entry.state) && entry.update && !this.inflight.has(Number(entry.updateId)))
      .filter((entry) => includeOperatorPaused || entry.state !== 'operator-paused')
      .filter((entry) => !dueOnly || !entry.nextRetryAt || Number(entry.nextRetryAt) <= now)
      .sort((a, b) => Number(a.updateId) - Number(b.updateId));
  }

  pendingUpdates(options = {}) {
    return this.pendingEntries(options).map((entry) => entry.update);
  }

  isDone(updateId) {
    return ['done', 'dead-letter'].includes(this.states.get(Number(updateId))?.state);
  }

  getState(updateId) {
    return this.states.get(Number(updateId)) || null;
  }

  chatIdForEntry(entry) {
    const message = entry?.update?.message || entry?.update?.edited_message;
    return String(message?.chat?.id ?? `update:${entry?.updateId}`);
  }

  chatIdForUpdate(update) {
    const message = update?.message || update?.edited_message;
    return String(message?.chat?.id ?? `update:${update?.update_id}`);
  }

  dueEntryRunsInOrder(now = Date.now()) {
    const entriesByChat = new Map();
    const nonTerminalEntries = [...this.states.values()]
      .map((entry) => this._withUpdate(entry))
      .filter((entry) => !['done', 'dead-letter'].includes(entry.state) && entry.update)
      .filter((entry) => entry.state !== 'operator-paused')
      .sort((a, b) => Number(a.updateId) - Number(b.updateId));
    for (const entry of nonTerminalEntries) {
      const chatId = this.chatIdForEntry(entry);
      if (!entriesByChat.has(chatId)) entriesByChat.set(chatId, []);
      entriesByChat.get(chatId).push(entry);
    }
    const runs = [];
    for (const entries of entriesByChat.values()) {
      const run = [];
      for (const entry of entries) {
        // 同 chat 的第一道未到期/inflight 项是顺序屏障；它后面的即使已到期也不能穿透。
        if (
          this.inflight.has(Number(entry.updateId))
          || (entry.nextRetryAt && Number(entry.nextRetryAt) > now)
        ) break;
        run.push(entry);
      }
      if (run.length) runs.push(run);
    }
    return runs.sort((left, right) => Number(left[0].updateId) - Number(right[0].updateId));
  }

  dueEntriesInOrder(now = Date.now()) {
    return this.dueEntryRunsInOrder(now).map((entries) => entries[0]);
  }

  hasEarlierBlockedEntry(update, { ignoreInflight = false } = {}) {
    const updateId = Number(update?.update_id);
    const message = update?.message || update?.edited_message;
    const chatId = String(message?.chat?.id ?? `update:${updateId}`);
    // operator-paused 必须排除，与 dueEntryRunsInOrder 的屏障判定保持同一语义：
    // 它的 nextRetryAt 是 null 永不到期，若算作屏障，同 chat 之后的每条实时消息
    // 都会被这里判「前方有未终结 update」而降级去 retry 兜底路径——消息不丢，
    // 但每条平添最多 1 秒延迟和一行日志，直到有人人工处置那条 paused。
    return [...this.states.values()].some((entry) => (
      Number(entry.updateId) < updateId
      && this.chatIdForEntry(entry) === chatId
      && !['done', 'dead-letter', 'operator-paused'].includes(entry.state)
      && (!ignoreInflight || !this.inflight.has(Number(entry.updateId)))
    ));
  }

  markGroupBatch(messages) {
    const updateIds = [...new Set(
      (messages || []).map((message) => Number(message.updateId)).filter(Number.isFinite),
    )].sort((a, b) => a - b);
    if (!updateIds.length) return null;
    const chatId = String(messages[0]?.chatId || 'unknown');
    const batchId = `${chatId}:${updateIds.join(',')}`;
    const existing = this.groupBatches.get(batchId);
    if (existing) return existing;
    for (const updateId of updateIds) {
      const priorBatchId = this.groupBatchByUpdate.get(updateId);
      if (priorBatchId && priorBatchId !== batchId) {
        throw new Error(`update ${updateId} 已属于 durable group-batch ${priorBatchId}，拒绝重组进 ${batchId}`);
      }
    }
    return this.append({
      state: 'group-batch',
      batchId,
      chatId,
      updateIds,
      messages: (messages || []).map((message) => ({ ...message, _delivery: undefined })),
    });
  }

  groupBatchForUpdate(updateId) {
    const batchId = this.groupBatchByUpdate.get(Number(updateId));
    return batchId ? this.groupBatches.get(batchId) || null : null;
  }

  markOperationResult(operationKey, updateId, result = {}) {
    const key = String(operationKey || '');
    if (!key) throw new Error('operation-result 缺 operationKey');
    const existing = this.operationResults.get(key);
    if (existing) return existing;
    return this.append({
      state: 'operation-result',
      operationKey: key,
      updateId: Number(updateId),
      result,
    });
  }

  getOperationResult(operationKey) {
    return this.operationResults.get(String(operationKey || '')) || null;
  }

  isDelivered(updateId, deliveryKey) {
    return this.deliveries.has(`${Number(updateId)}:${String(deliveryKey)}`);
  }

  markOutboundAck(updateIds, deliveryKey, details = {}) {
    const ids = [...new Set((updateIds || []).map(Number).filter(Number.isFinite))];
    if (!ids.length || !deliveryKey) return;
    this.append({ state: 'outbound-ack', updateIds: ids, deliveryKey: String(deliveryKey), ...details });
  }

  compactIfNeeded() {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch (_) { return; }
    if (size <= this.maxBytes) return;
    const sorted = [...this.states.values()].sort((a, b) => Number(a.updateId) - Number(b.updateId));
    // pending 也必须回填 update：压缩会重写整个 journal，带原文的早期 received
    // 行不在保留集里。少了这一步，状态行缺 update 的条目会被永久固化成
    // 无法重放的僵尸——原文在这一刻真的消失，之后改代码也救不回来。
    const pending = sorted
      .filter((entry) => !['done', 'dead-letter'].includes(entry.state))
      .map((entry) => this._withUpdate(entry));
    const pendingIds = new Set(pending.map((entry) => Number(entry.updateId)));
    const recentDone = sorted
      .filter((entry) => ['done', 'dead-letter'].includes(entry.state) && !pendingIds.has(Number(entry.updateId)))
      .slice(-5000)
      .map((entry) => ({ ...entry, update: entry.update || this.updates.get(Number(entry.updateId)) }));
    const retainedEntries = [...pending, ...recentDone].sort((a, b) => Number(a.updateId) - Number(b.updateId));
    const retainedStates = retainedEntries
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const pendingIdSet = new Set(pending.map((entry) => Number(entry.updateId)));
    const retainedDeliveries = [...new Map(
      [...this.deliveries.values()]
        .filter((entry) => (entry.updateIds || []).some((id) => pendingIdSet.has(Number(id))))
        .map((entry) => [`${entry.deliveryKey}:${(entry.updateIds || []).join(',')}`, entry]),
    ).values()].map((entry) => JSON.stringify(entry)).join('\n');
    const retainedBatches = [...this.groupBatches.values()]
      .filter((entry) => entry.updateIds.some((id) => pendingIdSet.has(Number(id))))
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const retainedOperations = [...this.operationResults.values()]
      .filter((entry) => pendingIdSet.has(Number(entry.updateId)))
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const retained = [retainedStates, retainedDeliveries, retainedBatches, retainedOperations].filter(Boolean).join('\n');
    writeAtomic(this.filePath, retained ? `${retained}\n` : '');
    this.log(`[spool] 安全压缩 ${path.basename(this.filePath)}，保留 ${pending.length} 个未完成 + ${recentDone.length} 个最近完成 update`);
  }
}

module.exports = { DurableInbox, writeAtomic };
