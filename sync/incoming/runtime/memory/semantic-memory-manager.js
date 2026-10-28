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
  verifyClaimsInMicroBatches,
} = require('./semantic-memory-batch-verifier.js');
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
  addDays,
  operationalDayKey,
  weekKeyForDay,
} = require('./memory-time.js');
const { normalizeMemoryPolicy } = require('./memory-policy.js');
const {
  createSemanticEntityResolver,
  senderIdFromMessage,
} = require('./semantic-memory-entities.js');
const { sha256Text } = require('./semantic-memory-validators.js');

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
  if (leftId && leftId === rightId) {
    return sameRawMessageScope(left, right) && rawMessageTextHash(left) === rawMessageTextHash(right);
  }

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

function sameRawMessageScope(left, right) {
  return String(left?.conversationId || '') === String(right?.conversationId || '')
    && String(left?.channel || '') === String(right?.channel || '')
    && String(left?.chatId || '') === String(right?.chatId || '');
}

function rawMessageTextHash(message) {
  return String(message?.textSha256 || sha256Text(String(message?.text || '')));
}

function rawMessageIdConflict(left, right) {
  return Boolean(left?.messageId && String(left.messageId) === String(right?.messageId || ''))
    && sameRawMessageScope(left, right)
    && rawMessageTextHash(left) !== rawMessageTextHash(right);
}

function scopedSourceId(message) {
  return JSON.stringify([
    message?.conversationId || '', message?.channel || '', message?.chatId || '',
    message?.messageId || '',
  ]);
}

