// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const STORE_VERSION = 1;
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 120_000;
const DEFAULT_CURSOR = Object.freeze({
  schemaVersion: STORE_VERSION,
  source: null,
  ingestionCursor: null,
  packetId: null,
  transactionId: null,
  committedAt: null,
});

function sha256Json(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWriteJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporaryPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(path.dirname(filePath));
}

function appendFsynced(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const fd = fs.openSync(filePath, 'a', 0o600);
  const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  let bytesWritten = 0;
  try {
    while (bytesWritten < line.length) {
      const written = fs.writeSync(
        fd,
        line,
        bytesWritten,
        line.length - bytesWritten,
        null,
      );
      if (written <= 0) throw new Error(`写入 ${path.basename(filePath)} 时没有取得进展`);
      bytesWritten += written;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
  return bytesWritten;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Iterates a JSONL file a bounded chunk at a time. This intentionally avoids
 * readFileSync so a long-running sidecar never needs to hold the journal in RAM.
 */
function visitJsonl(filePath, visitor, { chunkSize = 64 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const buffer = Buffer.allocUnsafe(chunkSize);
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = remainder + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split('\n');
      remainder = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        visitor(JSON.parse(line));
      }
    }
    remainder += decoder.end();
    if (remainder.trim()) visitor(JSON.parse(remainder));
  } finally {
    fs.closeSync(fd);
  }
}

function readLatestJsonl(filePath, idField) {
  const latest = new Map();
  visitJsonl(filePath, (entry) => {
    const id = String(entry?.[idField] || '');
    if (id) latest.set(id, entry);
  });
  return [...latest.values()];
}

function fileStatSignature(filePath) {
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

function sameFileStat(left, right) {
  return Boolean(left && right)
    && left.exists === right.exists
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function latestPacketReviewsByPacket(reviews = []) {
  const latestReviewByPacket = new Map();
  for (const review of reviews || []) {
    const packetId = String(review?.packetId || '');
    if (!packetId) continue;
    const prior = latestReviewByPacket.get(packetId);
    const priorAttempt = Number(prior?.reviewAttempt || 0);
    const attempt = Number(review?.reviewAttempt || 0);
    const priorAt = Date.parse(prior?.committedAt || prior?.createdAt || '') || 0;
    const at = Date.parse(review?.committedAt || review?.createdAt || '') || 0;
    if (!prior || attempt > priorAttempt || (attempt === priorAttempt && at >= priorAt)) {
      latestReviewByPacket.set(packetId, review);
    }
  }
  return latestReviewByPacket;
}

function applyPacketReview(packet, review, { humanResolutionLabel = 'human_resolution' } = {}) {
  if (!review) return packet;
  const status = review.status === 'committed'
    ? 'committed_after_review'
    : review.status === 'human_resolved'
      ? 'human_resolved'
      : packet.status;
  return {
    ...packet,
    canonicalStatus: packet.status,
    status,
    latestReviewId: review.reviewId,
    latestReviewStatus: review.status,
    reviewAttempt: Number(review.reviewAttempt || 0),
    reviewCounts: review.counts || null,
    resolvedBy: review.status === 'committed'
      ? 'automatic_review'
      : review.status === 'human_resolved'
        ? humanResolutionLabel
        : null,
  };
}

function applyPacketReviews(packets = [], reviews = [], options = {}) {
  const latestReviewByPacket = latestPacketReviewsByPacket(reviews);
  return (packets || []).map((packet) => applyPacketReview(
    packet,
    latestReviewByPacket.get(String(packet?.packetId || '')),
    options,
  ));
}

function jsonlHasId(filePath, idField, wantedId) {
  let found = false;
  visitJsonl(filePath, (entry) => {
    if (String(entry?.[idField] || '') === String(wantedId)) found = true;
  });
  return found;
}

function waitSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function releaseStaleLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
  if (Date.now() - stat.mtimeMs < LOCK_STALE_MS || pidAlive(Number(owner?.pid))) return;
  try { fs.unlinkSync(lockPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const EVENT_CLAIM_FIELDS = Object.freeze([
  'initialStateClaimIds',
  'triggerClaimIds',
  'interpretationClaimIds',
  'emotionOrStanceClaimIds',
  'actionClaimIds',
  'consequenceClaimIds',
  'laterActionClaimIds',
  'repairClaimIds',
  'unresolvedClaimIds',
]);

function applyHumanPatch(state, patch, changed, changedAt) {
  const targetType = String(patch?.targetType || '');
  const targetId = String(patch?.targetId || '');
  const operation = String(patch?.operation || '');
  const bucketByType = {
    claim: 'claims',
    event: 'events',
    projection: 'projections',
    entity: 'entities',
  };
  const idFieldByType = {
    claim: 'claimId',
    event: 'eventId',
    projection: 'projectionId',
    entity: 'entityId',
  };
  const bucket = bucketByType[targetType];
  if (!bucket) return;
  if (targetType === 'projection' && patch?.scope === 'period') {
    const source = patch?.selector && typeof patch.selector === 'object'
      ? patch.selector
      : {
          projectionType: patch?.before?.projectionType,
          periodKey: patch?.before?.period?.key,
        };
    if (!source.projectionType || !source.periodKey) return;
    const effectiveFrom = source.effectiveFromCreatedAt
      || patch?.before?.createdAt
      || patch?.before?.committedAt
      || null;
    const effectiveFromAt = Date.parse(effectiveFrom || '');
    const recordAt = (record) => {
      const createdAt = Date.parse(record?.createdAt || '');
      if (!Number.isNaN(createdAt)) return createdAt;
      const committedAt = Date.parse(record?.committedAt || '');
      return Number.isNaN(committedAt) ? 0 : committedAt;
    };
    const matchingIds = [...state.projections]
      .filter(([, projection]) => (
        projection?.projectionType === source.projectionType
        && projection?.period?.key === source.periodKey
        && (
          projection?.projectionId === targetId
          || (
            effectiveFrom
            && !Number.isNaN(effectiveFromAt)
            && recordAt(projection) >= effectiveFromAt
          )
        )
      ))
      .map(([projectionId]) => projectionId);
    for (const projectionId of matchingIds) {
      applyHumanPatch(state, {
        ...patch,
        scope: 'single',
        targetId: projectionId,
        periodScoped: true,
      }, changed, changedAt);
    }
    return;
  }
  if (!state[bucket].has(targetId)) return;
  const target = state[bucket].get(targetId);
  const patchAt = Number.isNaN(Date.parse(patch?.createdAt || ''))
    ? Number.POSITIVE_INFINITY
    : Date.parse(patch.createdAt);
  const markChanged = (type, id) => {
    const key = String(id);
    changed[type].add(key);
    changedAt[type].set(key, Math.max(changedAt[type].get(key) || 0, patchAt));
  };
  if (['correct', 'clarify'].includes(operation)) {
    const next = { ...target, ...(patch.after || {}), humanAuthored: true };
    next[idFieldByType[targetType]] = target[idFieldByType[targetType]];
    if (targetType === 'claim') next.verificationStatus = 'supported';
    if (targetType === 'event') next.status = 'accepted';
    if (targetType === 'projection') {
      const humanContent = String(patch?.after?.humanContent || '').trim();
      const humanSentences = Array.isArray(patch?.after?.sentences)
        ? patch.after.sentences.some((sentence) => String(sentence?.text || '').trim())
        : false;
      if (humanContent || humanSentences) {
        next.status = 'accepted';
        next.stale = false;
      }
      if (patch.periodScoped === true) next.humanAuthoredPeriod = true;
    }
    state[bucket].set(targetId, next);
    markChanged(targetType, targetId);
    return;
  }
  if (operation === 'invalidate') {
    const next = { ...target, humanAuthored: true };
    if (targetType === 'claim') next.verificationStatus = 'invalidated';
    if (targetType === 'event') next.status = 'invalidated';
    if (targetType === 'projection') {
      next.status = 'invalidated';
      next.stale = true;
    }
    if (targetType === 'entity') next.invalidated = true;
    state[bucket].set(targetId, next);
    markChanged(targetType, targetId);
    return;
  }
  if (operation === 'split' && ['claim', 'event'].includes(targetType)) {
    const replacements = Array.isArray(patch.after?.replacements)
      ? patch.after.replacements
      : [];
    if (replacements.length < 2) return;
    applyHumanPatch(state, { ...patch, operation: 'invalidate' }, changed, changedAt);
    for (const replacement of replacements) {
      const replacementId = String(replacement?.[idFieldByType[targetType]] || '');
      if (!replacementId) continue;
      const next = { ...replacement, humanAuthored: true };
      if (targetType === 'claim') next.verificationStatus = 'supported';
      else next.status = 'accepted';
      state[bucket].set(replacementId, next);
      markChanged(targetType, replacementId);
    }
    return;
  }
  if (operation === 'merge' && ['claim', 'event'].includes(targetType)) {
    const sourceIds = Array.isArray(patch.after?.sourceIds) ? patch.after.sourceIds : [];
    const merged = patch.after?.merged;
    if (sourceIds.length < 2 || !merged || typeof merged !== 'object') return;
    for (const sourceId of sourceIds) {
      applyHumanPatch(state, {
        targetType,
        targetId: String(sourceId),
        operation: 'invalidate',
        createdAt: patch.createdAt,
      }, changed, changedAt);
    }
    const mergedId = String(merged[idFieldByType[targetType]] || '');
    if (!mergedId) return;
    const next = { ...merged, humanAuthored: true };
    if (targetType === 'claim') next.verificationStatus = 'supported';
    else next.status = 'accepted';
    state[bucket].set(mergedId, next);
    markChanged(targetType, mergedId);
  }
}

function resolveSemanticState({
  claims = [],
  events = [],
  projections = [],
  entities = [],
  patches = [],
} = {}) {
  const state = {
    claims: new Map(claims.map((record) => [String(record.claimId), { ...record }])),
    events: new Map(events.map((record) => [String(record.eventId), { ...record }])),
    projections: new Map(
      projections.map((record) => [String(record.projectionId), { ...record }]),
    ),
    entities: new Map(entities.map((record) => [String(record.entityId), { ...record }])),
  };
  const changed = {
    claim: new Set(),
    event: new Set(),
    projection: new Set(),
    entity: new Set(),
  };
  const changedAt = {
    claim: new Map(),
    event: new Map(),
    projection: new Map(),
    entity: new Map(),
  };
  for (const patch of patches) applyHumanPatch(state, patch, changed, changedAt);
  const recordAt = (record) => {
    let latest = 0;
    for (const value of [record?.committedAt, record?.createdAt, record?.updatedAt]) {
      const timestamp = Date.parse(value || '');
      if (!Number.isNaN(timestamp)) latest = Math.max(latest, timestamp);
    }
    return latest;
  };
  const invalidClaims = new Set(
    [...state.claims].filter(([, claim]) => claim.verificationStatus !== 'supported')
      .map(([claimId]) => claimId),
  );
  for (const [eventId, event] of state.events) {
    const refs = new Set(EVENT_CLAIM_FIELDS.flatMap((field) => event[field] || []).map(String));
    if (![...refs].some((id) => (
      !state.claims.has(id)
      || invalidClaims.has(id)
      || (changed.claim.has(id) && recordAt(event) <= (changedAt.claim.get(id) || 0))
    ))) continue;
    state.events.set(eventId, {
      ...event,
      status: 'invalidated',
      stale: true,
      staleReason: 'supporting_claim_changed',
    });
    changed.event.add(eventId);
  }
  const invalidEvents = new Set(
    [...state.events].filter(([, event]) => event.status !== 'accepted')
      .map(([eventId]) => eventId),
  );
  for (const [projectionId, projection] of state.projections) {
    if (projection.humanContent || projection.humanAuthoredPeriod) continue;
    const claimRefs = new Set((projection.supportClaimIds || []).map(String));
    const eventRefs = new Set((projection.supportEventIds || []).map(String));
    for (const sentence of projection.sentences || []) {
      (sentence.supportClaimIds || []).forEach((id) => claimRefs.add(String(id)));
      (sentence.supportEventIds || []).forEach((id) => eventRefs.add(String(id)));
    }
    const projectionAt = recordAt(projection);
    const stale = [...claimRefs].some((id) => (
      !state.claims.has(id)
      || invalidClaims.has(id)
      || (changed.claim.has(id) && projectionAt <= (changedAt.claim.get(id) || 0))
    )) || [...eventRefs].some((id) => (
      !state.events.has(id)
      || invalidEvents.has(id)
      || (changed.event.has(id) && projectionAt <= (changedAt.event.get(id) || 0))
    ));
    if (!stale) continue;
    state.projections.set(projectionId, {
      ...projection,
      status: 'stale',
      stale: true,
      autoEffective: false,
      staleReason: 'supporting_semantic_record_changed',
    });
    changed.projection.add(projectionId);
  }
  return {
    claims: [...state.claims.values()],
    events: [...state.events.values()],
    projections: [...state.projections.values()],
    entities: [...state.entities.values()],
    cascade: Object.fromEntries(
      Object.entries(changed).map(([type, ids]) => [type, [...ids].sort()]),
    ),
  };
}

function addDependency(index, supportId, dependentId) {
  const key = String(supportId || '');
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(String(dependentId));
}

function projectionSupportIds(projection) {
  const claimIds = new Set((projection?.supportClaimIds || []).map(String));
  const eventIds = new Set((projection?.supportEventIds || []).map(String));
  for (const sentence of projection?.sentences || []) {
    (sentence.supportClaimIds || []).forEach((id) => claimIds.add(String(id)));
    (sentence.supportEventIds || []).forEach((id) => eventIds.add(String(id)));
  }
  return { claimIds, eventIds };
}

function buildResolvedStateMetadata(state, patches = []) {
  const metadata = {
    claimsById: new Map(),
    eventsById: new Map(),
    projectionsById: new Map(),
    eventsByMissingClaimId: new Map(),
    projectionsByMissingClaimId: new Map(),
    projectionsByMissingEventId: new Map(),
    patchTargets: new Set(),
    patchedClaimIds: new Set(),
    patchedEventIds: new Set(),
    patchedProjectionPeriods: new Set(),
  };
  for (const claim of state.claims || []) {
    metadata.claimsById.set(String(claim.claimId), claim);
  }
  for (const event of state.events || []) {
    const eventId = String(event.eventId);
    metadata.eventsById.set(eventId, event);
    for (const claimId of EVENT_CLAIM_FIELDS.flatMap((field) => event[field] || [])) {
      if (!metadata.claimsById.has(String(claimId))) {
        addDependency(metadata.eventsByMissingClaimId, claimId, eventId);
      }
    }
  }
  for (const projection of state.projections || []) {
    const projectionId = String(projection.projectionId);
    metadata.projectionsById.set(projectionId, projection);
    const supports = projectionSupportIds(projection);
    for (const claimId of supports.claimIds) {
      if (!metadata.claimsById.has(claimId)) {
        addDependency(metadata.projectionsByMissingClaimId, claimId, projectionId);
      }
    }
    for (const eventId of supports.eventIds) {
      if (!metadata.eventsById.has(eventId)) {
        addDependency(metadata.projectionsByMissingEventId, eventId, projectionId);
      }
    }
  }
  for (const patch of patches || []) {
    const targetType = String(patch?.targetType || '');
    const targetId = String(patch?.targetId || '');
    if (targetType && targetId) metadata.patchTargets.add(`${targetType}\0${targetId}`);
    const patchedIds = targetType === 'claim'
      ? metadata.patchedClaimIds
      : targetType === 'event'
        ? metadata.patchedEventIds
        : null;
    if (patchedIds && targetId) patchedIds.add(targetId);
    if (patchedIds && patch?.operation === 'merge') {
      for (const sourceId of patch?.after?.sourceIds || []) patchedIds.add(String(sourceId));
      const mergedId = patch?.after?.merged?.[
        targetType === 'claim' ? 'claimId' : 'eventId'
      ];
      if (mergedId) patchedIds.add(String(mergedId));
    }
    if (patchedIds && patch?.operation === 'split') {
      for (const replacement of patch?.after?.replacements || []) {
        const replacementId = replacement?.[
          targetType === 'claim' ? 'claimId' : 'eventId'
        ];
        if (replacementId) patchedIds.add(String(replacementId));
      }
    }
    if (targetType === 'projection' && patch?.scope === 'period') {
      const selector = patch?.selector && typeof patch.selector === 'object'
        ? patch.selector
        : {
            projectionType: patch?.before?.projectionType,
            periodKey: patch?.before?.period?.key,
          };
      if (selector.projectionType && selector.periodKey) {
        metadata.patchedProjectionPeriods.add(
          `${selector.projectionType}\0${selector.periodKey}`,
        );
      }
    }
  }
  return metadata;
}

class SemanticMemoryStore {
  constructor({
    directory,
    mode = 'shadow',
    storeType = 'tether-semantic-memory',
    humanResolutionLabel = 'human_resolution',
    clock = () => new Date().toISOString(),
    log = console.log,
    testHooks = null,
    lockTimeoutMs = LOCK_TIMEOUT_MS,
  } = {}) {
    if (!directory) throw new Error('SemanticMemoryStore 缺少 directory');
    this.directory = path.resolve(directory);
    this.mode = String(mode || 'shadow');
    this.storeType = String(storeType || 'tether-semantic-memory');
    this.humanResolutionLabel = String(humanResolutionLabel || 'human_resolution');
    this.clock = clock;
    this.log = log;
    this.testHooks = testHooks;
    this.lockTimeoutMs = Math.max(1, Number(lockTimeoutMs) || LOCK_TIMEOUT_MS);
    // These are derived, process-local indexes only. The JSONL journals remain
    // the sole durable source of truth. A stat mismatch always discards the
    // relevant index and rebuilds it from the journal before returning data.
    this._cacheRevision = 0;
    this._journalIndexes = new Map();
    this._jsonSnapshots = new Map();
    this._resolvedStateCache = null;
    this._reviewedPacketsCache = null;
    this._packetReviewLookupCache = null;
    this.paths = {
      manifest: path.join(this.directory, 'manifest.json'),
      cursor: path.join(this.directory, 'cursor.json'),
      entities: path.join(this.directory, 'entities.json'),
      claims: path.join(this.directory, 'claims.jsonl'),
      events: path.join(this.directory, 'events.jsonl'),
      packets: path.join(this.directory, 'packets.jsonl'),
      packetReviews: path.join(this.directory, 'packet-reviews.jsonl'),
      projections: path.join(this.directory, 'projections.jsonl'),
      patches: path.join(this.directory, 'patches.jsonl'),
      failures: path.join(this.directory, 'failures.jsonl'),
      lock: path.join(this.directory, '.store.lock'),
    };
  }

  initialize({ entities = [] } = {}) {
    ensurePrivateDirectory(this.directory);
    const existingManifest = readJson(this.paths.manifest, null);
    if (!existingManifest) {
      atomicWriteJson(this.paths.manifest, {
        schemaVersion: STORE_VERSION,
        storeType: this.storeType,
        mode: this.mode,
        createdAt: this.clock(),
        updatedAt: this.clock(),
        lastCommittedTransactionId: null,
        lastCommittedPacketId: null,
        recordCounts: {
          claims: 0,
          events: 0,
          packets: 0,
          packetReviews: 0,
          projections: 0,
          patches: 0,
          failures: 0,
        },
      });
    } else if (existingManifest.schemaVersion !== STORE_VERSION) {
      throw new Error(`semantic memory store schema 不兼容：${existingManifest.schemaVersion}`);
    } else if (String(existingManifest.mode || '') !== this.mode) {
      atomicWriteJson(this.paths.manifest, {
        ...existingManifest,
        mode: this.mode,
        updatedAt: this.clock(),
      });
    }
    if (!fs.existsSync(this.paths.cursor)) {
      atomicWriteJson(this.paths.cursor, { ...DEFAULT_CURSOR });
    }
    if (!fs.existsSync(this.paths.entities)) {
      atomicWriteJson(this.paths.entities, {
        schemaVersion: STORE_VERSION,
        entities,
        updatedAt: this.clock(),
      });
    }
    return this.snapshot();
  }

  manifest() {
    return readJson(this.paths.manifest, null);
  }

  cursor() {
    return readJson(this.paths.cursor, { ...DEFAULT_CURSOR });
  }

  entities() {
    return this._stableJsonSnapshot(
      this.paths.entities,
      { schemaVersion: STORE_VERSION, entities: [] },
    ).value;
  }

  snapshot() {
    return {
      manifest: this.manifest(),
      cursor: this.cursor(),
      entities: this.entities(),
    };
  }

  _nextCacheRevision() {
    this._cacheRevision += 1;
    return this._cacheRevision;
  }

  _stableJsonSnapshot(filePath, fallback) {
    const current = fileStatSignature(filePath);
    const cached = this._jsonSnapshots.get(filePath);
    if (cached && sameFileStat(cached.signature, current)) return cached;
    const reason = cached ? 'external-change' : 'cold-start';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = fileStatSignature(filePath);
      const value = readJson(filePath, fallback);
      const after = fileStatSignature(filePath);
      if (!sameFileStat(before, after)) continue;
      const snapshot = {
        value,
        signature: after,
        revision: this._nextCacheRevision(),
      };
      this._jsonSnapshots.set(filePath, snapshot);
      if (typeof this.testHooks?.onJsonSnapshotReload === 'function') {
        this.testHooks.onJsonSnapshotReload({ filePath, reason, attempt });
      }
      return snapshot;
    }
    const error = new Error(
      `${path.basename(filePath)} 在读取期间持续变化，拒绝使用可能撕裂的快照`,
    );
    error.code = 'SEMANTIC_MEMORY_SNAPSHOT_RACE';
    throw error;
  }

  _journalIndex(filePath, idField) {
    const current = fileStatSignature(filePath);
    const cached = this._journalIndexes.get(filePath);
    if (cached) {
      if (cached.idField !== idField) {
        throw new Error(`${path.basename(filePath)} index idField 不一致`);
      }
      if (sameFileStat(cached.signature, current)) return cached;
    }
    const reason = cached ? 'external-change' : 'cold-start';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = fileStatSignature(filePath);
      const latest = new Map();
      const ids = new Set();
      const revisionKeys = new Set();
      visitJsonl(filePath, (entry) => {
        const id = String(entry?.[idField] || '');
        if (!id) return;
        ids.add(id);
        latest.set(id, entry);
        const transactionId = String(entry?.transactionId || '');
        if (transactionId) revisionKeys.add(`${id}\0${transactionId}`);
      });
      const after = fileStatSignature(filePath);
      if (!sameFileStat(before, after)) continue;
      const index = {
        idField,
        latest,
        ids,
        revisionKeys,
        signature: after,
        revision: this._nextCacheRevision(),
      };
      this._journalIndexes.set(filePath, index);
      if (typeof this.testHooks?.onJournalFullScan === 'function') {
        this.testHooks.onJournalFullScan({
          filePath,
          reason,
          attempt,
          bytes: after.size,
          records: latest.size,
        });
      }
      return index;
    }
    const error = new Error(
      `${path.basename(filePath)} 在读取期间持续变化，拒绝使用可能撕裂的索引`,
    );
    error.code = 'SEMANTIC_MEMORY_JOURNAL_RACE';
    throw error;
  }

  _finishJournalAppend(filePath, index, records, bytesWritten) {
    if (!records.length) return index;
    const after = fileStatSignature(filePath);
    const before = index.signature;
    const expectedSize = Number(before?.size || 0) + Number(bytesWritten || 0);
    const identityPreserved = before.exists
      ? after.exists && before.dev === after.dev && before.ino === after.ino
      : after.exists;
    if (!identityPreserved || after.size !== expectedSize) {
      // A non-cooperating writer, replacement, or truncation raced our append.
      // Never bless a partial in-memory view with the new on-disk stat: force a
      // complete authoritative rebuild (or fail on malformed/partial JSONL).
      this._journalIndexes.delete(filePath);
      return this._journalIndex(filePath, index.idField);
    }
    for (const record of records) {
      const id = String(record?.[index.idField] || '');
      index.ids.add(id);
      index.latest.set(id, record);
      const transactionId = String(record?.transactionId || '');
      if (transactionId) index.revisionKeys.add(`${id}\0${transactionId}`);
    }
    index.signature = after;
    index.revision = this._nextCacheRevision();
    return index;
  }

  _latestJournalRecords(filePath, idField) {
    return [...this._journalIndex(filePath, idField).latest.values()];
  }

  _semanticJournalType(filePath) {
    if (filePath === this.paths.claims) return 'claims';
    if (filePath === this.paths.events) return 'events';
    if (filePath === this.paths.projections) return 'projections';
    if (filePath === this.paths.patches) return 'patches';
    return null;
  }

  _semanticSnapshots() {
    const claims = this._journalIndex(this.paths.claims, 'claimId');
    const events = this._journalIndex(this.paths.events, 'eventId');
    const projections = this._journalIndex(this.paths.projections, 'projectionId');
    const patches = this._journalIndex(this.paths.patches, 'patchId');
    const entities = this._stableJsonSnapshot(
      this.paths.entities,
      { schemaVersion: STORE_VERSION, entities: [] },
    );
    return {
      claims,
      events,
      projections,
      patches,
      entities,
      revisions: {
        claims: claims.revision,
        events: events.revision,
        projections: projections.revision,
        patches: patches.revision,
        entities: entities.revision,
      },
    };
  }

  _currentResolvedCache() {
    if (!this._resolvedStateCache) return null;
    const snapshots = this._semanticSnapshots();
    const current = Object.entries(snapshots.revisions).every(
      ([key, revision]) => this._resolvedStateCache.revisions[key] === revision,
    );
    return current ? this._resolvedStateCache : null;
  }

  _incrementResolvedUnique(type, records, revision) {
    const cache = this._resolvedStateCache;
    if (!cache || !['claims', 'events', 'projections'].includes(type)) return false;
    const state = cache.state;
    const metadata = cache.metadata;
    const singular = type.slice(0, -1);
    const idField = `${singular}Id`;

    // Preflight the whole delta before mutating the cached state. Forward
    // references and dormant human patches can make a new id change older
    // effective records; those rare cases deliberately fall back to the full,
    // authoritative resolver instead of guessing incrementally.
    for (const record of records) {
      const id = String(record?.[idField] || '');
      const effectiveMap = metadata[`${type}ById`];
      if (!id || effectiveMap.has(id)) return false;
      if (metadata.patchTargets.has(`${singular}\0${id}`)) return false;
      if (type === 'claims') {
        if (metadata.patchedClaimIds.has(id)) return false;
        if (
          metadata.eventsByMissingClaimId.has(id)
          || metadata.projectionsByMissingClaimId.has(id)
        ) return false;
      }
      if (type === 'events') {
        if (metadata.patchedEventIds.has(id)) return false;
        if (metadata.projectionsByMissingEventId.has(id)) return false;
        const claimIds = EVENT_CLAIM_FIELDS.flatMap((field) => record[field] || []).map(String);
        if (claimIds.some((claimId) => metadata.patchedClaimIds.has(claimId))) return false;
      }
      if (type === 'projections') {
        const supports = projectionSupportIds(record);
        if ([...supports.claimIds].some(
          (claimId) => metadata.patchedClaimIds.has(claimId),
        )) return false;
        if ([...supports.eventIds].some(
          (eventId) => metadata.patchedEventIds.has(eventId),
        )) return false;
        const periodKey = record?.period?.key;
        if (
          record?.projectionType
          && periodKey
          && metadata.patchedProjectionPeriods.has(
            `${record.projectionType}\0${periodKey}`,
          )
        ) return false;
      }
    }

    const appended = [];
    for (const record of records) {
      const effective = { ...record };
      const id = String(effective[idField]);
      if (type === 'events') {
        const claimIds = EVENT_CLAIM_FIELDS.flatMap(
          (field) => effective[field] || [],
        ).map(String);
        if (claimIds.some((claimId) => (
          !metadata.claimsById.has(claimId)
          || metadata.claimsById.get(claimId)?.verificationStatus !== 'supported'
        ))) {
          effective.status = 'invalidated';
          effective.stale = true;
          effective.staleReason = 'supporting_claim_changed';
          cache.state.cascade.event = [...new Set([
            ...(cache.state.cascade.event || []),
            id,
          ])].sort();
        }
      }
      if (type === 'projections' && !effective.humanContent && !effective.humanAuthoredPeriod) {
        const supports = projectionSupportIds(effective);
        const stale = [...supports.claimIds].some((claimId) => (
          !metadata.claimsById.has(claimId)
          || metadata.claimsById.get(claimId)?.verificationStatus !== 'supported'
        )) || [...supports.eventIds].some((eventId) => (
          !metadata.eventsById.has(eventId)
          || metadata.eventsById.get(eventId)?.status !== 'accepted'
        ));
        if (stale) {
          effective.status = 'stale';
          effective.stale = true;
          effective.autoEffective = false;
          effective.staleReason = 'supporting_semantic_record_changed';
          cache.state.cascade.projection = [...new Set([
            ...(cache.state.cascade.projection || []),
            id,
          ])].sort();
        }
      }
      appended.push(effective);
    }

    for (const effective of appended) {
      const id = String(effective[idField]);
      state[type].push(effective);
      metadata[`${type}ById`].set(id, effective);
      if (type === 'events') {
        for (const claimId of EVENT_CLAIM_FIELDS.flatMap(
          (field) => effective[field] || [],
        )) {
          if (!metadata.claimsById.has(String(claimId))) {
            addDependency(metadata.eventsByMissingClaimId, claimId, id);
          }
        }
      }
      if (type === 'projections') {
        const supports = projectionSupportIds(effective);
        for (const claimId of supports.claimIds) {
          if (!metadata.claimsById.has(claimId)) {
            addDependency(metadata.projectionsByMissingClaimId, claimId, id);
          }
        }
        for (const eventId of supports.eventIds) {
          if (!metadata.eventsById.has(eventId)) {
            addDependency(metadata.projectionsByMissingEventId, eventId, id);
          }
        }
      }
    }
    cache.revisions[type] = revision;
    if (typeof this.testHooks?.onResolvedStateIncrement === 'function') {
      this.testHooks.onResolvedStateIncrement({ type, records: appended.length });
    }
    return true;
  }

  isTransactionCommitted(transactionId) {
    return String(this.cursor().transactionId || '') === String(transactionId || '');
  }

  withLock(operation) {
    ensurePrivateDirectory(this.directory);
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd;
    while (fd === undefined) {
      try {
        fd = fs.openSync(this.paths.lock, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.clock() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        releaseStaleLock(this.paths.lock);
        if (Date.now() >= deadline) {
          const locked = new Error('semantic memory store 写入锁超时');
          locked.code = 'SEMANTIC_MEMORY_LOCK_TIMEOUT';
          throw locked;
        }
        waitSync(20);
      }
    }
    try {
      return operation();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(this.paths.lock); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fsyncDirectory(this.directory);
    }
  }

  _appendUnique(filePath, idField, records) {
    const candidates = records || [];
    if (candidates.length === 0) return 0;
    const wantedIds = new Set(candidates.map((record) => String(record?.[idField] || '')));
    if (wantedIds.has('')) {
      throw new Error(`${path.basename(filePath)} record 缺少 ${idField}`);
    }
    const index = this._journalIndex(filePath, idField);
    const semanticType = this._semanticJournalType(filePath);
    const incrementalCache = semanticType ? this._currentResolvedCache() : null;
    const plannedIds = new Set();
    const appendedRecords = [];
    let bytesWritten = 0;
    for (const record of candidates) {
      const id = String(record?.[idField] || '');
      if (index.ids.has(id) || plannedIds.has(id)) continue;
      bytesWritten += appendFsynced(filePath, record);
      plannedIds.add(id);
      appendedRecords.push(record);
    }
    const finishedIndex = this._finishJournalAppend(
      filePath,
      index,
      appendedRecords,
      bytesWritten,
    );
    if (semanticType && appendedRecords.length) {
      const incremented = incrementalCache
        && finishedIndex === index
        && this._resolvedStateCache === incrementalCache
        && this._incrementResolvedUnique(
          semanticType,
          appendedRecords,
          finishedIndex.revision,
        );
      if (!incremented) this._resolvedStateCache = null;
    }
    return appendedRecords.length;
  }

  _appendRevisions(filePath, idField, records) {
    const candidates = records || [];
    if (candidates.length === 0) return 0;
    const index = this._journalIndex(filePath, idField);
    const plannedRevisions = new Set();
    const appendedRecords = [];
    let bytesWritten = 0;
    for (const record of candidates) {
      const id = String(record?.[idField] || '');
      const transactionId = String(record?.transactionId || '');
      if (!id || !transactionId) {
        throw new Error(`${path.basename(filePath)} revision 缺少 ${idField}/transactionId`);
      }
      const revisionKey = `${id}\0${transactionId}`;
      if (index.revisionKeys.has(revisionKey) || plannedRevisions.has(revisionKey)) continue;
      bytesWritten += appendFsynced(filePath, record);
      plannedRevisions.add(revisionKey);
      appendedRecords.push(record);
    }
    this._finishJournalAppend(filePath, index, appendedRecords, bytesWritten);
    if (this._semanticJournalType(filePath) && appendedRecords.length) {
      // Revisions can change effective records and cascade into arbitrary older
      // events/projections, so only the full resolver may accept them.
      this._resolvedStateCache = null;
    }
    return appendedRecords.length;
  }

  /**
   * Commit order is deliberate:
   *   journals fsync -> manifest atomic rename -> cursor atomic rename.
   * If the process dies before cursor, replay scans stable record ids and only
   * appends missing records. The cursor therefore never points beyond durable
   * claim/event data.
   */
  commitPacket({
    transactionId,
    packetId,
    source,
    ingestionCursor,
    claims = [],
    events = [],
    failures = [],
    packetManifest = null,
    reviewRecord = null,
  }) {
    if (!transactionId || !packetId) {
      throw new Error('commitPacket 缺少 transactionId 或 packetId');
    }
    return this.withLock(() => {
      const cursorBefore = this.cursor();
      if (this.isTransactionCommitted(transactionId)) {
        return {
          replayed: true,
          cursor: cursorBefore,
          appended: { packets: 0, packetReviews: 0, claims: 0, events: 0, failures: 0 },
        };
      }
      const committedAt = this.clock();
      const decorate = (records) => (records || []).map((record) => ({
        ...record,
        transactionId,
        packetId,
        committedAt,
      }));
      const isReview = Boolean(reviewRecord);
      const appended = {
        packets: packetManifest
          ? this._appendUnique(this.paths.packets, 'packetId', decorate([packetManifest]))
          : 0,
        packetReviews: reviewRecord
          ? this._appendUnique(
              this.paths.packetReviews,
              'reviewId',
              decorate([reviewRecord]),
            )
          : 0,
        claims: isReview
          ? this._appendRevisions(this.paths.claims, 'claimId', decorate(claims))
          : this._appendUnique(this.paths.claims, 'claimId', decorate(claims)),
        events: isReview
          ? this._appendRevisions(this.paths.events, 'eventId', decorate(events))
          : this._appendUnique(this.paths.events, 'eventId', decorate(events)),
        failures: this._appendUnique(this.paths.failures, 'failureId', decorate(failures)),
      };
      const manifestBefore = this.manifest();
      const nextCounts = { ...(manifestBefore?.recordCounts || {}) };
      for (const [key, count] of Object.entries(appended)) {
        nextCounts[key] = Number(nextCounts[key] || 0) + count;
      }
      atomicWriteJson(this.paths.manifest, {
        ...manifestBefore,
        schemaVersion: STORE_VERSION,
        storeType: this.storeType,
        mode: this.mode,
        updatedAt: committedAt,
        lastCommittedTransactionId: transactionId,
        lastCommittedPacketId: packetId,
        recordCounts: nextCounts,
      });
      if (typeof this.testHooks?.beforeCursorCommit === 'function') {
        this.testHooks.beforeCursorCommit({
          transactionId,
          packetId,
          appended,
        });
      }
      const cursor = {
        schemaVersion: STORE_VERSION,
        source: source || null,
        ingestionCursor: ingestionCursor ?? null,
        packetId,
        transactionId,
        committedAt,
      };
      atomicWriteJson(this.paths.cursor, cursor);
      return { replayed: false, cursor, appended };
    });
  }

  recordFailure(failure) {
    const failureId = String(failure?.failureId || '');
    if (!failureId) throw new Error('recordFailure 缺少 failureId');
    return this.withLock(() => {
      const appended = this._appendUnique(
        this.paths.failures,
        'failureId',
        [{ ...failure, committedAt: this.clock() }],
      );
      if (appended) {
        const manifest = this.manifest();
        atomicWriteJson(this.paths.manifest, {
          ...manifest,
          updatedAt: this.clock(),
          recordCounts: {
            ...(manifest?.recordCounts || {}),
            failures: Number(manifest?.recordCounts?.failures || 0) + appended,
          },
        });
      }
      return { appended };
    });
  }

  appendProjections(projections) {
    return this.withLock(() => {
      const committedAt = this.clock();
      const records = (projections || []).map((projection) => ({
        ...projection,
        committedAt,
      }));
      const appended = this._appendUnique(
        this.paths.projections,
        'projectionId',
        records,
      );
      if (appended) {
        const manifest = this.manifest();
        atomicWriteJson(this.paths.manifest, {
          ...manifest,
          updatedAt: committedAt,
          recordCounts: {
            ...(manifest?.recordCounts || {}),
            projections: Number(manifest?.recordCounts?.projections || 0) + appended,
          },
        });
      }
      return { appended };
    });
  }

  appendPatch(patch) {
    return this.withLock(() => {
      const appended = this._appendUnique(
        this.paths.patches,
        'patchId',
        [{ ...patch, committedAt: this.clock() }],
      );
      if (appended) {
        const manifest = this.manifest();
        atomicWriteJson(this.paths.manifest, {
          ...manifest,
          updatedAt: this.clock(),
          recordCounts: {
            ...(manifest?.recordCounts || {}),
            patches: Number(manifest?.recordCounts?.patches || 0) + appended,
          },
        });
      }
      return { appended };
    });
  }

  resolvedState() {
    const snapshots = this._semanticSnapshots();
    const { claims, events, projections, patches, entities, revisions } = snapshots;
    if (
      this._resolvedStateCache
      && Object.entries(revisions).every(
        ([key, revision]) => this._resolvedStateCache.revisions[key] === revision,
      )
    ) {
      return this._resolvedStateCache.state;
    }
    const state = resolveSemanticState({
      claims: [...claims.latest.values()],
      events: [...events.latest.values()],
      projections: [...projections.latest.values()],
      entities: entities.value.entities || [],
      patches: [...patches.latest.values()],
    });
    this._resolvedStateCache = {
      revisions,
      state,
      metadata: buildResolvedStateMetadata(state, [...patches.latest.values()]),
    };
    if (typeof this.testHooks?.onResolvedStateRebuild === 'function') {
      this.testHooks.onResolvedStateRebuild({
        counts: {
          claims: state.claims.length,
          events: state.events.length,
          projections: state.projections.length,
          patches: patches.latest.size,
        },
      });
    }
    return state;
  }

  claims({ applyPatches = true } = {}) {
    if (applyPatches) return this.resolvedState().claims;
    return this._latestJournalRecords(this.paths.claims, 'claimId');
  }

  events({ applyPatches = true } = {}) {
    if (applyPatches) return this.resolvedState().events;
    return this._latestJournalRecords(this.paths.events, 'eventId');
  }

  packetReviews() {
    return this._latestJournalRecords(this.paths.packetReviews, 'reviewId');
  }

  _latestPacketReviewLookup(
    reviews = this._journalIndex(this.paths.packetReviews, 'reviewId'),
  ) {
    if (
      this._packetReviewLookupCache
      && this._packetReviewLookupCache.reviewRevision === reviews.revision
    ) {
      return this._packetReviewLookupCache.byPacketId;
    }
    const byPacketId = latestPacketReviewsByPacket([...reviews.latest.values()]);
    this._packetReviewLookupCache = {
      reviewRevision: reviews.revision,
      byPacketId,
    };
    if (typeof this.testHooks?.onPacketReviewLookupRebuild === 'function') {
      this.testHooks.onPacketReviewLookupRebuild({
        reviews: reviews.latest.size,
        packetsWithReviews: byPacketId.size,
      });
    }
    return byPacketId;
  }

  packets({ applyReviews = true } = {}) {
    const packets = this._journalIndex(this.paths.packets, 'packetId');
    if (!applyReviews) return [...packets.latest.values()];
    const reviews = this._journalIndex(this.paths.packetReviews, 'reviewId');
    if (
      this._reviewedPacketsCache
      && this._reviewedPacketsCache.packetRevision === packets.revision
      && this._reviewedPacketsCache.reviewRevision === reviews.revision
    ) {
      return this._reviewedPacketsCache.packets;
    }
    const latestReviewByPacket = this._latestPacketReviewLookup(reviews);
    const resolved = [...packets.latest.values()].map((packet) => applyPacketReview(
      packet,
      latestReviewByPacket.get(String(packet?.packetId || '')),
      { humanResolutionLabel: this.humanResolutionLabel },
    ));
    this._reviewedPacketsCache = {
      packetRevision: packets.revision,
      reviewRevision: reviews.revision,
      packets: resolved,
      byId: new Map(resolved.map((packet) => [String(packet.packetId), packet])),
    };
    if (typeof this.testHooks?.onReviewedPacketsRebuild === 'function') {
      this.testHooks.onReviewedPacketsRebuild({
        packets: packets.latest.size,
        reviews: reviews.latest.size,
      });
    }
    return resolved;
  }

  packet(packetId, { applyReviews = true } = {}) {
    const id = String(packetId || '');
    if (!id) return null;
    const packet = this._journalIndex(this.paths.packets, 'packetId').latest.get(id) || null;
    if (!packet || !applyReviews) return packet;
    return applyPacketReview(
      packet,
      this._latestPacketReviewLookup().get(id),
      { humanResolutionLabel: this.humanResolutionLabel },
    );
  }

  projections({ applyPatches = true } = {}) {
    if (applyPatches) return this.resolvedState().projections;
    return this._latestJournalRecords(this.paths.projections, 'projectionId');
  }

  patches() {
    return this._latestJournalRecords(this.paths.patches, 'patchId');
  }

  failures() {
    return this._latestJournalRecords(this.paths.failures, 'failureId');
  }
}

module.exports = {
  DEFAULT_CURSOR,
  STORE_VERSION,
  SemanticMemoryStore,
  applyPacketReviews,
  appendFsynced,
  atomicWriteJson,
  ensurePrivateDirectory,
  jsonlHasId,
  readJson,
  readLatestJsonl,
  resolveSemanticState,
  sha256Json,
  visitJsonl,
};
