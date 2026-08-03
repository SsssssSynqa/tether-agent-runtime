'use strict';

const {
  EVENT_CLAIM_FIELDS,
  stableHash,
} = require('./semantic-memory-pipeline.js');
const {
  validateProjection,
} = require('./semantic-memory-validators.js');
const {
  addDays,
  dayPeriod,
  operationalDayKey,
  weekKeyForDay,
  weekPeriod,
} = require('./memory-time.js');
const { normalizeMemoryPolicy } = require('./memory-policy.js');

const PROJECTION_VERSION = 'semantic-projection-v1';
const PROJECTION_KINDS = new Set(['fold', 'day', 'week']);

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function periodFor(kind, periodKey, timePolicy = {}) {
  if (kind === 'day') return dayPeriod(periodKey, timePolicy);
  if (kind === 'week') return weekPeriod(periodKey, timePolicy);
  return { key: periodKey || null, startAt: null, endAt: null };
}

function overlaps(event, period) {
  if (!period.startAt || !period.endAt) return true;
  const from = new Date(event.occurredFrom).getTime();
  const to = new Date(event.occurredTo).getTime();
  return from <= new Date(period.endAt).getTime()
    && to >= new Date(period.startAt).getTime();
}

function eventClaimIds(event) {
  return unique(EVENT_CLAIM_FIELDS.flatMap((field) => event[field] || []));
}

function appendToBucket(buckets, key, record) {
  const normalized = String(key || '');
  if (!normalized) return;
  if (!buckets.has(normalized)) buckets.set(normalized, []);
  buckets.get(normalized).push(record);
}

function intervalDayKeys(event, maxDays = 370, timePolicy = {}) {
  const from = new Date(event?.occurredFrom).getTime();
  const to = new Date(event?.occurredTo).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  let first;
  let last;
  try {
    first = operationalDayKey(from, timePolicy);
    last = operationalDayKey(to, timePolicy);
  } catch (_) {
    return null;
  }
  const spanDays = Math.round(
    (new Date(`${last}T00:00:00.000Z`).getTime()
      - new Date(`${first}T00:00:00.000Z`).getTime())
    / (24 * 60 * 60 * 1000),
  );
  if (spanDays < 0 || spanDays > maxDays) return null;
  const keys = [];
  for (let offset = 0; offset <= spanDays; offset += 1) keys.push(addDays(first, offset));
  return keys;
}

function inOriginalEventOrder(events, order) {
  return [...new Map((events || []).map((event) => [String(event.eventId), event])).values()]
    .sort((left, right) => (
      (order.get(String(left.eventId)) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(String(right.eventId)) ?? Number.MAX_SAFE_INTEGER)
    ));
}

function inOriginalClaimOrder(claims, order) {
  return [...new Map((claims || []).map((claim) => [String(claim.claimId), claim])).values()]
    .sort((left, right) => (
      (order.get(String(left.claimId)) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(String(right.claimId)) ?? Number.MAX_SAFE_INTEGER)
    ));
}

function sentencePunctuation(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return /[。！？.!?]$/u.test(value) ? value : `${value}。`;
}

function deterministicSentences(events, claimsById) {
  const sentences = [];
  const emittedClaims = new Set();
  for (const event of events) {
    for (const field of EVENT_CLAIM_FIELDS) {
      for (const claimId of event[field] || []) {
        if (emittedClaims.has(claimId)) continue;
        const claim = claimsById.get(claimId);
        if (!claim || claim.verificationStatus !== 'supported') continue;
        const text = sentencePunctuation(claim.content);
        if (!text) continue;
        emittedClaims.add(claimId);
        sentences.push({
          sentenceId: `sentence:${stableHash({
            eventId: event.eventId,
            claimId,
            text,
          })}`,
          text,
          supportClaimIds: [claimId],
          supportEventIds: [event.eventId],
          verificationStatus: 'supported',
          verificationMode: 'verified-claim-content',
          slot: field,
        });
      }
    }
  }
  return sentences;
}

