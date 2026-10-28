'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_MAX_BYTES: DEFAULT_MANIFEST_MAX_BYTES,
  DEFAULT_MAX_RECORDS: DEFAULT_MANIFEST_MAX_RECORDS,
  appendBoundedJsonl,
} = require('./compile-manifest-journal.js');

const {
  SemanticMemoryPipeline,
  createSemanticPacket,
  stableHash,
} = require('./semantic-memory-pipeline.js');
const {
  SemanticProjectionBuilder,
} = require('./semantic-memory-projections.js');
const {
  SemanticMemoryStore,
  appendFsynced,
  atomicWriteJson,
  ensurePrivateDirectory,
  readLatestJsonl,
} = require('./semantic-memory-store.js');
const {
  operationalDayKey,
  weekKeyForDay,
} = require('./memory-time.js');
const { normalizeMemoryPolicy } = require('./memory-policy.js');
const {
  createSemanticEntityResolver,
  senderIdFromMessage,
} = require('./semantic-memory-entities.js');

const MODES = new Set(['off', 'shadow', 'cards', 'full']);
const QUEUE_RETRY_BASE_MS = 30_000;
const QUEUE_RETRY_MAX_MS = 60 * 60 * 1000;
const ACTIONABLE_QUEUE_STATUSES = new Set(['pending', 'retry', 'partial_review_pending']);

function queueFileStatSignature(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
      exists: true,
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: Number(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        exists: false,
        dev: null,
        ino: null,
        size: 0,
        mtimeNs: null,
        ctimeNs: null,
      };
    }
    throw error;
  }
}

