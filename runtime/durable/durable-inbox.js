// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deliveryFailureMetadata } = require('./delivery-failure-metadata');

// 群批因「同群更早的 update 尚未完成」被挡下而挂起（bridge.js generateGroupReplies 的
// GROUP_ORDER_BLOCKED）。旧记录没有 pauseCode，按错误文案兜底识别。
function isGroupOrderBlocked(entry) {
  if (entry?.state !== 'paused') return false;
  if (entry.pauseCode === 'GROUP_ORDER_BLOCKED') return true;
  return /有更早的 durable update 尚未恢复/.test(String(entry.error || ''));
}

function writeAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  fs.chmodSync(tmp, mode);
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // rename preserves the already-hardened inode mode and is the commit point.
  // A redundant chmod afterwards could throw after disk changed but before the
  // caller publishes its matching in-memory indexes.
  fs.renameSync(tmp, filePath);
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
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw Object.assign(new Error('durable_inbox_short_write'), { code: 'EIO' });
      offset += written;
    }
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
    this.outboundAttempts = new Map();
    this.groupBatches = new Map();
    this.groupBatchByUpdate = new Map();
    this.albumBatches = new Map();
    this.albumBatchByUpdate = new Map();
    this.operationResults = new Map();
    this.heartbeatActivities = new Map();
    this.heartbeatActivityReady = false;
    this.heartbeatActivityUnavailable = false;
    this.heartbeatPublications = [];
    this.heartbeatPublicationIds = new Map();
    this.heartbeatPublicationTypes = new Map();
    this.heartbeatPublicationReady = false;
    this.heartbeatPublicationLegacyPending = false;
    this.heartbeatPublicationReconciliation = null;
    this.heartbeatPublicationUnavailable = false;
    this.heartbeatPublicationWriteUncertain = false;
    this.heartbeatPublicationOrigins = new Map();
    this.heartbeatPublicationOriginUnavailable = false;
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
        try { this._indexHeartbeatActivity(entry); }
        catch (_) { this.heartbeatActivityUnavailable = true; }
        try { this._indexHeartbeatPublication(entry); }
        catch (_) { this.heartbeatPublicationUnavailable = true; }
        try { this._indexHeartbeatPublicationOrigin(entry); }
        catch (_) { this.heartbeatPublicationOriginUnavailable = true; }
        if (Number.isFinite(Number(entry.updateId)) && entry.update) {
          this.updates.set(Number(entry.updateId), entry.update);
        }
        if (entry.state === 'outbound-ack' && entry.deliveryKey) {
          for (const updateId of entry.updateIds || []) {
            this.deliveries.set(`${Number(updateId)}:${entry.deliveryKey}`, entry);
          }
        } else if (entry.state === 'outbound-attempt' && entry.deliveryKey) {
          for (const updateId of entry.updateIds || []) {
            this.outboundAttempts.set(`${Number(updateId)}:${entry.deliveryKey}`, entry);
          }
        } else if (entry.state === 'group-batch' && entry.batchId && Array.isArray(entry.updateIds)) {
          this.groupBatches.set(String(entry.batchId), entry);
          for (const updateId of entry.updateIds) {
            this.groupBatchByUpdate.set(Number(updateId), String(entry.batchId));
          }
        } else if (entry.state === 'album-batch') {
          this._indexAlbumBatch(entry);
        } else if (entry.state === 'album-done') {
          this._indexAlbumDone(entry);
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
    this._validateHeartbeatActivityEntry(full);
    require('./heartbeat-publication-origin').validateOriginEntry(full, this.heartbeatPublicationOrigins);
    if (full.state === 'heartbeat-publication-event' && !this.heartbeatPublicationReady) throw new Error('heartbeat_inbox_publication_not_ready');
    this._validateHeartbeatPublicationScope(full);
    require('./heartbeat-inbox-publication').validatePublicationEntry(full,
      this.heartbeatPublications, this.heartbeatPublicationIds, this.heartbeatPublicationOrigins);
    appendDurable(this.filePath, `${JSON.stringify(full)}\n`);
    this._indexHeartbeatActivity(full);
    this._indexHeartbeatPublication(full);
    this._indexHeartbeatPublicationOrigin(full);
    if (Number.isFinite(Number(full.updateId)) && full.update) {
      this.updates.set(Number(full.updateId), full.update);
    }
    if (full.state === 'outbound-ack' && full.deliveryKey) {
      for (const updateId of full.updateIds || []) {
        this.deliveries.set(`${Number(updateId)}:${full.deliveryKey}`, full);
      }
    } else if (full.state === 'outbound-attempt' && full.deliveryKey) {
      for (const updateId of full.updateIds || []) {
        this.outboundAttempts.set(`${Number(updateId)}:${full.deliveryKey}`, full);
      }
    } else if (full.state === 'group-batch' && full.batchId && Array.isArray(full.updateIds)) {
      this.groupBatches.set(String(full.batchId), full);
      for (const updateId of full.updateIds) {
        this.groupBatchByUpdate.set(Number(updateId), String(full.batchId));
      }
    } else if (full.state === 'album-batch') {
      this._indexAlbumBatch(full);
    } else if (full.state === 'album-done') {
      this._indexAlbumDone(full);
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

  _indexHeartbeatPublicationOrigin(entry) {
    for (const original of require('./heartbeat-publication-origin').validateOriginEntry(entry, this.heartbeatPublicationOrigins)) {
      this.heartbeatPublicationOrigins.set(original.turnId, structuredClone(original));
    }
  }
  recordHeartbeatPublicationOrigin(plan, at = Date.now()) {
    if (this.heartbeatPublicationOriginUnavailable) throw new Error('publication_origin_unavailable');
    if (this.heartbeatPublicationWriteUncertain) throw new Error('heartbeat_journal_requires_reopen');
    const { stablePlan, makeOrigin } = require('./heartbeat-publication-origin');
    const frozen = stablePlan(plan);
    const prior = this.heartbeatPublicationOrigins.get(frozen.turnId);
    // Rewind/correction cannot overwrite the original birth observation.
    // Full lineage must still decide whether this is a genuinely first draft.
    if (prior) return structuredClone(prior);
    const origin = makeOrigin(frozen, at);
    require('./heartbeat-publication-origin').validateOriginEntry({ state: 'heartbeat-publication-origin',
      heartbeatPublicationOrigin: origin }, this.heartbeatPublicationOrigins);
    try { this.append({ state: 'heartbeat-publication-origin', heartbeatPublicationOrigin: origin }); }
    catch (error) { this.heartbeatPublicationWriteUncertain = true; throw error; }
    return structuredClone(origin);
  }
  _indexHeartbeatPublication(entry) {
    if (entry.state === 'heartbeat-publication-event' && !this.heartbeatPublicationReady) throw new Error('heartbeat_inbox_publication_not_ready');
    this._validateHeartbeatPublicationScope(entry);
    const records = require('./heartbeat-inbox-publication').validatePublicationEntry(entry,
      this.heartbeatPublications, this.heartbeatPublicationIds, this.heartbeatPublicationOrigins);
    for (const original of records) {
      const record = structuredClone(original);
      this.heartbeatPublications.push(record); this.heartbeatPublicationIds.set(record.id, record);
      if (!this.heartbeatPublicationTypes.has(record.type)) this.heartbeatPublicationTypes.set(record.type, []);
      this.heartbeatPublicationTypes.get(record.type).push(record);
    }
    if (entry.state === 'heartbeat-publication-ready') {
      this.heartbeatPublicationReady = true;
      this.heartbeatPublicationLegacyPending = entry.heartbeatPublicationLegacyPending === true;
    }
    if (entry.heartbeatPublicationReconciliation !== undefined) {
      this.heartbeatPublicationReconciliation = structuredClone(entry.heartbeatPublicationReconciliation);
      this.heartbeatPublicationLegacyPending = false;
    }
  }
  _validateHeartbeatPublicationScope(entry) {
    if (entry.state === 'heartbeat-publication-reconciled' && (!this.heartbeatPublicationReady || !this.heartbeatPublicationLegacyPending)) {
      throw new Error('heartbeat_inbox_publication_scope_conflict');
    }
    if (entry.state === 'heartbeat-publication-event' && entry.heartbeatPublication?.type === 'bridge_publication_adopted'
        && !this.heartbeatPublicationLegacyPending) throw new Error('heartbeat_inbox_publication_scope_invalid');
    if (entry.state === 'heartbeat-publication-ready' && this.heartbeatPublicationReady
        && (entry.heartbeatPublicationLegacyPending === true) !== this.heartbeatPublicationLegacyPending) {
      throw new Error('heartbeat_inbox_publication_scope_conflict');
    }
  }

  initializeHeartbeatPublication(records, { legacyPending = false } = {}) {
    if (this.heartbeatPublicationUnavailable) throw new Error('heartbeat_inbox_publication_unavailable');
    if (this.heartbeatPublicationWriteUncertain) throw new Error('heartbeat_journal_requires_reopen');
    if (!this.heartbeatPublicationReady) {
      try { this.append({ state: 'heartbeat-publication-ready', heartbeatPublications: records,
        ...(legacyPending ? { heartbeatPublicationLegacyPending: true } : {}) }); }
      catch (error) { this.heartbeatPublicationWriteUncertain = true; throw error; }
    }
  }

  _validateHeartbeatActivityEntry(entry) {
    const payloads = entry.state === 'heartbeat-activity-source-ready' ? entry.heartbeatActivities : [];
    if (!Array.isArray(payloads)) throw new Error('heartbeat_inbox_activity_invalid');
    const seen = new Map();
    for (const p of [...payloads, ...(entry.heartbeatActivity ? [entry.heartbeatActivity] : [])]) {
      if (!p || !Number.isSafeInteger(p.updateId) || p.updateId < 0 || p.senderIsBot !== false
          || typeof p.senderId !== 'string' || !p.senderId || typeof p.chatId !== 'string' || !p.chatId
          || !Number.isSafeInteger(p.observedAt) || p.observedAt < 0) throw new Error('heartbeat_inbox_activity_invalid');
      const prior = seen.get(p.updateId) ?? this.heartbeatActivities.get(p.updateId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(p)) throw new Error('heartbeat_inbox_activity_conflict');
      seen.set(p.updateId, p);
    }
  }

  _indexHeartbeatActivity(entry) {
    this._validateHeartbeatActivityEntry(entry);
    const payloads = entry.state === 'heartbeat-activity-source-ready' ? entry.heartbeatActivities : [];
    for (const p of [...payloads, ...(entry.heartbeatActivity ? [entry.heartbeatActivity] : [])]) {
      this.heartbeatActivities.set(p.updateId, { ...p });
    }
    if (entry.state === 'heartbeat-activity-source-ready') this.heartbeatActivityReady = true;
  }

  initializeHeartbeatActivity(activities) {
    if (!this.heartbeatActivityReady) this.append({ state: 'heartbeat-activity-source-ready', heartbeatActivities: activities });
  }

  recordHeartbeatActivity(payload) {
    this._validateHeartbeatActivityEntry({ heartbeatActivity: payload });
    if (!this.heartbeatActivities.has(payload.updateId)) this.append({ state: 'heartbeat-owner-activity', heartbeatActivity: payload });
  }

  receive(update, { heartbeatActivity = null } = {}) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId)) throw new Error('Telegram update 缺少合法 update_id');
    const current = this.states.get(updateId);
    if (heartbeatActivity) {
      if (heartbeatActivity.updateId !== updateId) throw new Error('heartbeat_inbox_update_mismatch');
      this._validateHeartbeatActivityEntry({ heartbeatActivity });
    }
    const addActivity = () => { if (heartbeatActivity) this.recordHeartbeatActivity(heartbeatActivity); };
    if (['done', 'dead-letter', 'operator-paused'].includes(current?.state)) { addActivity(); return false; }
    if (this.inflight.has(updateId)) { addActivity(); return false; }
    if (!current || !current.update) this.append({ state: 'received', updateId, update,
      ...(heartbeatActivity ? { heartbeatActivity } : {}) });
    else addActivity();
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

  archiveTerminal(updateId, reason = 'operator-confirmed-no-replay') {
    const id = Number(updateId);
    if (!Number.isFinite(id)) throw new Error('terminal archive 缺少合法 updateId');
    const prior = this.states.get(id);
    if (!['dead-letter', 'operator-paused'].includes(prior?.state)) {
      throw new Error(`update ${id} 不是可归档的 dead-letter/operator-paused`);
    }
    const update = prior.update || this.updates.get(id);
    if (!update) {
      throw new Error(`update ${id} 缺少原始 update；请使用 archiveUnrecoverableOrphan`);
    }
    this.inflight.delete(id);
    return this.append({
      state: 'done',
      updateId: id,
      update,
      attempts: Number(prior.attempts || 0),
      disposition: 'operator-archived-no-replay',
      archivedFromState: prior.state,
      reason: String(reason || 'operator-confirmed-no-replay').slice(0, 200),
    });
  }

  // 用户编辑了一条还没答出来的私聊（例如被安全模板拦下、正等重试）：原文不再重放，改由编辑后的文字重答
  // 已准备好回复或已有投递编号的不动——那可能已经发出去了。
  // 用户编辑一条还没答出来的私聊时，先把原条目的正文换成编辑后的文字、
  // 停在 operator-paused（不会被自动重试抢答旧文字），答成了再销账；答失败就一直留在待处理里，
  // 运维的重投命令能按编辑后的文字重试。原来是先销账再答，答失败就两头落空。
  adoptOwnerEdit(updateId, editedMessage) {
    const id = Number(updateId);
    const prior = this.states.get(id);
    if (!prior || this.inflight.has(id) || prior.preparedMessage || prior.deliveryKey
        || !['operator-paused', 'delivery-unknown', 'paused', 'failed'].includes(prior.state)) return null;
    const update = prior.update || this.updates.get(id);
    if (!update?.message || !editedMessage
        || Number(editedMessage.message_id) !== Number(update.message.message_id)) return null;
    return this.append({
      state: 'operator-paused',
      updateId: id,
      update: { ...update, message: { ...update.message, ...editedMessage } },
      attempts: Number(prior.attempts || 0),
      nextRetryAt: null,
      error: '用户编辑了这条消息，按编辑后的文字处理',
      ownerEditedFromState: prior.state,
    });
  }

  supersedeByOwnerEdit(updateId) {
    const id = Number(updateId);
    const prior = this.states.get(id);
    if (!prior || this.inflight.has(id) || prior.preparedMessage || prior.deliveryKey
        || !['operator-paused', 'delivery-unknown', 'paused', 'failed'].includes(prior.state)) return null;
    const update = prior.update || this.updates.get(id);
    if (!update) return null;
    return this.append({
      state: 'done',
      updateId: id,
      update,
      attempts: Number(prior.attempts || 0),
      disposition: 'superseded-by-owner-edit',
      archivedFromState: prior.state,
    });
  }

  archiveUnrecoverableOrphan(updateId, reason = 'operator-confirmed-original-unrecoverable') {
    const id = Number(updateId);
    if (!Number.isFinite(id)) throw new Error('orphan archive 缺少合法 updateId');
    const prior = this.states.get(id);
    if (!prior || prior.state === 'done') {
      throw new Error(`update ${id} 不是可归档的 orphan`);
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
      failureMetadata: deliveryFailureMetadata(error),
      error: String(error?.message || error || '未知错误').slice(0, 500),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
  }

  markDeliveryUnknown(updateId, error, retryAfterMs = this.retryMaxMs) {
    const id = Number(updateId);
    this.inflight.delete(id);
    const prior = this.states.get(id);
    const attempts = Number(prior?.attempts || 0) + 1;
    const deadLetter = attempts >= this.maxAttempts;
    const delayMs = Math.max(30_000, Number(retryAfterMs) || this.retryMaxMs);
    return this.append({
      state: deadLetter ? 'dead-letter' : 'delivery-unknown',
      updateId: id,
      update: prior?.update || this.updates.get(id),
      attempts,
      nextRetryAt: deadLetter ? null : Date.now() + delayMs,
      failureMetadata: deliveryFailureMetadata(error),
      error: String(error?.message || error || 'Telegram delivery outcome unknown').slice(0, 500),
      deliveryOutcome: 'unknown',
      deliveryKey: error?.deliveryKey == null ? null : String(error.deliveryKey),
      deliveryAttemptNumber: Number.isFinite(Number(error?.deliveryAttemptNumber))
        ? Number(error.deliveryAttemptNumber)
        : null,
      telegramMethod: error?.telegramMethod == null ? null : String(error.telegramMethod),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
  }

  markDeliveryHeld(updateId, error) {
    const id = Number(updateId);
    const prior = this.states.get(id);
    const update = prior?.update || this.updates.get(id);
    const type = update?.message?.chat?.type;
    const privatePublication = type === 'private' && typeof error?.publicationEffectId === 'string'
      && error.publicationEffectId.length > 0;
    if ((!['group', 'supergroup'].includes(type) && !privatePublication)
      || !(error?.deliveryOutcome === 'unknown' || error?.deliveryUnknown)) {
      throw new Error('delivery held requires a group or frozen private publication and unknown delivery');
    }
    if (prior?.state === 'operator-paused' && prior.disposition === 'delivery-unknown-held-no-replay') {
      this.inflight.delete(id);
      return prior;
    }
    const state = this.append({
      state: 'operator-paused', updateId: id, update,
      attempts: Number(prior?.attempts || 0), nextRetryAt: null,
      disposition: 'delivery-unknown-held-no-replay', deliveryOutcome: 'unknown',
      failureMetadata: deliveryFailureMetadata(error),
      error: String(error?.message || 'Telegram delivery outcome unknown').slice(0, 500),
      deliveryKey: error?.deliveryKey == null ? null : String(error.deliveryKey),
      publicationEffectId: error?.publicationEffectId == null ? null : String(error.publicationEffectId),
      deliveryAttemptNumber: Number.isFinite(Number(error?.deliveryAttemptNumber))
        ? Number(error.deliveryAttemptNumber) : null,
      telegramMethod: error?.telegramMethod == null ? null : String(error.telegramMethod),
      ...(prior?.preparedMessage ? { preparedMessage: prior.preparedMessage } : {}),
    });
    this.inflight.delete(id);
    return state;
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
      failureMetadata: deliveryFailureMetadata(error),
      error: String(error?.message || error || '断路器暂停').slice(0, 500),
      ...(error?.code ? { pauseCode: String(error.code) } : {}),
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
      failureMetadata: deliveryFailureMetadata(error),
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

  inspect(updateId) {
    const entry = this._withUpdate(this.states.get(Number(updateId)) || null);
    return entry ? structuredClone(entry) : null;
  }

  inventory({ states = null, previewChars = 200 } = {}) {
    const wanted = states == null
      ? null
      : new Set((Array.isArray(states) ? states : [states]).map(String));
    return [...this.states.values()]
      .map((entry) => this._withUpdate(entry))
      .filter((entry) => !wanted || wanted.has(String(entry.state)))
      .sort((left, right) => Number(left.updateId) - Number(right.updateId))
      .map((entry) => {
        const message = entry.update?.message || entry.update?.edited_message;
        const text = String(message?.text || message?.caption || '');
        return {
          updateId: Number(entry.updateId),
          state: String(entry.state),
          attempts: Number(entry.attempts || 0),
          nextRetryAt: entry.nextRetryAt ?? null,
          chatId: message?.chat?.id == null ? null : String(message.chat.id),
          telegramMessageId: message?.message_id ?? null,
          hasOriginal: Boolean(entry.update),
          recoverable: Boolean(entry.update) && [
            'dead-letter',
            'operator-paused',
            'failed',
            'delivery-unknown',
            'paused',
            'received',
            'processing',
            'group-queued',
          ].includes(String(entry.state)),
          error: entry.error == null ? null : String(entry.error),
          failureMetadata: entry.failureMetadata ? structuredClone(entry.failureMetadata) : null,
          ...(entry.disposition === 'delivery-unknown-held-no-replay' ? {
            disposition: entry.disposition, deliveryOutcome: entry.deliveryOutcome,
            publicationEffectId: entry.publicationEffectId, deliveryKey: entry.deliveryKey,
          } : {}),
          textPreview: text.slice(0, Math.max(0, Number(previewChars) || 0)),
        };
      });
  }

  status() {
    const counts = {};
    let unrecoverableOrphans = 0;
    for (const entry of this.states.values()) {
      const state = String(entry.state || 'unknown');
      counts[state] = Number(counts[state] || 0) + 1;
      if (
        state !== 'done'
        && !entry.update
        && !this.updates.has(Number(entry.updateId))
      ) unrecoverableOrphans += 1;
    }
    return {
      counts,
      total: this.states.size,
      inflight: this.inflight.size,
      unrecoverableOrphans,
      deadLetters: Number(counts['dead-letter'] || 0),
      operatorPaused: Number(counts['operator-paused'] || 0),
    };
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
        // 2026-10-03：只因「前序未完成」而挂起的群消息不看自己的 30 秒到期时间——
        // 挡它的前序一旦完成或已在本轮里，它就该立刻跟着走，让一串被挡下的消息合成
        // 一批交给 batcher，而不是按各自错开的到期时间一条一条补发。
        const orderWaitCleared = isGroupOrderBlocked(entry)
          && this._earlierUnfinishedIds(entry).every((id) => run.some((item) => Number(item.updateId) === id));
        if (
          this.inflight.has(Number(entry.updateId))
          || (!orderWaitCleared && entry.nextRetryAt && Number(entry.nextRetryAt) > now)
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

  _earlierUnfinishedIds(entry) {
    const updateId = Number(entry?.updateId);
    const chatId = this.chatIdForEntry(entry);
    return [...this.states.values()]
      .filter((other) => Number(other.updateId) < updateId
        && this.chatIdForEntry(other) === chatId
        && !['done', 'dead-letter', 'operator-paused'].includes(other.state))
      .map((other) => Number(other.updateId));
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

  _indexAlbumBatch(record) {
    if (!record.batchId || !Array.isArray(record.updates) || !record.updates.length
        || !Array.isArray(record.updateIds) || record.updates.length !== record.updateIds.length
        || Number(record.primaryUpdateId) !== Number(record.updateIds[0])
        || !record.updateIds.every((id, index) => Number.isSafeInteger(id)
          && (index === 0 || id > record.updateIds[index - 1]))
        || !Array.isArray(record.causalIds) || record.causalIds.length !== 1
        || record.causalIds[0] !== record.primaryUpdateId
        || record.updates.some((update, index) => Number(update.update_id) !== Number(record.updateIds[index])
          || update.message?.chat?.type !== 'private'
          || String(update.message?.chat?.id) !== String(record.chatId)
          || !update.message?.media_group_id
          || String(update.message.media_group_id) !== String(record.updates[0].message.media_group_id)
          || String(update.message.message_thread_id ?? '') !== String(record.updates[0].message.message_thread_id ?? ''))
        || record.updateIds.some((id) => this.albumBatchByUpdate.has(id)
          && this.albumBatchByUpdate.get(id) !== String(record.batchId))) {
      throw new Error('album-batch membership 与原始 updates 不一致');
    }
    this.albumBatches.set(String(record.batchId), record);
    for (const update of record.updates) {
      const id = Number(update.update_id);
      this.albumBatchByUpdate.set(id, String(record.batchId));
      this.updates.set(id, update);
    }
  }

  _indexAlbumDone(record) {
    const frozen = this.albumBatches.get(String(record.batchId));
    if (!frozen || JSON.stringify(record.updateIds) !== JSON.stringify(frozen.updateIds)) {
      throw new Error('album-done 与 frozen membership 不一致');
    }
    for (const id of record.updateIds.map(Number)) {
      this.states.set(id, { state: 'done', at: record.at, updateId: id, update: this.updates.get(id), albumBatchId: record.batchId });
      this.inflight.delete(id);
    }
  }

  markAlbumBatch(updates) {
    const sorted = [...updates].sort((left, right) => Number(left.update_id) - Number(right.update_id));
    const primary = sorted[0];
    const message = primary?.message;
    const updateIds = sorted.map((update) => Number(update.update_id));
    if (!message?.media_group_id || message.chat?.type !== 'private'
        || updateIds.some((id) => !Number.isSafeInteger(id)) || new Set(updateIds).size !== sorted.length
        || sorted.some((update) => update.message?.chat?.type !== 'private'
          || String(update.message?.chat?.id) !== String(message.chat.id)
          || String(update.message?.message_thread_id ?? '') !== String(message.message_thread_id ?? '')
          || String(update.message?.media_group_id) !== String(message.media_group_id))) {
      throw new Error('private album 缺合法同 chat/topic/media_group membership');
    }
    const batchId = `${message.chat.id}:album:${updateIds.join(',')}`;
    const existing = this.albumBatches.get(batchId);
    if (existing) return existing;
    if (updateIds.some((id) => this.albumBatchByUpdate.has(id))) throw new Error('private album update 已属于另一 frozen batch');
    // Freeze before dispatch. Keep the original primary causal identity for
    // compatibility with an already-committed primary turn; membership owns all ACKs.
    return this.append({ state: 'album-batch', batchId, chatId: String(message.chat.id),
      primaryUpdateId: updateIds[0], causalIds: [updateIds[0]], updateIds,
      updates: JSON.parse(JSON.stringify(sorted)) });
  }

  albumBatchForUpdate(updateId) {
    const batchId = this.albumBatchByUpdate.get(Number(updateId));
    return batchId ? this.albumBatches.get(batchId) || null : null;
  }

  hasLegacyCompletedAlbumSibling(update) {
    const message = update?.message;
    if (!message?.media_group_id) return false;
    return [...this.states.values()].some((entry) => {
      const sibling = (entry.update || this.updates.get(Number(entry.updateId)))?.message;
      return entry.state === 'done' && Number(entry.updateId) !== Number(update.update_id)
        && !this.albumBatchByUpdate.has(Number(entry.updateId))
        && String(sibling?.chat?.id) === String(message.chat?.id)
        && String(sibling?.message_thread_id ?? '') === String(message.message_thread_id ?? '')
        && String(sibling?.media_group_id) === String(message.media_group_id);
    });
  }

  markAlbumDone(record) {
    const frozen = this.albumBatches.get(String(record?.batchId));
    if (!frozen) throw new Error('album-done 缺 frozen membership');
    // One append/fsync is the whole-album commit, never a loop of partial done writes.
    return this.append({ state: 'album-done', batchId: frozen.batchId, updateIds: frozen.updateIds });
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

  markOutboundAttempt(updateIds, deliveryKey, details = {}) {
    const ids = [...new Set((updateIds || []).map(Number).filter(Number.isFinite))];
    if (!ids.length || !deliveryKey) return null;
    const previousAttempt = ids.reduce((highest, id) => {
      const prior = this.outboundAttempts.get(`${id}:${String(deliveryKey)}`);
      return Math.max(highest, Number(prior?.attemptNumber || 0));
    }, 0);
    return this.append({
      state: 'outbound-attempt',
      updateIds: ids,
      deliveryKey: String(deliveryKey),
      attemptNumber: previousAttempt + 1,
      outcome: 'pending',
      ...details,
    });
  }

  latestOutboundAttempt(updateId, deliveryKey) {
    return this.outboundAttempts.get(`${Number(updateId)}:${String(deliveryKey)}`) || null;
  }

  compactIfNeeded() {
    // Never compact away an invalid activity record and silently turn its
    // unavailable source into a ready-empty one. Ordinary dispatch still works.
    if (this.heartbeatActivityUnavailable || this.heartbeatPublicationUnavailable || this.heartbeatPublicationWriteUncertain
        || this.heartbeatPublicationOriginUnavailable) return;
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch (_) { return; }
    // 心跳发信账本那一行压不掉（30MB+），压完还是超过上限，原来每 100 次写入就整份重写一次
    // （10/16 起 912 次，每次同步卡桥约 0.5 秒）。压完仍超限时，等文件再长四分之一才压下一次。
    if (size <= Math.max(this.maxBytes, this.compactFloor || 0)) return;
    const sorted = [...this.states.values()].sort((a, b) => Number(a.updateId) - Number(b.updateId));
    // Only successful completion is evictable. A dead-letter still owns an
    // undelivered update and its causal receipts until explicit operator resolution.
    const unresolved = sorted.filter((entry) => entry.state !== 'done'
      || this.inflight.has(Number(entry.updateId)));
    const recentDone = sorted.filter((entry) => entry.state === 'done').slice(-5000);
    const retainedIds = new Set([...unresolved, ...recentDone].map((entry) => Number(entry.updateId)));
    // Retain whole prepared batches, including already-done siblings: retry must
    // use the original membership and receipts, never synthesize a smaller batch.
    let changed;
    do {
      changed = false;
      for (const batch of [...this.groupBatches.values(), ...this.albumBatches.values()]) {
        if (!batch.updateIds.some((id) => retainedIds.has(Number(id)))) continue;
        for (const id of batch.updateIds.map(Number)) {
          if (!retainedIds.has(id)) { retainedIds.add(id); changed = true; }
        }
      }
    } while (changed);
    const states = sorted.filter((entry) => retainedIds.has(Number(entry.updateId)))
      .map((entry) => this._withUpdate(entry));
    const deliveries = [...new Set(this.deliveries.values())]
      .filter((entry) => (entry.updateIds || []).some((id) => retainedIds.has(Number(id))));
    const outboundAttempts = [...new Set(this.outboundAttempts.values())]
      .filter((entry) => (entry.updateIds || []).some((id) => retainedIds.has(Number(id))));
    const batches = [...this.groupBatches.values()]
      .filter((entry) => entry.updateIds.some((id) => retainedIds.has(Number(id))));
    const albums = [...this.albumBatches.values()]
      .filter((entry) => entry.updateIds.some((id) => retainedIds.has(Number(id))));
    const operations = [...this.operationResults.values()]
      .filter((entry) => retainedIds.has(Number(entry.updateId)));
    // Activity observations are a separate projection, not pending model turns.
    // Preserve original timestamps even after their completed raw update is evicted.
    const activityRecords = [...this.heartbeatActivities.values()].map(heartbeatActivity => ({ state: 'heartbeat-owner-activity', heartbeatActivity }));
    const records = [...(this.heartbeatActivityReady ? [{ state: 'heartbeat-activity-source-ready', heartbeatActivities: [] }] : []),
      ...(this.heartbeatPublicationOrigins.size ? [{ state: 'heartbeat-publication-origin-snapshot',
        heartbeatPublicationOrigins: [...this.heartbeatPublicationOrigins.values()] }] : []),
      ...(this.heartbeatPublicationReady ? [{ state: 'heartbeat-publication-ready', heartbeatPublications: this.heartbeatPublications,
        ...(this.heartbeatPublicationLegacyPending ? { heartbeatPublicationLegacyPending: true } : {}),
        ...(this.heartbeatPublicationReconciliation ? { heartbeatPublicationReconciliation: this.heartbeatPublicationReconciliation } : {}) }] : []),
      ...activityRecords, ...states, ...outboundAttempts, ...deliveries, ...batches, ...albums, ...operations];
    writeAtomic(this.filePath, records.map((entry) => JSON.stringify(entry)).join('\n') + (records.length ? '\n' : ''));
    // Publish the same projection only after the durable replacement succeeds.
    // Prune all indexes, not just states; otherwise raw updates/receipts leak forever.
    this.states = new Map(states.map((entry) => [Number(entry.updateId), entry]));
    this.updates = new Map(states.filter((entry) => entry.update)
      .map((entry) => [Number(entry.updateId), entry.update]));
    this.deliveries = new Map(deliveries.flatMap((entry) => (entry.updateIds || [])
      .map((id) => [`${Number(id)}:${entry.deliveryKey}`, entry])));
    this.outboundAttempts = new Map(outboundAttempts.flatMap((entry) => (entry.updateIds || [])
      .map((id) => [`${Number(id)}:${entry.deliveryKey}`, entry])));
    this.groupBatches = new Map(batches.map((entry) => [String(entry.batchId), entry]));
    this.groupBatchByUpdate = new Map(batches.flatMap((entry) => entry.updateIds
      .map((id) => [Number(id), String(entry.batchId)])));
    this.albumBatches = new Map(albums.map((entry) => [String(entry.batchId), entry]));
    this.albumBatchByUpdate = new Map(albums.flatMap((entry) => entry.updateIds
      .map((id) => [Number(id), String(entry.batchId)])));
    this.operationResults = new Map(operations.map((entry) => [String(entry.operationKey), entry]));
    let compacted = 0;
    try { compacted = fs.statSync(this.filePath).size; } catch (_) { /* 下次照常检查 */ }
    this.compactFloor = compacted > this.maxBytes ? Math.round(compacted * 1.25) : 0;
    this.log(`[spool] 安全压缩 ${path.basename(this.filePath)}，保留 ${unresolved.length} 个未解决、${states.length} 个完整 update`
      + (this.compactFloor ? `；压完仍有 ${Math.round(compacted / 1048576)}MB，长到 ${Math.round(this.compactFloor / 1048576)}MB 再压` : ''));
  }
}

module.exports = { DurableInbox, writeAtomic };