function hardPreserveSentences({
  claims,
  selectedClaimIds,
  period,
}) {
  const sentences = [];
  for (const claim of claims) {
    if (
      claim.verificationStatus !== 'supported'
      || (claim.hardPreserve !== true && claim.humanAuthored !== true)
      || selectedClaimIds.has(claim.claimId)
    ) continue;
    const observedAt = new Date(claim.observedAt).getTime();
    if (
      period.startAt
      && (
        observedAt < new Date(period.startAt).getTime()
        || observedAt > new Date(period.endAt).getTime()
      )
    ) continue;
    const text = sentencePunctuation(claim.content);
    if (!text) continue;
    sentences.push({
      sentenceId: `sentence:${stableHash({ claimId: claim.claimId, text })}`,
      text,
      supportClaimIds: [claim.claimId],
      supportEventIds: [],
      verificationStatus: 'supported',
      verificationMode: claim.humanAuthored
        ? 'human-patch-claim'
        : 'verified-hard-preserve-claim',
      slot: claim.humanAuthored ? 'humanPatch' : 'hardPreserve',
    });
  }
  return sentences;
}

function normalizeRenderedSentence(candidate, {
  index,
  allowedClaimIds,
  allowedEventIds,
}) {
  const text = sentencePunctuation(candidate?.text);
  if (!text) throw new Error(`rendered sentence ${index} 为空`);
  const supportClaimIds = unique(candidate.supportClaimIds);
  const supportEventIds = unique(candidate.supportEventIds);
  if (supportClaimIds.length === 0 && supportEventIds.length === 0) {
    throw new Error(`rendered sentence ${index} 没有 support ids`);
  }
  for (const claimId of supportClaimIds) {
    if (!allowedClaimIds.has(claimId)) {
      throw new Error(`rendered sentence ${index} 引用了未选中的 claim ${claimId}`);
    }
  }
  for (const eventId of supportEventIds) {
    if (!allowedEventIds.has(eventId)) {
      throw new Error(`rendered sentence ${index} 引用了未选中的 event ${eventId}`);
    }
  }
  return {
    sentenceId: `sentence:${stableHash({
      text,
      supportClaimIds,
      supportEventIds,
    })}`,
    text,
    supportClaimIds,
    supportEventIds,
    verificationStatus: 'pending',
    verificationMode: 'semantic-sentence-verifier',
    slot: candidate.slot ? String(candidate.slot) : null,
  };
}

function projectionTitle(kind, periodKey, agentDisplayName = 'Agent') {
  if (kind === 'fold') return `${agentDisplayName} verified fold · ${periodKey || 'packet'}`;
  if (kind === 'day') return `${agentDisplayName} verified day card · ${periodKey}`;
  return `${agentDisplayName} verified week card · ${periodKey}`;
}

class SemanticProjectionBuilder {
  constructor({
    store,
    render = null,
    verifySentence = null,
    memoryPolicy = {},
    clock = () => new Date().toISOString(),
    log = console.log,
    testHooks = null,
  } = {}) {
    if (!store) throw new Error('SemanticProjectionBuilder 缺少 store');
    this.store = store;
    this.render = typeof render === 'function' ? render : null;
    this.verifySentence = typeof verifySentence === 'function' ? verifySentence : null;
    this.memoryPolicy = normalizeMemoryPolicy(memoryPolicy);
    this.clock = clock;
    this.log = log;
    this.testHooks = testHooks;
    this._selectionIndexes = new WeakMap();
  }