function scopedAssistantAlias(message) {
  const id = String(message?.messageId || '');
  const canonicalId = id.startsWith('transcript:assistant:')
    ? id.slice('transcript:'.length)
    : id.startsWith('assistant:') ? id : null;
  if (!canonicalId) return null;
  return JSON.stringify([
    message?.conversationId || '', message?.channel || '', message?.chatId || '',
    canonicalId, message?.senderEntityId || '', rawMessageTextHash(message),
  ]);
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
    verifyBatch = null,
    verifyHighRisk,
    verifyHighRiskBatch = null,
    verifierMode = 'serial',
    batchMaxClaims = 4,
    batchMaxVerdictFields = 20,
    batchHighRisk = false,
    render = null,
    verifySentence = null,
    extractorModel = 'unknown',
    extractorPromptVersion = 'semantic-extractor-v1',
    recentWeekCount = 4,
    verifiedRecentWeekCount = 0,
    verifiedCurrentWeekDays = false,
    verifyPolicy = 'eager',
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
    // 按需核验（B 档）。
    //
    // 起因是核验一直在后台花钱。查下来真相比「太频繁」更尴尬：**这条流水线的产物当时没有消费者**——
    // 9/2 把投影层撤出每轮上下文之后，核验结果既不进 system prompt
    // （连续 42 次编译的 verifiedPreambleTokens / uniqueSentenceCount 全是 0），
    // 也不参与折叠（verified fold 只在 mode=full 生效，实际跑的是 cards）。
    // 唯一出口是 memory_lookup_verified 这个要主动调的工具，日志里 8 次。
    // 也就是说每天 600+ 次核验，是在为一个几乎没人按的按钮做预先全量体检。
    //
    // 'eager'（旧行为）：任何时候队列里有包就抽取+核验，攒多少消化多少。
    // 'on-demand'：平时一个包都不动；只有被 requestPeriod() 点名的时段才消化。
    // 抽取与核验逻辑、fail-closed 契约、投影构建全部不动——改的只是「什么时候开工」。
    // 数据一条不丢：inbox.jsonl 是 durable 的，包一直排队等着，随时可以补跑。
    this.verifyPolicy = verifyPolicy === 'on-demand' ? 'on-demand' : 'eager';
    this._requestedPeriods = new Set();
    // 可核验层单独的「带几周周投影」，缺省 0 = 不带（见 compile() 里的长注释）。
    // 与上面的 recentWeekCount（完整卡层带几周周卡）是两件事，不要混。
    this.verifiedRecentWeekCount = Math.max(
      0,
      Number.isFinite(Number(verifiedRecentWeekCount)) ? Number(verifiedRecentWeekCount) : 0,
    );
    // 本周的日投影也缺省不带。规则是「不带语义核验，只带
    // 当天折叠 + 本周日卡 + 最近三周周卡」；9/2 那次改动只拿掉了过去几周的周投影，
    // 「本周日投影仍然带」原是实现时留的例外，不在规则里。周三看只剩 7k 像修好了，
    // 到周五四天攒成 56,800 token，比完整卡层（41,073）还大。缺省 false = 可核验层
    // 什么都不带；投影照常生成、留盘、记忆馆照看，要对质走 lookup_verified_memory。
    this.verifiedCurrentWeekDays = verifiedCurrentWeekDays === true;
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
      verifyClaims: verifierMode === 'microbatch' && typeof verifyBatch === 'function'
        ? (claims, packet) => verifyClaimsInMicroBatches({
            claims,
            packet,
            entities: this.entities,
            verifyBatch,
            verifySingle: verify,
            verifyHighRiskBatch: batchHighRisk ? verifyHighRiskBatch : null,
            verifyHighRiskSingle: verifyHighRisk,
            requireSecondaryHighRisk: true,
            maxClaims: batchMaxClaims,
            maxVerdictFields: batchMaxVerdictFields,
          })
        : null,
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

  // 可核验层从「永远背着」改成「要用时去取」。
  //
  // 第一步已经把过去几周的周投影从每轮上下文里拿掉了（99,147 token，占该层 94%）。
  // 但那些逐句记录本身是有用的——它们是有 claim/event 证据支撑的原始事实，
  // 是用来对质的。缺的只是一个「按需调出来」的口子，而不是天天背着。
  //
  // 这个方法就是那个口子：给一个日期或周一日期，把那一段的已核验句子取出来。
  // 只读，不改任何状态；有条数上限，不会把 1,776 句一次性糊回上下文里。
  lookupVerified({ period = '', limit = 80, offset = 0 } = {}) {
    const key = String(period || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return { error: 'period 需要形如 2026-08-24 的日期（日投影用当天，周投影用那周的周一）' };
    }
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 80)));
    const boundedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const matched = this.store.projectionsForPeriod(key).filter((projection) => (
      projection.status === 'accepted'
      && projection.stale !== true
      && ['day', 'week'].includes(projection.projectionType)
      && String(projection.period?.key || '') === key
    ));
    // 按需模式（B 档）：查不到就地点名去整理，而不是回一句「没有」。
    // 平时不预验，被问到才验——这正是「按需」两个字落地的地方。
    const pendingHere = this.verifyPolicy === 'on-demand'
      ? this.pendingCountForPeriod(key)
      : 0;
    if (!matched.length) {
      if (this.verifyPolicy === 'on-demand' && pendingHere > 0) {
        this.requestPeriod(key);
        return {
          period: key,
          found: false,
          verifyPolicy: 'on-demand',
          queuedPackets: pendingHere,
          note: `${key} 还没整理过，已经开始整理这一段（${pendingHere} 个片段排队中）。`
            + '整理要跑抽取和核验，需要一点时间，不会打断当前对话；'
            + '过一会儿用同一个日期再问一次就能拿到内容。',
        };
      }
      return { period: key, found: false, note: `没有 ${key} 的已核验投影（日投影用当天日期，周投影用那周周一）` };
    }
    const latestByType = latestBy(matched, (projection) => projection.projectionType);
    const out = [];
    let total = 0;
    for (const projection of latestByType) {
      const sentences = uniqueSupportedSentences(projection).map((item) => item.text);
      total += sentences.length;
      out.push({
        projectionType: projection.projectionType,
        periodKey: projection.period?.key || key,
        title: projection.title || null,
        totalSentences: sentences.length,
        sentences: sentences.slice(boundedOffset, boundedOffset + boundedLimit),
      });
    }
    if (pendingHere > 0) this.requestPeriod(key);
    return {
      period: key,
      found: true,
      totalSentences: total,
      offset: boundedOffset,
      limit: boundedLimit,
      hasMore: total > boundedOffset + boundedLimit,
      projections: out,
      // 这一段后来又有新对话还没整理进投影时如实说明，别让人以为看到的就是全部。
      ...(pendingHere > 0 ? {
        staleCount: pendingHere,
        staleNote: `这一段还有 ${pendingHere} 个片段没整理进来，已经开始补，稍后再问会更全。`,
      } : {}),
    };
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
    const queueRecords = this._queue();
    const activeMessages = queueClass === 'live'
      ? queueRecords.filter((record) => [
        'pending', 'retry', 'partial_review_pending', 'needs_human_review', 'completed',
      ].includes(record.status)).flatMap((record) => record.packet?.rawMessages || [])
      : [];
    const activeById = new Map();
    const activeByAlias = new Map();
    const addActive = (message) => {
      const id = scopedSourceId(message);
      if (!activeById.has(id)) activeById.set(id, []);
      activeById.get(id).push(message);
      const alias = scopedAssistantAlias(message);
      if (alias) {
        if (!activeByAlias.has(alias)) activeByAlias.set(alias, []);
        activeByAlias.get(alias).push(message);
      }
    };
    if (queueClass === 'live') activeMessages.forEach(addActive);
    let liveSourceDuplicates = 0;
    const packets = [];
    for (const packetInput of prepared) {
      const original = createSemanticPacket(packetInput);
      if (queueClass !== 'live') {
        packets.push(original);
        continue;
      }
      const fresh = [];
      for (const message of original.rawMessages) {
        const sameId = activeById.get(scopedSourceId(message)) || [];
        const alias = scopedAssistantAlias(message);
        const possibleAliases = alias ? activeByAlias.get(alias) || [] : [];
        const conflict = sameId.find((prior) => rawMessageIdConflict(message, prior));
        if (conflict) {
          const error = new Error(`semantic source messageId 相同但正文哈希不同：${message.messageId}`);
          error.code = 'SEMANTIC_SOURCE_ID_CONFLICT';
          throw error;
        }
        if ([...sameId, ...possibleAliases].some((prior) => rawMessageSourceEquivalent(message, prior))) {
          liveSourceDuplicates += 1;
          continue;
        }
        fresh.push(message);
        addActive(message);
      }
      if (!fresh.length) continue;
      // 去重可能移走本包内被回复的旧消息。此时 reply target 仍在 durable
      // inbox，却不在这一个新 packet 的证据集合中；不能继续宣称它可在本包取证。
      const freshIds = new Set(fresh.map((message) => String(message.messageId)));
      const packetMessages = fresh.map((message) => (
        message.replyToMessageId
          && !freshIds.has(String(message.replyToMessageId))
          ? { ...message, replyTargetAvailable: false }
          : message
      ));
      packets.push(fresh.length === original.rawMessages.length
        ? original
        : createSemanticPacket({
          ...packetInput,
          packetId: null,
          cursorStart: null,
          cursorEnd: null,
          rawMessages: packetMessages,
        }));
    }
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
      const coverage = queueClass === 'live'
        ? { status: 'none', totalMessages: packet.rawMessages.length, coveredMessages: 0,
          coveringPacketIds: [] }
        : analyzePacketSourceCoverage(packet, queueRecords);
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
    let sourceDuplicates = liveSourceDuplicates;
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
      packetIds: packets.map((packet) => packet.packetId),
    };
  }

  // 一个待处理记录属于哪些时段（日 key 与所在周的周一 key）。
  _recordPeriods(record) {
    const at = record?.packet?.occurredTo || record?.packet?.occurredFrom;
    if (!at) return [];
    const day = operationalDayKey(at, this.memoryPolicy.time);
    if (!day) return [];
    return [day, weekKeyForDay(day)];
  }

  // 点名一个时段去整理。'all' = 把全部积压补跑（想清历史欠账时用）。
  // 返回该时段当前有多少个待处理片段。只登记，不在这里开工——
  // 真正的消化仍由后台 scheduler 在下一次唤醒时按原路径进行，
  // 绝不能在工具调用里同步跑完：2026-09-02 日卡维护占住队列、
  // 群聊排在后面等了 55 分钟，那个事故的教训就写在 engine-core 里。
  requestPeriod(period) {
    const key = String(period || '').trim();
    if (key !== 'all' && !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      throw new Error('requestPeriod 需要形如 2026-08-24 的日期，或 all');
    }
    this._requestedPeriods.add(key);
    return this.pendingCountForPeriod(key);
  }

  requestedPeriods() { return [...this._requestedPeriods]; }

  pendingCountForPeriod(period) {
    const key = String(period || '').trim();
    const index = this._queueIndex();
    let count = 0;
    for (const packetId of index.actionablePacketIds) {
      const record = index.latest.get(String(packetId));
      if (!record) continue;
      if (key === 'all' || this._recordPeriods(record).includes(key)) count += 1;
    }
    return count;
  }

  _nextPending({ packetIds = null } = {}) {
    const index = this._queueIndex();
    let candidateIds = packetIds
      ? unique(packetIds)
      : [...index.actionablePacketIds];
    // 按需闸门：只在「没有点名具体 packet」时生效——ensurePackets / partial review
    // 这类显式指名的调用照旧直通，不受影响。
    if (!packetIds && this.verifyPolicy === 'on-demand' && !this._requestedPeriods.has('all')) {
      if (!this._requestedPeriods.size) return null;
      candidateIds = candidateIds.filter((packetId) => {
        const record = index.latest.get(String(packetId));
        return record && this._recordPeriods(record)
          .some((period) => this._requestedPeriods.has(period));
      });
      // 点名的时段都消化干净了，撤掉点名，回到「平时一个包都不动」。
      if (!candidateIds.length) { this._requestedPeriods.clear(); return null; }
    }
    const now = Date.now();
    let best = null;
    const compare = (left, right) => (
      (
        (right.status === 'partial_review_pending' ? 1 : 0)
        - (left.status === 'partial_review_pending' ? 1 : 0)
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
      const quotaWait = error?.code === 'HELPER_QUOTA_WAIT';
      const attempts = Number(record.attempts || 0) + (quotaWait ? 0 : 1);
      const retryMs = Math.min(
        QUEUE_RETRY_MAX_MS,
        QUEUE_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 7)),
      );
      this._appendQueue({
        ...record,
        status: reviewingPartial ? 'partial_review_pending' : 'retry',
        reviewPhase: reviewingPartial,
        attempts,
        nextRetryAt: new Date(quotaWait ? error.retryAt : Date.now() + retryMs).toISOString(),
        lastErrorCode: error?.code || null,
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

  async maintainPacketsStep(packetIds) {
    if (!this.enabled()) return { status: 'disabled', pendingCount: 0 };
    const ids = unique(packetIds);
    const record = this._nextPending({ packetIds: ids });
    if (record) await this._processQueueRecord(record);
    let verifiedCount = 0;
    const pending = [];
    const unresolved = [];
    for (const id of ids) {
      const queued = this._queueRecord(id);
      const packet = this.store.packet(id);
      if (['committed', 'committed_after_review', 'human_resolved'].includes(packet?.status)) {
        verifiedCount += 1;
      } else if (ACTIONABLE_QUEUE_STATUSES.has(queued?.status)) {
        pending.push(queued);
      } else {
        unresolved.push({ packetId: id, status: queued?.status || 'missing-source' });
      }
    }
    const times = pending.map((item) => Date.parse(item.nextRetryAt || '') || 0);
    const nextRetryAt = times.length ? Math.min(...times) : null;
    return { status: pending.length ? 'pending' : unresolved.length ? 'needs-review' : 'verified',
      verifiedCount, totalCount: ids.length, pendingCount: pending.length, unresolved,
      nextRetryAt: nextRetryAt > Date.now() ? nextRetryAt : null };
  }

  async maintainOne() {
    if (!this.enabled()) return { status: 'disabled' };
    if (this._maintenance) return { status: 'busy' };
    const record = this._nextPending();
    if (!record) {
      // 按需模式、又没人点名时不能报 nextRetryAt：调度器会照它续定时器，而队列里
      // 那些早已过期的 retry 记录若被无条件轮询，会被夹成极短间隔并持续空转。
      // 它不花钱（这一轮压根不调模型），但会白烧 CPU、刷日志。真到要整理时，
      // requestPeriod() 点名后照常按 nextRetryAt 退避重试。
      const idleAndUnrequested = this.verifyPolicy === 'on-demand'
        && !this._requestedPeriods.size;
      return {
        status: 'idle',
        nextRetryAt: idleAndUnrequested ? null : this.earliestPendingRetryAt(),
      };
    }
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

  // deadline（2026-09-09 补）：折叠前一次验完这一批，但**不能无限期验下去**。
  // 09-09 实测：积压大的时候一个包要 5 分钟，一百多个包要九个多小时，
  // 折叠被死死卡住、活跃上下文一路涨向硬上限——那正是
  // 「验不上就直接折叠」要防的事，我第一版只实现了「失败 5 次就照折」，
  // 漏了「验太久也得照折」。超预算就带 VERIFY_BUDGET_EXCEEDED 抛出，
  // 调用方按未验处理：报警 + 照常折叠 + 冷却后补验。
  // 已经验完的包都已 durable 落盘，这一趟的功不会白费。
  async ensurePackets(packetIds, { deadline = null } = {}) {
    const wanted = unique(packetIds);
    let done = 0;
    for (const packetId of wanted) {
      while (!['committed', 'committed_after_review', 'human_resolved'].includes(
        this.store.packet(packetId)?.status,
      )) {
        const record = this._nextPending({ packetIds: [packetId] });
        if (!record) {
          const queued = this._queueRecord(packetId);
          if (queued?.status === 'retry' || queued?.lastErrorCode === 'HELPER_QUOTA_WAIT') {
            const error = new Error(`semantic packet ${packetId} 正在退避：${queued.lastError || 'unknown'}`);
            if (queued.lastErrorCode === 'HELPER_QUOTA_WAIT') {
              error.code = queued.lastErrorCode;
              error.retryAt = new Date(queued.nextRetryAt).getTime();
            }
            throw error;
          }
          throw new Error(`semantic packet ${packetId} 未入队或原始来源缺失`);
        }
        if (deadline && Date.now() > deadline) {
          const error = new Error(
            `折叠前核验超出时间预算：已验完 ${done}/${wanted.length} 个片段，剩下的留给冷却后补验`,
          );
          error.code = 'VERIFY_BUDGET_EXCEEDED';
          error.verifiedCount = done;
          error.totalCount = wanted.length;
          throw error;
        }
        await this._processQueueRecord(record);
      }
      done += 1;
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

  // 取这一批包的已核验事实文本，给折叠后的摘要做校对用（折叠前核验第 5 步）。
  // 与 foldRounds 走同一条投影构建路径（那条已在生产验证过），区别是：
  // 不 materialize、不 fail-closed —— 这里只是「读一份事实回去对照」，
  // 读不出来就放弃修正，绝不因此影响已经完成的折叠。
  async verifiedTextForPackets(packetIds) {
    if (!this.enabled()) return { status: 'disabled', text: '' };
    const ids = unique((packetIds || []).map(String)).filter(Boolean);
    if (!ids.length) return { status: 'no-packets', text: '' };
    const projection = await this.projections.build({
      kind: 'fold',
      packetIds: ids,
      periodKey: `rounds-${stableHash(ids, 20)}`,
    });
    return { status: projection?.status || 'unknown', text: projectionText(projection) };
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
    const effectiveProjection = this.store.projection(projection.projectionId) || projection;
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

  compile({
    reservedTokens = 0,
    archiveText = '',
    archiveBlocks = [],
    carriedPacketIds = [],
  } = {}) {
    if (!this.effectiveCards()) return null;
    const compiledAt = this.clock();
    const currentDay = operationalDayKey(compiledAt, this.memoryPolicy.time);
    const currentWeek = weekKeyForDay(currentDay);
    const useVerifiedProjections = this.verifiedRecentWeekCount > 0
      || this.verifiedCurrentWeekDays;
    const neededPeriodKeys = [];
    for (let offset = 1; offset <= this.verifiedRecentWeekCount; offset += 1) {
      neededPeriodKeys.push(addDays(currentWeek, -7 * offset));
    }
    if (this.verifiedCurrentWeekDays) {
      for (let day = currentWeek; day <= currentDay; day = addDays(day, 1)) {
        neededPeriodKeys.push(day);
      }
    }
    const latest = useVerifiedProjections ? latestBy(
      this.store.projectionsForPeriods(neededPeriodKeys).filter((projection) => (
        projection.status === 'accepted'
        && projection.stale !== true
        && ['day', 'week'].includes(projection.projectionType)
      )),
      (projection) => `${projection.projectionType}:${projection.period?.key || ''}`,
    ) : [];
    // 过去几周的**周投影不再进上下文**。
    //
    // 这一层自称「可核验纠错锚点」，但代码里从来没有「判断哪句和完整卡冲突」的
    // 逻辑，做不到只带冲突，于是把整份逐句记录都带上了。实测 8/10 那一周：
    // 周卡 7,144 字 vs 周投影 1,776 句 / 56,584 字，而投影句里关键词能被周卡
    // 覆盖的只有 3%——它不是周卡的复读，是比卡细得多的**逐字稿**，细到
    // 「用户问某人在哪里」这种颗粒度。
    // 让代理每一轮都背着过去四周的每一句寒暄，不是记得更牢，是脑子里塞满会议记录。
    // 四周周投影合计 99,147 token，占这一层的 94%。
    //
    // ⚠️ 一个字都没删：投影全部留在磁盘与记忆馆里，可搜可查可对质。改的只是
    // 「每轮默认塞给他什么」。
    // 2026-09-18：本周的日投影也缺省不带了（verifiedCurrentWeekDays，见构造函数注释）。
    // recentWeekCount 设成 0 以外的值可以把周投影放回来（见 semanticRecentWeekCount）。
    const weeks = this.verifiedRecentWeekCount <= 0 ? [] : latest
      .filter((projection) => (
        projection.projectionType === 'week'
        && String(projection.period?.key || '') < currentWeek
      ))
      .sort((a, b) => String(b.period?.key || '').localeCompare(String(a.period?.key || '')))
      .slice(0, this.verifiedRecentWeekCount);
    const days = !this.verifiedCurrentWeekDays ? [] : latest
      .filter((projection) => (
        projection.projectionType === 'day'
        && String(projection.period?.key || '') >= currentWeek
        && String(projection.period?.key || '') <= currentDay
      ))
      .sort((a, b) => String(a.period?.key || '').localeCompare(String(b.period?.key || '')));
    const candidates = [...weeks.reverse(), ...days];
    const carriedPacketIdSet = new Set((carriedPacketIds || []).map(String).filter(Boolean));
    const evidence = candidates.length ? this.store.resolvedEvidenceState() : null;
    const claimPacketById = new Map((evidence?.claims || [])
      .map((claim) => [String(claim.claimId), String(claim.packetId || '')]));
    const eventPacketById = new Map((evidence?.events || [])
      .map((event) => [String(event.eventId), String(event.packetId || '')]));
    const normalizedReservedTokens = Math.max(0, Number(reservedTokens) || 0);
    const normalizedArchiveText = String(archiveText || '').trim();
    const normalizedArchiveBlocks = (Array.isArray(archiveBlocks) ? archiveBlocks : [])
      .filter((block) => block && String(block.text || '').trim())
      .map((block) => ({
        blockId: String(block.id || `archive:${stableHash(block, 24)}`),
        layer: 'archive',
        kind: String(block.kind || 'card'),
        // 2026-10-09：月卡也要带上类型，否则记忆馆把它显示成日卡。
        cardType: ['day', 'week', 'month'].includes(block.cardType) ? block.cardType : null,
        periodKey: block.periodKey || null,
        title: block.label || null,
        text: String(block.text || '').trim(),
        tokenEstimate: Math.max(0, Number(block.tokenEstimate) || this.estimateTokens(block.text)),
      }));
    const archiveTokens = normalizedArchiveText ? this.estimateTokens(normalizedArchiveText) : 0;
    const selected = [];
    const selectedSentenceKeys = new Set();
    const duplicateOnlyProjectionIds = [];
    const activeOnlyProjectionIds = [];
    let dedupedActiveSentenceCount = 0;
    let usedTokens = 0;
    for (const projection of candidates.reverse()) {
      const supportedSentences = uniqueSupportedSentences(projection, selectedSentenceKeys);
      const uniqueSentences = supportedSentences.filter((item) => {
        if (String(projection?.humanContent || '').trim()) return true;
        const packetIds = unique([
          ...(item.sentence?.supportClaimIds || []).map((id) => claimPacketById.get(String(id))),
          ...(item.sentence?.supportEventIds || []).map((id) => eventPacketById.get(String(id))),
        ]).filter(Boolean);
        const alreadyCarried = packetIds.length > 0
          && packetIds.every((packetId) => carriedPacketIdSet.has(packetId));
        if (alreadyCarried) dedupedActiveSentenceCount += 1;
        return !alreadyCarried;
      });
      if (!uniqueSentences.length) {
        if (supportedSentences.length) activeOnlyProjectionIds.push(projection.projectionId);
        else duplicateOnlyProjectionIds.push(projection.projectionId);
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
      activeOnlyProjectionIds,
      carriedPacketIds: [...carriedPacketIdSet].sort(),
      dedupedActiveSentenceCount,
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
      activeOnlyProjectionIds,
      dedupedActiveSentenceCount,
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