function sameQueueFileStat(left, right) {
  return Boolean(left && right)
    && left.exists === right.exists
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function incrementQueueStatus(counts, status, amount) {
  const key = String(status || 'unknown');
  const next = Number(counts.get(key) || 0) + amount;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

function buildQueueIndex(records, signature) {
  const latest = new Map();
  const counts = new Map();
  const actionablePacketIds = new Set();
  for (const record of records || []) {
    const packetId = String(record?.packetId || '');
    if (!packetId) continue;
    latest.set(packetId, record);
    incrementQueueStatus(counts, record.status, 1);
    if (ACTIONABLE_QUEUE_STATUSES.has(String(record.status || ''))) {
      actionablePacketIds.add(packetId);
    }
  }
  return { latest, counts, actionablePacketIds, signature };
}

function updateQueueIndex(index, record) {
  const packetId = String(record?.packetId || '');
  if (!packetId) throw new Error('semantic durable queue record 缺少 packetId');
  const prior = index.latest.get(packetId);
  if (prior) {
    incrementQueueStatus(index.counts, prior.status, -1);
    index.actionablePacketIds.delete(packetId);
  }
  index.latest.set(packetId, record);
  incrementQueueStatus(index.counts, record.status, 1);
  if (ACTIONABLE_QUEUE_STATUSES.has(String(record.status || ''))) {
    index.actionablePacketIds.add(packetId);
  }
}

function baseEntitiesFromPolicy(memoryPolicy = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  return [
    {
      entityId: policy.owner.entityId,
      canonicalDisplayName: policy.owner.displayName,
      type: 'person',
    },
    {
      entityId: policy.agent.entityId,
      canonicalDisplayName: policy.agent.displayName,
      type: 'ai',
    },
  ];
}

const BASE_ENTITIES = Object.freeze(baseEntitiesFromPolicy());

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function rawMessageSourceEquivalent(left, right) {
  const leftId = String(left?.messageId || '');
  const rightId = String(right?.messageId || '');
  if (leftId && leftId === rightId) return true;

  const aliasPair = (
    (leftId.startsWith('assistant:') && rightId.startsWith('transcript:assistant:'))
    || (rightId.startsWith('assistant:') && leftId.startsWith('transcript:assistant:'))
  );
  if (!aliasPair) return false;
  if (
    !String(left?.senderEntityId || '')
    || String(left?.senderEntityId || '') !== String(right?.senderEntityId || '')
    || String(left?.conversationId || '') !== String(right?.conversationId || '')
    || String(left?.channel || '') !== String(right?.channel || '')
    || String(left?.chatId || '') !== String(right?.chatId || '')
    || !left?.textSha256
    || String(left.textSha256) !== String(right?.textSha256 || '')
  ) {
    return false;
  }
  const leftAt = Date.parse(left?.sentAt || '');
  const rightAt = Date.parse(right?.sentAt || '');
  return Number.isFinite(leftAt)
    && Number.isFinite(rightAt)
    && Math.abs(leftAt - rightAt) <= 2_000;
}

function analyzePacketSourceCoverage(packet, queueRecords = []) {
  const activeRecords = (queueRecords || []).filter((record) => (
    [
      'pending',
      'retry',
      'partial_review_pending',
      'needs_human_review',
      'completed',
    ].includes(String(record?.status || ''))
  ));
  const rawMessages = packet?.rawMessages || [];
  const coveringPacketIds = new Set();
  let coveredMessages = 0;
  for (const message of rawMessages) {
    let covered = false;
    for (const record of activeRecords) {
      if ((record.packet?.rawMessages || []).some(
        (existing) => rawMessageSourceEquivalent(message, existing),
      )) {
        covered = true;
        coveringPacketIds.add(String(record.packetId));
      }
    }
    if (covered) coveredMessages += 1;
  }
  return {
    status: coveredMessages === 0
      ? 'none'
      : coveredMessages === rawMessages.length
        ? 'full'
        : 'partial',
    totalMessages: rawMessages.length,
    coveredMessages,
    coveringPacketIds: [...coveringPacketIds].sort(),
  };
}

function activeEntityRegistry(entities) {
  return (entities || []).filter((entity) => !entity?.canonicalEntityId);
}

function inspectFullReadiness({
  rounds = [],
  packets = [],
  queueRecords = [],
} = {}) {
  const activeRounds = Array.isArray(rounds) ? rounds : [];
  const packetIds = activeRounds.map((round) => String(round?.semanticPacketId || '').trim());
  const unboundRoundIndexes = packetIds
    .map((packetId, index) => (packetId ? null : index))
    .filter((index) => index !== null);
  const packetUseCounts = new Map();
  for (const packetId of packetIds.filter(Boolean)) {
    packetUseCounts.set(packetId, Number(packetUseCounts.get(packetId) || 0) + 1);
  }
  const duplicatePacketIds = [...packetUseCounts]
    .filter(([, count]) => count > 1)
    .map(([packetId]) => packetId)
    .sort();
  const committedPacketIds = new Set(
    (Array.isArray(packets) ? packets : [])
      .filter((packet) => [
        'committed',
        'committed_after_review',
        'human_resolved',
      ].includes(packet?.status))
      .map((packet) => String(packet.packetId || ''))
      .filter(Boolean),
  );
  const queueStatusByPacketId = new Map(
    (Array.isArray(queueRecords) ? queueRecords : [])
      .map((record) => [
        String(record?.packetId || ''),
        String(record?.status || 'unknown'),
      ])
      .filter(([packetId]) => packetId),
  );
  const uniquePacketIds = [...packetUseCounts.keys()].sort();
  const uncommittedPacketIds = uniquePacketIds
    .filter((packetId) => !committedPacketIds.has(packetId));
  const uncommittedQueueStatus = Object.fromEntries(
    uncommittedPacketIds.map((packetId) => [
      packetId,
      queueStatusByPacketId.get(packetId) || 'missing',
    ]),
  );
  return {
    ready: (
      unboundRoundIndexes.length === 0
      && duplicatePacketIds.length === 0
      && uncommittedPacketIds.length === 0
    ),
    activeRoundCount: activeRounds.length,
    boundRoundCount: activeRounds.length - unboundRoundIndexes.length,
    uniquePacketCount: uniquePacketIds.length,
    unboundRoundIndexes,
    duplicatePacketIds,
    uncommittedPacketIds,
    uncommittedQueueStatus,
  };
}

function latestBy(records, keyOf) {
  const latest = new Map();
  for (const record of records || []) {
    const key = keyOf(record);
    if (!key) continue;
    const existing = latest.get(key);
    const existingAt = Date.parse(existing?.committedAt || existing?.createdAt || '') || 0;
    const candidateAt = Date.parse(record?.committedAt || record?.createdAt || '') || 0;
    if (!existing || candidateAt >= existingAt) latest.set(key, record);
  }
  return [...latest.values()];
}

function projectionText(projection) {
  const humanContent = String(projection?.humanContent || '').trim();
  if (humanContent) return humanContent;
  return (projection?.sentences || [])
    .filter((sentence) => sentence.verificationStatus === 'supported')
    .map((sentence) => String(sentence.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function semanticSentenceKey(sentence) {
  const claimIds = unique(sentence?.supportClaimIds).sort();
  if (claimIds.length) return `claims:${claimIds.join(',')}`;
  const eventIds = unique(sentence?.supportEventIds).sort();
  return `fallback:${stableHash({
    eventIds,
    text: String(sentence?.text || '').trim(),
  })}`;
}

function uniqueSupportedSentences(projection, seenKeys = new Set()) {
  const humanContent = String(projection?.humanContent || '').trim();
  if (humanContent) {
    const localKeys = new Set();
    return humanContent
      .split(/\n+/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => {
        const comparable = text
          .replace(/^[-*+]\s+/u, '')
          .replace(/\s+/gu, ' ')
          .trim();
        const key = `human-text:${stableHash(comparable, 24)}`;
        return { key, text };
      })
      .filter(({ key }) => {
        if (seenKeys.has(key) || localKeys.has(key)) return false;
        localKeys.add(key);
        return true;
      })
      .map(({ key, text }) => ({
        sentence: {
          sentenceId: `sentence:${stableHash({ key, text })}`,
          text,
          supportClaimIds: [],
          supportEventIds: [],
          verificationStatus: 'supported',
          verificationMode: 'human-period-override',
        },
        key,
        text,
      }));
  }
  const uniqueSentences = [];
  const localKeys = new Set();
  for (const sentence of projection?.sentences || []) {
    if (sentence?.verificationStatus !== 'supported') continue;
    const text = String(sentence.text || '').trim();
    if (!text) continue;
    const key = semanticSentenceKey(sentence);
    if (seenKeys.has(key) || localKeys.has(key)) continue;
    localKeys.add(key);
    uniqueSentences.push({ sentence, key, text });
  }
  return uniqueSentences;
}

function safeFileSegment(value) {
  return String(value || 'unknown')
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

function markdownForProjection(projection) {
  const supportClaimIds = unique(projection.supportClaimIds);
  const supportEventIds = unique(projection.supportEventIds);
  return [
    '---',
    `projectionId: ${JSON.stringify(projection.projectionId)}`,
    `projectionType: ${JSON.stringify(projection.projectionType)}`,
    `status: ${JSON.stringify(projection.status)}`,
    `createdAt: ${JSON.stringify(projection.createdAt)}`,
    `periodKey: ${JSON.stringify(projection.period?.key || null)}`,
    `packetId: ${JSON.stringify(projection.packetId || null)}`,
    `supportClaimIds: ${JSON.stringify(supportClaimIds)}`,
    `supportEventIds: ${JSON.stringify(supportEventIds)}`,
    'editableVia: Memory Hub HumanPatch',
    '---',
    '',
    `# ${projection.title}`,
    '',
    projectionText(projection) || '（本投影没有通过核验的持久语义句。）',
    '',
  ].join('\n');
}

function atomicWritePrivateText(filePath, text) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  let directoryFd;
  try {
    directoryFd = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(directoryFd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

function dynamicEntityId(message, entityResolver = null) {
  const canonical = entityResolver?.canonicalEntityIdForMessage(message);
  if (canonical) return canonical;
  if (message.senderId) return `telegram-user:${String(message.senderId)}`;
  return `source-actor:${stableHash({
    name: message.senderDisplayName || message.senderName || 'unknown',
    channel: message.channel || 'unknown',
  }, 20)}`;
}

class SemanticMemoryManager {
  constructor({
    directory,
    mode = 'off',
    entities = null,
    memoryPolicy = {},
    extract,
    verify,
    verifyHighRisk,
    render = null,
    verifySentence = null,
    extractorModel = 'unknown',
    extractorPromptVersion = 'semantic-extractor-v1',
    recentWeekCount = 4,
    contextTokenBudget = 180_000,
    manifestMaxRecords = DEFAULT_MANIFEST_MAX_RECORDS,
    manifestMaxBytes = DEFAULT_MANIFEST_MAX_BYTES,
    estimateTokens = (text) => Math.ceil(String(text || '').length / 2),
    clock = () => new Date().toISOString(),
    log = console.log,
    testHooks = null,
    storeType = null,
    humanResolutionLabel = null,
  } = {}) {
    if (!MODES.has(String(mode))) throw new Error(`未知 semantic memory mode：${mode}`);
    if (!directory) throw new Error('SemanticMemoryManager 缺少 directory');
    this.directory = path.resolve(directory);
    this.mode = String(mode);
    this.memoryPolicy = normalizeMemoryPolicy(memoryPolicy);
    this.clock = clock;
    this.log = log;
    this.testHooks = testHooks;
    this.recentWeekCount = Math.max(1, Number(recentWeekCount) || 4);
    this.contextTokenBudget = Math.max(1000, Number(contextTokenBudget) || 180_000);
    this.manifestMaxRecords = Math.max(1, Number(manifestMaxRecords) || DEFAULT_MANIFEST_MAX_RECORDS);
    this.manifestMaxBytes = Math.max(1024, Number(manifestMaxBytes) || DEFAULT_MANIFEST_MAX_BYTES);
    this.estimateTokens = estimateTokens;
    this.queueFile = path.join(this.directory, 'inbox.jsonl');
    this.queueStateFile = path.join(this.directory, 'inbox-state.json');
    this.compileManifestFile = path.join(this.directory, 'compile-manifests.jsonl');
    this.baseEntities = (entities || baseEntitiesFromPolicy(this.memoryPolicy))
      .map((entity) => ({ ...entity }));
    this.entityResolver = createSemanticEntityResolver({ entities: this.baseEntities });
    this.store = new SemanticMemoryStore({
      directory: this.directory,
      mode: this.mode,
      storeType: storeType || this.memoryPolicy.records.semanticStoreType,
      humanResolutionLabel: humanResolutionLabel
        || this.memoryPolicy.records.humanResolutionLabel,
      clock,
      log,
    });
    this.store.initialize({ entities: this.baseEntities });
    this.sourceEntities = this.store.entities().entities || this.baseEntities;
    this.entities = activeEntityRegistry(this.sourceEntities);
    this.pipeline = new SemanticMemoryPipeline({
      store: this.store,
      entities: this.entities,
      sourceEntities: this.sourceEntities,
      extract,
      verify,
      verifyHighRisk,
      extractorModel,
      extractorPromptVersion,
      requireSecondaryHighRisk: true,
      memoryPolicy: this.memoryPolicy,
      clock,
      log,
    });
    this.projections = new SemanticProjectionBuilder({
      store: this.store,
      render,
      verifySentence,
      memoryPolicy: this.memoryPolicy,
      clock,
      log,
    });
    this._maintenance = null;
    this._queueIndexCache = null;
  }

  enabled() {
    return this.mode !== 'off';
  }

  effectiveCards() {
    return this.mode === 'cards' || this.mode === 'full';
  }

  effectiveVerifiedFold() {
    return this.mode === 'full';
  }

  _queue() {
    return [...this._queueIndex().latest.values()];
  }

  queueStatus() {
    const index = this._queueIndex();
    return {
      total: index.latest.size,
      actionable: index.actionablePacketIds.size,
      counts: Object.fromEntries(index.counts),
      earliestRetryAt: this.earliestPendingRetryAt(),
    };
  }

  _queueIndex() {
    const current = queueFileStatSignature(this.queueFile);
    if (
      this._queueIndexCache
      && sameQueueFileStat(this._queueIndexCache.signature, current)
    ) {
      return this._queueIndexCache;
    }
    const reason = this._queueIndexCache ? 'external-change' : 'cold-start';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = queueFileStatSignature(this.queueFile);
      let records;
      try {
        records = readLatestJsonl(this.queueFile, 'packetId');
      } catch (error) {
        const afterFailure = queueFileStatSignature(this.queueFile);
        if (!sameQueueFileStat(before, afterFailure)) continue;
        throw error;
      }
      const after = queueFileStatSignature(this.queueFile);
      if (!sameQueueFileStat(before, after)) continue;
      this._queueIndexCache = buildQueueIndex(records, after);
      if (typeof this.testHooks?.onQueueFullScan === 'function') {
        this.testHooks.onQueueFullScan({
          filePath: this.queueFile,
          reason,
          attempt,
          bytes: after.size,
          records: records.length,
        });
      }
      return this._queueIndexCache;
    }
    const error = new Error('inbox.jsonl 在读取期间持续变化，拒绝使用可能撕裂的索引');
    error.code = 'SEMANTIC_MEMORY_QUEUE_RACE';
    throw error;
  }

  _writeQueueState(index = this._queueIndex()) {
    atomicWriteJson(this.queueStateFile, {
      schemaVersion: 1,
      updatedAt: this.clock(),
      counts: Object.fromEntries(index.counts),
    });
    if (typeof this.testHooks?.onQueueStateWrite === 'function') {
      this.testHooks.onQueueStateWrite({ counts: Object.fromEntries(index.counts) });
    }
  }

  _queueRecord(packetId) {
    return this._queueIndex().latest.get(String(packetId || '')) || null;
  }

  _appendQueueRecords(records, { writeState = true } = {}) {
    const candidates = records || [];
    const index = this._queueIndex();
    if (!candidates.length) {
      if (writeState) this._writeQueueState(index);
      return 0;
    }
    const before = index.signature;
    let bytesWritten = 0;
    for (const record of candidates) bytesWritten += appendFsynced(this.queueFile, record);
    const after = queueFileStatSignature(this.queueFile);
    const expectedSize = Number(before?.size || 0) + bytesWritten;
    const identityPreserved = before.exists
      ? after.exists && before.dev === after.dev && before.ino === after.ino
      : after.exists;
    let effectiveIndex;
    if (!identityPreserved || after.size !== expectedSize) {
      this._queueIndexCache = null;
      effectiveIndex = this._queueIndex();
    } else {
      for (const record of candidates) updateQueueIndex(index, record);
      index.signature = after;
      effectiveIndex = index;
      if (typeof this.testHooks?.onQueueIncrement === 'function') {
        this.testHooks.onQueueIncrement({ records: candidates.length });
      }
    }
    if (writeState) this._writeQueueState(effectiveIndex);
    return candidates.length;
  }

  _appendQueue(record) {
    return this._appendQueueRecords([{
      schemaVersion: 1,
      ...record,
      updatedAt: this.clock(),
    }]);
  }

  _ensureEntities(rawMessages) {
    const sourceEntities = this.store.withLock(() => {
      const current = this.store.entities();
      const byId = new Map(
        (current.entities || []).map((entity) => [String(entity.entityId), entity]),
      );
      let changed = false;
      for (const [entityId, entity] of byId) {
        const match = entityId.match(/^telegram-user:(\d+)$/);
        const canonicalEntityId = match
          ? this.entityResolver.canonicalTelegramEntityId(match[1])
          : null;
        if (!canonicalEntityId) continue;
        const aliases = unique([
          ...(entity.aliasDisplayNames || []),
          entity.canonicalDisplayName,
        ]);
        const next = {
          ...entity,
          canonicalEntityId,
          canonicalDisplayName: this.entityResolver.canonicalDisplayName(canonicalEntityId),
          aliasDisplayNames: aliases,
        };
        if (JSON.stringify(next) !== JSON.stringify(entity)) {
          byId.set(entityId, next);
          changed = true;
        }
      }
      for (const message of rawMessages || []) {
        const entityId = dynamicEntityId(message, this.entityResolver);
        message.senderEntityId = entityId;
        const senderId = senderIdFromMessage(message);
        const displayName = String(
          message.senderDisplayName || message.senderName || entityId,
        );
        if (byId.has(entityId)) {
          const existing = byId.get(entityId);
          const next = {
            ...existing,
            canonicalDisplayName: this.entityResolver.canonicalDisplayName(
              entityId,
              existing.canonicalDisplayName || displayName,
            ),
            sourceIds: unique([
              ...(existing.sourceIds || []),
              ...(senderId ? [`telegram:${senderId}`] : []),
            ]),
            aliasDisplayNames: unique([
              ...(existing.aliasDisplayNames || []),
              ...(displayName && displayName !== this.entityResolver.canonicalDisplayName(entityId)
                ? [displayName]
                : []),
            ]),
          };
          if (JSON.stringify(next) !== JSON.stringify(existing)) {
            byId.set(entityId, next);
            changed = true;
          }
          continue;
        }
        byId.set(entityId, {
          entityId,
          canonicalDisplayName: this.entityResolver.canonicalDisplayName(entityId, displayName),
          type: message.senderIsBot ? 'ai_or_bot' : 'person_or_account',
          sourceIds: senderId ? [`telegram:${senderId}`] : [],
          aliasDisplayNames: [],
          createdAt: this.clock(),
        });
        changed = true;
      }
      const next = [...byId.values()];
      if (changed || next.length !== (current.entities || []).length) {
        atomicWriteJson(this.store.paths.entities, {
          schemaVersion: 1,
          entities: next,
          updatedAt: this.clock(),
        });
      }
      return next;
    });
    this.sourceEntities = sourceEntities;
    this.entities = activeEntityRegistry(sourceEntities);
    this.pipeline.sourceEntities = sourceEntities;
    this.pipeline.entities = this.entities;
    return this.entities;
  }

  enqueue(packetInput) {
    if (!this.enabled()) return { status: 'disabled', packetId: null };
    const rawMessages = (packetInput.rawMessages || []).map((message) => ({ ...message }));
    this._ensureEntities(rawMessages);
    const packet = createSemanticPacket({ ...packetInput, rawMessages });
    const existing = this._queueRecord(packet.packetId);
    if (['completed', 'needs_human_review'].includes(existing?.status)) {
      return { status: 'completed', packetId: packet.packetId, duplicate: true };
    }
    if (['pending', 'retry', 'partial_review_pending'].includes(existing?.status)) {
      return { status: existing.status, packetId: packet.packetId, duplicate: true };
    }
    this._appendQueue({
      packetId: packet.packetId,
      status: 'pending',
      attempts: 0,
      nextRetryAt: null,
      packet,
      queueClass: 'live',
    });
    return { status: 'pending', packetId: packet.packetId, duplicate: false };
  }

  enqueueMany(packetInputs, {
    queueClass = 'historical',
  } = {}) {
    if (!this.enabled()) return { status: 'disabled', queued: 0, duplicates: 0 };
    if (!['live', 'rebuild-priority', 'historical'].includes(queueClass)) {
      throw new Error(`未知 semantic queueClass：${queueClass}`);
    }
    const prepared = (packetInputs || []).map((packetInput) => ({
      ...packetInput,
      rawMessages: (packetInput.rawMessages || []).map((message) => ({ ...message })),
    }));
    const packets = prepared.map((packetInput) => createSemanticPacket(packetInput));
    const queueRecords = this._queue();
    const existing = new Map(queueRecords.map(
      (record) => [String(record.packetId), record],
    ));
    const coverageByPacketId = new Map();
    const overlapConflicts = [];
    for (const packet of packets) {
      const current = existing.get(packet.packetId);
      if (current && [
        'pending',
        'retry',
        'partial_review_pending',
        'needs_human_review',
        'completed',
      ].includes(current.status)) continue;
      const coverage = analyzePacketSourceCoverage(packet, queueRecords);
      coverageByPacketId.set(packet.packetId, coverage);
      if (coverage.status === 'partial') {
        overlapConflicts.push({
          packetId: packet.packetId,
          totalMessages: coverage.totalMessages,
          coveredMessages: coverage.coveredMessages,
          coveringPacketIds: coverage.coveringPacketIds,
        });
      }
    }
    if (overlapConflicts.length) {
      const error = new Error(
        'semantic 历史导入与现有 durable source 部分重叠；已在写入前拒绝',
      );
      error.code = 'SEMANTIC_SOURCE_OVERLAP_CONFLICT';
      error.details = overlapConflicts;
      throw error;
    }
    this._ensureEntities(
      packets
        .filter((packet) => coverageByPacketId.get(packet.packetId)?.status !== 'full')
        .flatMap((packet) => packet.rawMessages),
    );
    let queued = 0;
    let duplicates = 0;
    let sourceDuplicates = 0;
    let promoted = 0;
    const appendRecords = [];
    const queueRank = { live: 0, 'rebuild-priority': 1, historical: 2 };
    for (const packet of packets) {
      const current = existing.get(packet.packetId);
      if (current && [
        'pending',
        'retry',
        'partial_review_pending',
        'needs_human_review',
        'completed',
      ].includes(current.status)) {
        if (
          current.status !== 'completed'
          && queueRank[queueClass] < queueRank[current.queueClass || 'live']
        ) {
          const upgraded = {
            ...current,
            queueClass,
            updatedAt: this.clock(),
          };
          appendRecords.push(upgraded);
          existing.set(packet.packetId, upgraded);
          promoted += 1;
          continue;
        }
        duplicates += 1;
        continue;
      }
      if (coverageByPacketId.get(packet.packetId)?.status === 'full') {
        sourceDuplicates += 1;
        continue;
      }
      const record = {
        schemaVersion: 1,
        packetId: packet.packetId,
        status: 'pending',
        attempts: 0,
        nextRetryAt: null,
        packet,
        queueClass,
        updatedAt: this.clock(),
      };
      appendRecords.push(record);
      existing.set(packet.packetId, record);
      queued += 1;
    }
    this._appendQueueRecords(appendRecords);
    return {
      status: 'pending',
      queued,
      duplicates,
      sourceDuplicates,
      overlapConflicts: 0,
      promoted,
      queueClass,
    };
  }

  _nextPending({ packetIds = null } = {}) {
    const index = this._queueIndex();
    const candidateIds = packetIds
      ? unique(packetIds)
      : index.actionablePacketIds;
    const now = Date.now();
    let best = null;
    const compare = (left, right) => (
      (
        (left.status === 'partial_review_pending' ? 1 : 0)
        - (right.status === 'partial_review_pending' ? 1 : 0)
      )
      ||
      (
        { live: 0, 'rebuild-priority': 1, historical: 2 }[left.queueClass || 'live']
        - { live: 0, 'rebuild-priority': 1, historical: 2 }[right.queueClass || 'live']
      )
      || (
        Date.parse(left.updatedAt || left.packet?.occurredFrom || '')
        - Date.parse(right.updatedAt || right.packet?.occurredFrom || '')
      )
    );
    for (const packetId of candidateIds) {
      const record = index.latest.get(String(packetId));
      const retryDue = !record?.nextRetryAt
        || Date.parse(record.nextRetryAt) <= now;
      if (
        !record
        || !ACTIONABLE_QUEUE_STATUSES.has(String(record.status || ''))
        || !retryDue
      ) continue;
      if (!best || compare(record, best) < 0) best = record;
    }
    return best;
  }

  async _processQueueRecord(record) {
    const reviewingPartial = record.status === 'partial_review_pending'
      || record.reviewPhase === true;
    try {
      const priorPacket = reviewingPartial
        ? this.store.packet(record.packetId, { applyReviews: false })
        : null;
      const priorFailures = reviewingPartial
        ? this.store.failures().filter((failure) => (
            String(failure.packetId) === String(record.packetId)
            && Number(failure.reviewAttempt || 0) === 0
          ))
        : [];
      const result = await this.pipeline.processPacket(
        record.packet,
        reviewingPartial
          ? {
              reviewAttempt: 1,
              priorFailures,
              supersedesTransactionId: priorPacket?.transactionId || null,
            }
          : {},
      );
      const packetId = record.packetId;
      const dayKey = operationalDayKey(record.packet.occurredTo, this.memoryPolicy.time);
      const weekKey = weekKeyForDay(dayKey);
      const [fold, day, week] = await this.projections.buildMany([
        { kind: 'fold', packetId },
        { kind: 'day', periodKey: dayKey },
        { kind: 'week', periodKey: weekKey },
      ]);
      for (const projection of [fold, day, week]) this.materialize(projection);
      if (!reviewingPartial && result.status === 'partial') {
        this._appendQueue({
          ...record,
          status: 'partial_review_pending',
          attempts: Number(record.attempts || 0) + 1,
          reviewAttempts: 0,
          nextRetryAt: null,
          partialDetectedAt: this.clock(),
          result: {
            status: result.status,
            transactionId: result.transactionId,
            projectionIds: [fold.projectionId, day.projectionId, week.projectionId],
          },
        });
        return {
          status: 'partial-review-queued',
          packetId,
          pipelineStatus: result.status,
          projections: [fold, day, week],
        };
      }
      const reviewNoSignalConflict = reviewingPartial
        && result.packetManifest?.extractorNoSignal === true;
      if (reviewingPartial && (result.status !== 'committed' || reviewNoSignalConflict)) {
        this._appendQueue({
          ...record,
          status: 'needs_human_review',
          attempts: Number(record.attempts || 0) + 1,
          reviewAttempts: 1,
          nextRetryAt: null,
          reviewCompletedAt: this.clock(),
          result: {
            status: result.status,
            reviewId: result.review?.reviewId || null,
            reviewNoSignalConflict,
            projectionIds: [fold.projectionId, day.projectionId, week.projectionId],
          },
        });
        return {
          status: 'needs-human-review',
          packetId,
          pipelineStatus: result.status,
          reviewNoSignalConflict,
          projections: [fold, day, week],
        };
      }
      this._appendQueue({
        ...record,
        status: 'completed',
        attempts: Number(record.attempts || 0) + 1,
        nextRetryAt: null,
        completedAt: this.clock(),
        result: {
          status: reviewingPartial ? 'committed_after_review' : result.status,
          reviewId: result.review?.reviewId || null,
          projectionIds: [fold.projectionId, day.projectionId, week.projectionId],
        },
      });
      return {
        status: 'generated',
        packetId,
        pipelineStatus: reviewingPartial ? 'committed_after_review' : result.status,
        projections: [fold, day, week],
      };
    } catch (error) {
      const attempts = Number(record.attempts || 0) + 1;
      const retryMs = Math.min(
        QUEUE_RETRY_MAX_MS,
        QUEUE_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 7)),
      );
      this._appendQueue({
        ...record,
        status: reviewingPartial ? 'partial_review_pending' : 'retry',
        reviewPhase: reviewingPartial,
        attempts,
        nextRetryAt: new Date(Date.now() + retryMs).toISOString(),
        lastError: String(error.message || error),
      });
      error.semanticPacketId = record.packetId;
      throw error;
    }
  }

  // 队列里尚未到期的最早重试时间。scheduler 用它决定「现在没活干，但过一会儿
  // 有」时该睡多久：固定 30 秒的重试 timer 只覆盖第一次失败，退避一旦翻到
  // 60 秒以上，醒来时 _nextPending 仍然为空，worker 就此睡死，那个包只能等下
  // 一条真实消息把它顺带唤醒——深夜无消息时会挂起数小时。
  earliestPendingRetryAt() {
    const index = this._queueIndex();
    let earliest = Infinity;
    for (const packetId of index.actionablePacketIds) {
      const value = Date.parse(index.latest.get(packetId)?.nextRetryAt || '');
      if (Number.isFinite(value) && value < earliest) earliest = value;
    }
    return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
  }

  async maintainOne() {
    if (!this.enabled()) return { status: 'disabled' };
    if (this._maintenance) return { status: 'busy' };
    const record = this._nextPending();
    if (!record) return { status: 'idle', nextRetryAt: this.earliestPendingRetryAt() };
    this._maintenance = this._processQueueRecord(record);
    try {
      return await this._maintenance;
    } finally {
      this._maintenance = null;
    }
  }

  queuePartialReview(packetId) {
    const id = String(packetId || '');
    if (!id) throw new Error('partial review 缺少 packetId');
    if (this._maintenance) {
      return { status: 'busy', packetId: id, duplicate: false };
    }
    const packet = this.store.packet(id, { applyReviews: false });
    if (!packet) throw new Error(`semantic packet 不存在：${id}`);
    if (packet.status !== 'partial') {
      return { status: 'not-partial', packetId: id, duplicate: true };
    }
    const reviews = this.store.packetReviews().filter((review) => String(review.packetId) === id);
    if (reviews.some((review) => Number(review.reviewAttempt || 0) >= 1)) {
      return { status: 'already-reviewed', packetId: id, duplicate: true };
    }
    const existing = this._queueRecord(id);
    if (!existing?.packet) throw new Error(`semantic packet 缺少 durable queue source：${id}`);
    this._appendQueue({
      ...existing,
      status: 'partial_review_pending',
      nextRetryAt: null,
      reviewAttempts: 0,
      reviewQueuedAt: this.clock(),
    });
    return { status: 'partial-review-pending', packetId: id, duplicate: false };
  }

  async ensurePackets(packetIds) {
    const wanted = unique(packetIds);
    for (const packetId of wanted) {
      while (!['committed', 'committed_after_review', 'human_resolved'].includes(
        this.store.packet(packetId)?.status,
      )) {
        const record = this._nextPending({ packetIds: [packetId] });
        if (!record) {
          const queued = this._queueRecord(packetId);
          if (queued?.status === 'retry') {
            throw new Error(`semantic packet ${packetId} 正在退避：${queued.lastError || 'unknown'}`);
          }
          throw new Error(`semantic packet ${packetId} 未入队或原始来源缺失`);
        }
        await this._processQueueRecord(record);
      }
    }
  }

  async foldRounds(rounds) {
    if (!this.effectiveVerifiedFold()) {
      throw new Error('verified fold 仅在 semanticMemoryMode=full 生效');
    }
    const packetIds = unique((rounds || []).map((round) => round.semanticPacketId));
    if (packetIds.length !== (rounds || []).length) {
      throw new Error('待折叠轮次存在未绑定 semantic packet 的旧轮次');
    }
    await this.ensurePackets(packetIds);
    const projection = await this.projections.build({
      kind: 'fold',
      packetIds,
      periodKey: `rounds-${stableHash(packetIds, 20)}`,
    });
    this.materialize(projection);
    const packets = packetIds.map((packetId) => this.store.packet(packetId)).filter(Boolean);
    const verifiedNoSignal = projection.status === 'unverified_index'
      && packets.length === packetIds.length
      && packets.every((packet) => (
        ['committed', 'committed_after_review', 'human_resolved'].includes(packet.status)
        && packet.extractorNoSignal === true
        && Number(packet.counts?.candidates || 0) === 0
        && Number(packet.counts?.claims || 0) === 0
        && Number(packet.counts?.events || 0) === 0
        && Number(packet.counts?.failures || 0) === 0
      ));
    if (projection.status !== 'accepted' && !verifiedNoSignal) {
      throw new Error('本批没有可安全折叠的已核验投影，也不是已核验 no-signal');
    }
    return {
      status: verifiedNoSignal ? 'accepted_no_signal' : 'accepted',
      projection,
      text: verifiedNoSignal
        ? '【已核验：本批没有需要进入长期记忆的语义信号；原始对话仍保存在 append-only 档案中。】'
        : projectionText(projection),
    };
  }

  invalidatePacket(packetId, reason = 'source_turn_rewound') {
    if (!this.enabled() || !packetId) return { status: 'disabled', patches: [] };
    const targetClaims = this.store.claims({ applyPatches: false })
      .filter((claim) => String(claim.packetId) === String(packetId));
    const patches = [];
    for (const claim of targetClaims) {
      const patch = {
        patchId: `patch:${stableHash({
          packetId,
          targetId: claim.claimId,
          operation: 'invalidate',
          reason,
        })}`,
        targetType: 'claim',
        targetId: claim.claimId,
        operation: 'invalidate',
        reason: String(reason),
        author: 'bridge-native-rewind',
        createdAt: this.clock(),
      };
      this.store.appendPatch(patch);
      patches.push(patch.patchId);
    }
    const queued = this._queueRecord(packetId);
    if (queued && queued.status !== 'completed') {
      this._appendQueue({
        ...queued,
        status: 'cancelled',
        cancelledAt: this.clock(),
        cancelReason: String(reason),
      });
    }
    return {
      status: patches.length ? 'invalidated' : 'no_claims',
      packetId,
      patches,
    };
  }

  materialize(projection) {
    const effectiveProjection = this.store.projections()
      .find((candidate) => candidate.projectionId === projection.projectionId)
      || projection;
    const folder = effectiveProjection.projectionType === 'day'
      ? this.memoryPolicy.files.dayDirectory
      : effectiveProjection.projectionType === 'week'
        ? this.memoryPolicy.files.weekDirectory
        : this.memoryPolicy.files.foldDirectory;
    const key = effectiveProjection.period?.key
      || effectiveProjection.packetId
      || effectiveProjection.projectionId;
    const filePath = path.join(this.directory, folder, `${safeFileSegment(key)}.md`);
    atomicWritePrivateText(filePath, markdownForProjection(effectiveProjection));
    return filePath;
  }

  compile({ reservedTokens = 0, archiveText = '', archiveBlocks = [] } = {}) {
    if (!this.effectiveCards()) return null;
    const compiledAt = this.clock();
    const currentDay = operationalDayKey(compiledAt, this.memoryPolicy.time);
    const currentWeek = weekKeyForDay(currentDay);
    const latest = latestBy(
      this.store.projections().filter((projection) => (
        projection.status === 'accepted'
        && projection.stale !== true
        && ['day', 'week'].includes(projection.projectionType)
      )),
      (projection) => `${projection.projectionType}:${projection.period?.key || ''}`,
    );
    const weeks = latest
      .filter((projection) => (
        projection.projectionType === 'week'
        && String(projection.period?.key || '') < currentWeek
      ))
      .sort((a, b) => String(b.period?.key || '').localeCompare(String(a.period?.key || '')))
      .slice(0, this.recentWeekCount);
    const days = latest
      .filter((projection) => (
        projection.projectionType === 'day'
        && String(projection.period?.key || '') >= currentWeek
        && String(projection.period?.key || '') <= currentDay
      ))
      .sort((a, b) => String(a.period?.key || '').localeCompare(String(b.period?.key || '')));
    const candidates = [...weeks.reverse(), ...days];
    const normalizedReservedTokens = Math.max(0, Number(reservedTokens) || 0);
    const normalizedArchiveText = String(archiveText || '').trim();
    const normalizedArchiveBlocks = (Array.isArray(archiveBlocks) ? archiveBlocks : [])
      .filter((block) => block && String(block.text || '').trim())
      .map((block) => ({
        blockId: String(block.id || `archive:${stableHash(block, 24)}`),
        layer: 'archive',
        kind: String(block.kind || 'card'),
        cardType: ['day', 'week'].includes(block.cardType) ? block.cardType : null,
        periodKey: block.periodKey || null,
        title: block.label || null,
        text: String(block.text || '').trim(),
        tokenEstimate: Math.max(0, Number(block.tokenEstimate) || this.estimateTokens(block.text)),
      }));
    const archiveTokens = normalizedArchiveText ? this.estimateTokens(normalizedArchiveText) : 0;
    const selected = [];
    const selectedSentenceKeys = new Set();
    const duplicateOnlyProjectionIds = [];
    let usedTokens = 0;
    for (const projection of candidates.reverse()) {
      const uniqueSentences = uniqueSupportedSentences(projection, selectedSentenceKeys);
      if (!uniqueSentences.length) {
        duplicateOnlyProjectionIds.push(projection.projectionId);
        continue;
      }
      const section = [
        `【${projection.projectionType === 'week' ? '已核验周卡' : '已核验日卡'} ${projection.period?.key || ''}】`,
        uniqueSentences.map((item) => item.text).join('\n'),
      ].join('\n');
      const tokens = this.estimateTokens(section);
      selected.push({
        projection,
        section,
        tokens,
        sentenceKeys: uniqueSentences.map((item) => item.key),
        sentences: uniqueSentences.map((item) => item.text),
      });
      uniqueSentences.forEach((item) => selectedSentenceKeys.add(item.key));
      usedTokens += tokens;
    }
    selected.reverse();
    const projectionIds = selected.map((item) => item.projection.projectionId);
    const verifiedText = selected.map((item) => item.section).join('\n\n');
    const verifiedPreamble = verifiedText
      ? '【可核验纠错锚点·高优先级】\n'
        + '以下句子有 claim/event 证据支持；如与上方完整卡叙述冲突，'
        + '冲突部分以本层为准，未覆盖的完整卡细节继续保留。'
      : '';
    const combinedText = [
      normalizedArchiveText,
      verifiedText ? `${verifiedPreamble}\n${verifiedText}` : '',
    ].filter(Boolean).join('\n\n');
    const verifiedPreambleTokens = verifiedPreamble
      ? this.estimateTokens(verifiedPreamble)
      : 0;
    const totalUsedTokens = archiveTokens + verifiedPreambleTokens + usedTokens;
    const totalTokens = normalizedReservedTokens + totalUsedTokens;
    const overBudget = totalTokens > this.contextTokenBudget;
    const manifest = {
      type: 'semantic-memory-context-manifest',
      schemaVersion: 3,
      compiledAt,
      mode: this.mode,
      contextLayout: normalizedArchiveBlocks.length
        ? 'full-archive-plus-verified-corrections'
        : 'verified-projections-only',
      currentDay,
      currentWeek,
      selectedArchiveBlockIds: normalizedArchiveBlocks.map((block) => block.blockId),
      selectedProjectionIds: projectionIds,
      duplicateOnlyProjectionIds,
      blocks: [
        ...normalizedArchiveBlocks,
        ...selected.map((item) => ({
          blockId: item.projection.projectionId,
          layer: 'verified',
          kind: 'projection',
          cardType: item.projection.projectionType,
          projectionId: item.projection.projectionId,
          projectionType: item.projection.projectionType,
          periodKey: item.projection.period?.key || null,
          title: item.projection.title || null,
          text: item.section,
          sentences: item.sentences,
          tokenEstimate: item.tokens,
        })),
      ],
      archiveBlockCount: normalizedArchiveBlocks.length,
      archiveTokens,
      verifiedBlockCount: selected.length,
      verifiedPreambleTokens,
      uniqueSentenceCount: selectedSentenceKeys.size,
      usedTokens: totalUsedTokens,
      reservedTokens: normalizedReservedTokens,
      totalTokens,
      tokenBudget: this.contextTokenBudget,
      overBudget,
    };
    appendBoundedJsonl(this.compileManifestFile, manifest, {
      maxRecords: this.manifestMaxRecords,
      maxBytes: this.manifestMaxBytes,
    });
    if (overBudget) {
      this.log(
        `[semantic-memory] 分层上下文超过水位：${totalTokens}/${this.contextTokenBudget} tokens；`
        + '已完整保留并写入 compile manifest，没有静默裁剪',
      );
    }
    return {
      text: combinedText,
      archiveBlockIds: normalizedArchiveBlocks.map((block) => block.blockId),
      projectionIds,
      duplicateOnlyProjectionIds,
      uniqueSentenceCount: selectedSentenceKeys.size,
      usedTokens: totalUsedTokens,
      archiveTokens,
      verifiedTokens: verifiedPreambleTokens + usedTokens,
      reservedTokens: normalizedReservedTokens,
      totalTokens,
      budget: this.contextTokenBudget,
      overBudget,
      manifest,
    };
  }
}

module.exports = {
  BASE_ENTITIES,
  MODES,
  SemanticMemoryManager,
  activeEntityRegistry,
  atomicWritePrivateText,
  dynamicEntityId,
  createSemanticEntityResolver,
  inspectFullReadiness,
  analyzePacketSourceCoverage,
  markdownForProjection,
  projectionText,
  rawMessageSourceEquivalent,
  safeFileSegment,
};