  _selectionIndex(state) {
    const claims = state.claims;
    const events = state.events;
    let index = this._selectionIndexes.get(state);
    let rebuilt = false;
    if (
      !index
      || claims.length < index.claimCount
      || events.length < index.eventCount
    ) {
      rebuilt = true;
      index = {
        claims,
        claimsById: new Map(),
        claimOrder: new Map(),
        supportedEvents: [],
        preservedClaims: [],
        eventsByPacketId: new Map(),
        eventsByDayKey: new Map(),
        eventsByWeekKey: new Map(),
        unbucketedEvents: [],
        eventOrder: new Map(),
        preservedClaimsByPacketId: new Map(),
        preservedClaimsByDayKey: new Map(),
        preservedClaimsByWeekKey: new Map(),
        claimCount: 0,
        eventCount: 0,
      };
      this._selectionIndexes.set(state, index);
    }
    const claimCountBefore = index.claimCount;
    const eventCountBefore = index.eventCount;
    for (let offset = index.claimCount; offset < claims.length; offset += 1) {
      const claim = claims[offset];
      index.claimsById.set(claim.claimId, claim);
      index.claimOrder.set(String(claim.claimId), offset);
      if (
        claim.verificationStatus === 'supported'
        && (claim.hardPreserve === true || claim.humanAuthored === true)
      ) {
        index.preservedClaims.push(claim);
        appendToBucket(index.preservedClaimsByPacketId, claim.packetId, claim);
        const observedAt = new Date(claim.observedAt).getTime();
        if (Number.isFinite(observedAt)) {
          try {
            const dayKey = operationalDayKey(observedAt, this.memoryPolicy.time);
            appendToBucket(index.preservedClaimsByDayKey, dayKey, claim);
            appendToBucket(index.preservedClaimsByWeekKey, weekKeyForDay(dayKey), claim);
          } catch (_) {
            // Invalid/extreme timestamps remain available to fold-by-packet but
            // cannot belong to a trustworthy calendar bucket.
          }
        }
      }
    }
    index.claimCount = claims.length;
    for (let offset = index.eventCount; offset < events.length; offset += 1) {
      const event = events[offset];
      index.eventOrder.set(String(event.eventId), offset);
      if (
        event.status === 'accepted'
        && eventClaimIds(event).every(
          (claimId) => index.claimsById.get(claimId)?.verificationStatus === 'supported',
        )
      ) {
        index.supportedEvents.push(event);
        appendToBucket(index.eventsByPacketId, event.packetId, event);
        const dayKeys = intervalDayKeys(event, 370, this.memoryPolicy.time);
        if (!dayKeys) {
          index.unbucketedEvents.push(event);
        } else {
          const weekKeys = new Set();
          for (const dayKey of dayKeys) {
            appendToBucket(index.eventsByDayKey, dayKey, event);
            weekKeys.add(weekKeyForDay(dayKey));
          }
          for (const weekKey of weekKeys) appendToBucket(index.eventsByWeekKey, weekKey, event);
        }
      }
    }
    index.eventCount = events.length;
    if (
      typeof this.testHooks?.onSelectionIndexUpdate === 'function'
      && (rebuilt || claims.length > claimCountBefore || events.length > eventCountBefore)
    ) {
      this.testHooks.onSelectionIndexUpdate({
        rebuilt,
        claimsAdded: claims.length - claimCountBefore,
        eventsAdded: events.length - eventCountBefore,
      });
    }
    return index;
  }

  select({
    kind,
    periodKey = null,
    packetId = null,
    packetIds = null,
    semanticState = null,
  } = {}) {
    if (!PROJECTION_KINDS.has(kind)) throw new Error(`未知 projection kind：${kind}`);
    const foldPacketIds = unique(packetIds || (packetId ? [packetId] : []));
    if (kind === 'fold' && foldPacketIds.length === 0) {
      throw new Error('fold projection 缺少 packetId/packetIds');
    }
    if (kind !== 'fold' && !periodKey) throw new Error(`${kind} projection 缺少 periodKey`);
    const period = periodFor(kind, periodKey, this.memoryPolicy.time);
    const state = semanticState || this.store.resolvedState();
    if (!Array.isArray(state?.claims) || !Array.isArray(state?.events)) {
      throw new Error('projection semanticState 缺少 claims/events');
    }
    const index = this._selectionIndex(state);
    const primaryEventCandidates = kind === 'fold'
      ? foldPacketIds.flatMap((id) => index.eventsByPacketId.get(String(id)) || [])
      : kind === 'day'
        ? index.eventsByDayKey.get(String(periodKey)) || []
        : index.eventsByWeekKey.get(String(periodKey)) || [];
    const events = inOriginalEventOrder([
      ...primaryEventCandidates,
      ...(kind === 'fold'
        ? []
        : index.unbucketedEvents.filter((event) => overlaps(event, period))),
    ], index.eventOrder);
    const selectedClaimIds = new Set(events.flatMap(eventClaimIds));
    const preservedClaims = kind === 'fold'
      ? inOriginalClaimOrder(foldPacketIds.flatMap(
          (id) => index.preservedClaimsByPacketId.get(String(id)) || [],
        ), index.claimOrder)
      : kind === 'day'
        ? index.preservedClaimsByDayKey.get(String(periodKey)) || []
        : index.preservedClaimsByWeekKey.get(String(periodKey)) || [];
    for (const claim of preservedClaims) selectedClaimIds.add(claim.claimId);
    if (typeof this.testHooks?.onSelectionQuery === 'function') {
      this.testHooks.onSelectionQuery({
        kind,
        indexedEvents: index.supportedEvents.length,
        examinedEvents: primaryEventCandidates.length
          + (kind === 'fold' ? 0 : index.unbucketedEvents.length),
        selectedEvents: events.length,
        indexedPreservedClaims: index.preservedClaims.length,
        examinedPreservedClaims: preservedClaims.length,
      });
    }
    return {
      period,
      events,
      claims: index.claims,
      claimsById: index.claimsById,
      preservedClaims,
      selectedClaimIds,
      selectedClaims: [...selectedClaimIds]
        .map((id) => index.claimsById.get(id))
        .filter(Boolean),
      foldPacketIds,
    };
  }

  async _renderVerified(selection, request) {
    const hardPreserveClaims = request.kind === 'fold'
      ? selection.preservedClaims.filter((claim) => (
        selection.foldPacketIds.includes(String(claim.packetId))
      ))
      : selection.preservedClaims;
    const fallback = [
      ...deterministicSentences(selection.events, selection.claimsById),
      ...hardPreserveSentences({
        claims: hardPreserveClaims,
        selectedClaimIds: new Set(selection.events.flatMap(eventClaimIds)),
        period: selection.period,
      }),
    ];
    if (!this.render) {
      return {
        sentences: fallback,
        renderMode: 'deterministic',
        rendererFailure: null,
      };
    }
    try {
      const rendered = await this.render({
        projectionVersion: PROJECTION_VERSION,
        kind: request.kind,
        period: selection.period,
        packetId: request.packetId || null,
        packetIds: request.packetIds || [],
        events: selection.events,
        claims: selection.selectedClaims,
      });
      if (!Array.isArray(rendered?.sentences)) {
        throw new Error('renderer 没有返回 sentences 数组');
      }
      const allowedClaimIds = new Set(selection.selectedClaims.map((claim) => claim.claimId));
      const allowedEventIds = new Set(selection.events.map((event) => event.eventId));
      const normalized = rendered.sentences.map((sentence, index) => (
        normalizeRenderedSentence(sentence, {
          index,
          allowedClaimIds,
          allowedEventIds,
        })
      ));
      if (!this.verifySentence) {
        throw new Error('renderer 输出没有配置独立 sentence verifier');
      }
      const verified = [];
      for (const sentence of normalized) {
        const supportClaims = sentence.supportClaimIds
          .map((id) => selection.claimsById.get(id))
          .filter(Boolean);
        const supportEvents = sentence.supportEventIds
          .map((id) => selection.events.find((event) => event.eventId === id))
          .filter(Boolean);
        const verdict = await this.verifySentence({
          sentence,
          supportClaims,
          supportEvents,
        });
        if (verdict?.verdict !== 'supported') {
          throw new Error(
            `sentence verifier ${verdict?.verdict || 'invalid'}: ${verdict?.reason || sentence.sentenceId}`,
          );
        }
        verified.push({
          ...sentence,
          verificationStatus: 'supported',
          verifierReason: String(verdict.reason || ''),
        });
      }
      return {
        sentences: verified,
        renderMode: 'semantic-renderer',
        rendererFailure: null,
      };
    } catch (error) {
      this.log(`[semantic-memory] projection renderer fail-closed，使用 verified index：${error.message}`);
      return {
        sentences: fallback,
        renderMode: 'verified-index-fallback',
        rendererFailure: error.message,
      };
    }
  }

  async build({
    kind,
    periodKey = null,
    packetId = null,
    packetIds = null,
    append = true,
    semanticState = null,
  } = {}) {
    const selection = this.select({
      kind,
      periodKey,
      packetId,
      packetIds,
      semanticState,
    });
    const rendered = await this._renderVerified(selection, {
      kind,
      periodKey,
      packetId,
      packetIds: selection.foldPacketIds,
    });
    const supportClaimIds = unique(
      rendered.sentences.flatMap((sentence) => sentence.supportClaimIds),
    );
    const supportEventIds = unique(
      rendered.sentences.flatMap((sentence) => sentence.supportEventIds),
    );
    const sourceDigest = stableHash({
      kind,
      period: selection.period,
      packetId,
      packetIds: selection.foldPacketIds,
      supportClaimIds,
      supportEventIds,
      sentences: rendered.sentences.map((sentence) => sentence.text),
    }, 64);
    const status = rendered.sentences.length > 0 ? 'accepted' : 'unverified_index';
    const projection = {
      projectionId: `projection:${stableHash({
        version: PROJECTION_VERSION,
        kind,
        periodKey,
        packetId,
        packetIds: selection.foldPacketIds,
        sourceDigest,
      })}`,
      projectionVersion: PROJECTION_VERSION,
      projectionType: kind,
      title: projectionTitle(
        kind,
        periodKey || packetId,
        this.memoryPolicy.agent.displayName,
      ),
      period: selection.period,
      packetId,
      packetIds: selection.foldPacketIds,
      sentences: rendered.sentences,
      status,
      stale: false,
      sourceQuery: {
        layer: 'accepted-events-direct',
        eventStatus: 'accepted',
        claimStatus: 'supported',
        periodStartAt: selection.period.startAt,
        periodEndAt: selection.period.endAt,
        packetId,
        packetIds: selection.foldPacketIds,
        upstreamProjectionIds: [],
      },
      sourceDigest,
      supportClaimIds,
      supportEventIds,
      counts: {
        selectedClaims: selection.selectedClaims.length,
        selectedEvents: selection.events.length,
        sentences: rendered.sentences.length,
      },
      renderMode: rendered.renderMode,
      rendererFailure: rendered.rendererFailure,
      createdAt: this.clock(),
    };
    const validation = validateProjection(
      projection,
      selection.claimsById,
      new Map(selection.events.map((event) => [event.eventId, event])),
    );
    if (validation.length) {
      throw new Error(`projection 未通过确定性验证：${validation[0].message}`);
    }
    if (append) this.store.appendProjections([projection]);
    return projection;
  }

  async buildMany(requests, { append = true } = {}) {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error('buildMany 缺少 projection requests');
    }
    // A fold/day/week trio must be a coherent view of one semantic commit. It
    // also avoids resolving and re-reading the same append-only journals once
    // per projection kind.
    const semanticState = this.store.resolvedState();
    const projections = [];
    for (const request of requests) {
      projections.push(await this.build({
        ...request,
        // Preserve the existing per-projection durability boundary: if a later
        // renderer/validator fails, any earlier valid projection is still on
        // disk exactly as it was before buildMany existed.
        append,
        semanticState,
      }));
    }
    return projections;
  }
}

module.exports = {
  PROJECTION_KINDS,
  PROJECTION_VERSION,
  SemanticProjectionBuilder,
  deterministicSentences,
  eventClaimIds,
  normalizeRenderedSentence,
  overlaps,
  periodFor,
};
