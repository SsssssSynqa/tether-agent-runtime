'use strict';

const crypto = require('node:crypto');

const {
  claimTuple,
  codePoints,
  isHighRiskClaim,
  sha256Text,
  validateClaim,
  validateEvent,
  validateRawMessages,
} = require('./semantic-memory-validators.js');
const { normalizeMemoryPolicy } = require('./memory-policy.js');

const PIPELINE_VERSION = 'semantic-memory-v1';
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
const IMPORTANCE_DIMENSIONS = Object.freeze([
  'explicitUserSignal',
  'commitmentOrBoundary',
  'identityOrRelationshipChange',
  'consequenceAndRepair',
  'persistence',
  'noveltyOrCorrection',
  'futureRetrievalValue',
  'emotionalImpact',
]);
const NAMING_PREDICATES = new Set([
  'addresses_as',
  'uses_nickname_for',
  'renamed_to',
  'requests_address_as',
  'accepts_request',
  'rejects_request',
  'corrects',
]);

function stableHash(value, length = 32) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
    .digest('hex')
    .slice(0, length);
}

function parseIso(value, field) {
  const text = String(value || '');
  if (!text || Number.isNaN(Date.parse(text))) {
    throw new Error(`${field} 不是合法 ISO 时间`);
  }
  return new Date(text).toISOString();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalizeReadableEntityNames(value, entities = []) {
  let text = String(value || '');
  const replacements = [];
  for (const entity of entities || []) {
    const canonical = String(entity?.canonicalDisplayName || entity?.entityId || '').trim();
    if (!canonical) continue;
    for (const alias of [
      entity?.entityId,
      ...(entity?.botDisplayNames || []),
    ]) {
      const source = String(alias || '').trim();
      if (source && source !== canonical) replacements.push([source, canonical]);
    }
  }
  replacements.sort((left, right) => right[0].length - left[0].length);
  for (const [source, canonical] of replacements) {
    text = text.replace(new RegExp(escapeRegExp(source), 'giu'), canonical);
  }
  return text;
}

function canonicalizeOwnerNarration(value, {
  entityIds = [],
  predicate = null,
  memoryPolicy = {},
  entities = [],
} = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const ids = new Set((entityIds || []).map(String).filter(Boolean));
  if (
    !ids.has(policy.owner.entityId)
    || NAMING_PREDICATES.has(String(predicate || ''))
  ) {
    return String(value || '');
  }
  let text = String(value || '');
  for (const disallowedName of policy.owner.semanticDisallowedDisplayNames) {
    const belongsToOtherEntity = (entities || []).some((entity) => (
      entity?.entityId
      && entity.entityId !== policy.owner.entityId
      && ids.has(String(entity.entityId))
      && [
        entity.canonicalDisplayName,
        ...(entity.aliasDisplayNames || []),
        ...(entity.botDisplayNames || []),
      ].map(String).includes(disallowedName)
    ));
    if (belongsToOtherEntity) continue;
    text = text.replace(
      new RegExp(escapeRegExp(disallowedName), 'gu'),
      policy.owner.displayName,
    );
  }
  return text;
}

function normalizeRawMessage(message, index = 0) {
  if (!message || typeof message !== 'object') {
    throw new Error(`rawMessages[${index}] 不是对象`);
  }
  const text = String(message.text ?? '');
  const messageId = String(message.messageId || '');
  const conversationId = String(message.conversationId || '');
  const senderEntityId = String(message.senderEntityId || '');
  if (!messageId || !conversationId || !senderEntityId) {
    throw new Error(`rawMessages[${index}] 缺少 messageId/conversationId/senderEntityId`);
  }
  const expectedHash = sha256Text(text);
  if (message.textSha256 && String(message.textSha256) !== expectedHash) {
    throw new Error(`rawMessages[${index}] textSha256 不匹配`);
  }
  return {
    messageId,
    conversationId,
    channel: String(message.channel || 'session'),
    chatId: message.chatId == null ? null : String(message.chatId),
    senderEntityId,
    senderDisplayName: String(message.senderDisplayName || senderEntityId),
    sentAt: parseIso(message.sentAt, `rawMessages[${index}].sentAt`),
    replyToMessageId: message.replyToMessageId == null
      ? null
      : String(message.replyToMessageId),
    replyTargetAvailable: message.replyTargetAvailable !== false,
    text,
    textSha256: expectedHash,
    archiveRef: String(message.archiveRef || ''),
    ingestionCursor: String(message.ingestionCursor ?? messageId),
    tombstone: message.tombstone === true,
    attachmentRefs: Array.isArray(message.attachmentRefs)
      ? message.attachmentRefs.map(String)
      : [],
  };
}

function createSemanticPacket({
  rawMessages,
  source,
  cursorStart = null,
  cursorEnd = null,
  packetId = null,
} = {}) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error('semantic packet 至少需要一条 raw message');
  }
  const normalized = rawMessages.map(normalizeRawMessage);
  const conversations = new Set(normalized.map((message) => message.conversationId));
  if (conversations.size !== 1) {
    throw new Error('semantic packet 不允许跨 conversation');
  }
  const sourceName = String(source || normalized[0].channel || 'session');
  const stablePayload = normalized.map((message) => ({
    messageId: message.messageId,
    textSha256: message.textSha256,
    ingestionCursor: message.ingestionCursor,
  }));
  const resolvedPacketId = packetId || `packet:${stableHash({
    source: sourceName,
    conversationId: normalized[0].conversationId,
    messages: stablePayload,
  })}`;
  return {
    schemaVersion: 1,
    packetId: resolvedPacketId,
    source: sourceName,
    conversationId: normalized[0].conversationId,
    cursorStart: cursorStart ?? normalized[0].ingestionCursor,
    cursorEnd: cursorEnd ?? normalized.at(-1).ingestionCursor,
    rawMessages: normalized,
    rawMessageCount: normalized.length,
    rawDigest: stableHash(stablePayload, 64),
    occurredFrom: normalized[0].sentAt,
    occurredTo: normalized.at(-1).sentAt,
  };
}

function codePointIndexOf(text, quote) {
  const textPoints = codePoints(text);
  const quotePoints = codePoints(quote);
  if (quotePoints.length === 0) return [];
  const matches = [];
  outer:
  for (let start = 0; start <= textPoints.length - quotePoints.length; start += 1) {
    for (let offset = 0; offset < quotePoints.length; offset += 1) {
      if (textPoints[start + offset] !== quotePoints[offset]) continue outer;
    }
    matches.push(start);
  }
  return matches;
}

function normalizeEvidence(candidateEvidence, rawById) {
  if (!candidateEvidence || typeof candidateEvidence !== 'object') {
    throw new Error('claim evidence 不是对象');
  }
  const messageId = String(candidateEvidence.messageId || '');
  const source = rawById.get(messageId);
  if (!source) throw new Error(`claim evidence source 不存在：${messageId}`);
  const quote = String(candidateEvidence.quote ?? '');
  if (!quote) throw new Error(`claim evidence quote 为空：${messageId}`);
  const matches = codePointIndexOf(source.text, quote);
  let start = Number(candidateEvidence.start);
  let end = Number(candidateEvidence.end);
  if (
    Number.isInteger(start)
    && Number.isInteger(end)
    && codePoints(source.text).slice(start, end).join('') === quote
  ) {
    // The model-supplied offsets are accepted only after exact deterministic proof.
  } else if (matches.length === 1) {
    [start] = matches;
    end = start + codePoints(quote).length;
  } else if (matches.length === 0) {
    // 带上模型实际给出的 quote 片段：排障时需要比对模型改写了什么（省略号、
    // 全半角、增删空白），只有 messageId 的话每个案例都得盲猜。截断防日志爆炸。
    const error = new Error(`claim evidence quote 不在 raw source：${messageId}`);
    error.details = {
      messageId,
      quoteHead: quote.slice(0, 200),
      quoteLength: quote.length,
      sourceTextSha256: source.textSha256 || null,
    };
    throw error;
  } else {
    throw new Error(`claim evidence quote 在 raw source 中不唯一：${messageId}`);
  }
  return {
    messageId,
    offsetUnit: 'unicode_code_point',
    start,
    end,
    quote,
    textSha256: source.textSha256,
    role: candidateEvidence.role ? String(candidateEvidence.role) : undefined,
  };
}

function candidateReference(candidate, index) {
  return String(candidate.localId || candidate.claimRef || candidate.claimId || `candidate-${index}`);
}

function normalizeClaimCandidate(candidate, {
  packet,
  rawById,
  now,
  extractorModel,
  extractorPromptVersion,
  memoryPolicy,
  entities,
  index,
}) {
  const evidence = (candidate.evidence || []).map(
    (item) => normalizeEvidence(item, rawById),
  );
  const tuple = {
    kind: candidate.kind,
    speakerEntityId: candidate.speakerEntityId ?? null,
    subjectEntityId: candidate.subjectEntityId ?? null,
    predicate: candidate.predicate,
    objectEntityId: candidate.objectEntityId ?? null,
    objectLiteral: candidate.objectLiteral ?? null,
    targetEntityId: candidate.targetEntityId ?? null,
    polarity: candidate.polarity || 'positive',
    modality: candidate.modality || 'asserted',
    temporalQualifier: candidate.temporalQualifier ?? null,
    numericQualifiers: Array.isArray(candidate.numericQualifiers)
      ? candidate.numericQualifiers.map(String)
      : [],
  };
  const claimId = `claim:${stableHash({
    packetId: packet.packetId,
    tuple,
    evidence: evidence.map((item) => [item.messageId, item.start, item.end]),
  })}`;
  return {
    claimId,
    kind: tuple.kind,
    observedAt: parseIso(
      candidate.observedAt || rawById.get(evidence[0]?.messageId)?.sentAt || packet.occurredFrom,
      `claims[${index}].observedAt`,
    ),
    speakerEntityId: tuple.speakerEntityId,
    subjectEntityId: tuple.subjectEntityId,
    predicate: String(tuple.predicate || ''),
    objectEntityId: tuple.objectEntityId,
    objectLiteral: tuple.objectLiteral == null ? null : String(tuple.objectLiteral),
    targetEntityId: tuple.targetEntityId,
    polarity: tuple.polarity,
    modality: tuple.modality,
    temporalQualifier: tuple.temporalQualifier == null
      ? null
      : String(tuple.temporalQualifier),
    numericQualifiers: tuple.numericQualifiers,
    content: canonicalizeOwnerNarration(
      canonicalizeReadableEntityNames(candidate.content, entities),
      {
        predicate: tuple.predicate,
        entityIds: [
          candidate.speakerEntityId,
          tuple.subjectEntityId,
          tuple.objectEntityId,
          tuple.targetEntityId,
        ],
        memoryPolicy,
        entities,
      },
    ),
    epistemicStatus: candidate.epistemicStatus || 'explicit',
    evidence,
    verificationStatus: 'pending',
    verifierNotes: [],
    verifierVerdicts: [],
    extractorModel: String(candidate.extractorModel || extractorModel || 'unknown'),
    extractorPromptVersion: String(
      candidate.extractorPromptVersion || extractorPromptVersion || 'unknown',
    ),
    createdAt: now,
    supersedesClaimIds: Array.isArray(candidate.supersedesClaimIds)
      ? candidate.supersedesClaimIds.map(String)
      : [],
    hardPreserve: candidate.hardPreserve === true,
  };
}

function requiredVerifierFields(claim) {
  const fields = new Set(['predicate', 'polarity', 'modality']);
  if (claim.speakerEntityId) fields.add('speaker');
  if (claim.subjectEntityId) fields.add('subject');
  if (claim.objectEntityId || claim.objectLiteral != null) fields.add('object');
  if (claim.targetEntityId) fields.add('target');
  if (claim.temporalQualifier) fields.add('time');
  if (claim.numericQualifiers.length) fields.add('number');
  if (['causes', 'motivates'].includes(claim.predicate)) fields.add('causality');
  if (claim.kind === 'emotion') fields.add('emotion');
  return [...fields];
}

function normalizeVerifierResult(result, verifierName) {
  const verdicts = Array.isArray(result) ? result : result?.verdicts;
  if (!Array.isArray(verdicts)) {
    throw new Error(`${verifierName} 没有返回 verdicts 数组`);
  }
  return verdicts.map((verdict) => ({
    field: String(verdict.field || ''),
    verdict: String(verdict.verdict || ''),
    reason: String(verdict.reason || ''),
    evidence: Array.isArray(verdict.evidence) ? verdict.evidence : [],
    verifier: verifierName,
  }));
}

function validateVerifierEvidence(verdicts, packet) {
  const rawById = new Map(
    packet.rawMessages.map((message) => [String(message.messageId), message]),
  );
  return verdicts.map((verdict) => {
    if (verdict.verdict !== 'supported') return verdict;
    try {
      if (!Array.isArray(verdict.evidence) || verdict.evidence.length === 0) {
        throw new Error(`${verdict.verifier}:${verdict.field} supported 但没有 evidence`);
      }
      return {
        ...verdict,
        evidence: verdict.evidence.map((evidence) => normalizeEvidence(evidence, rawById)),
      };
    } catch (error) {
      return {
        ...verdict,
        verdict: 'insufficient',
        reason: `supported evidence invalid: ${error.message}`,
        evidence: [],
        evidenceValidationError: String(error.message || error),
      };
    }
  });
}

function deterministicSourceVerdicts(claim, packet) {
  const rawById = new Map(
    packet.rawMessages.map((message) => [String(message.messageId), message]),
  );
  const directEvidence = (claim.evidence || []).filter(
    (evidence) => evidence.role !== 'quoted_statement',
  );
  if (
    claim.speakerEntityId
    && directEvidence.length > 0
    && directEvidence.every((evidence) => (
      String(rawById.get(String(evidence.messageId))?.senderEntityId || '')
      === String(claim.speakerEntityId)
    ))
  ) {
    return [{
      field: 'speaker',
      verdict: 'supported',
      reason: 'trusted raw message senderEntityId matches the claim speaker',
      evidence: directEvidence,
      verifier: 'source-envelope',
    }];
  }
  return [];
}

function verdictMap(verdicts) {
  const map = new Map();
  for (const verdict of verdicts) {
    if (!['supported', 'contradicted', 'insufficient'].includes(verdict.verdict)) continue;
    map.set(verdict.field, verdict);
  }
  return map;
}

function resolveVerificationStatus(
  claim,
  primaryVerdicts,
  secondaryVerdicts = null,
  deterministicVerdicts = [],
) {
  const required = requiredVerifierFields(claim);
  const primary = verdictMap(primaryVerdicts);
  const secondary = secondaryVerdicts ? verdictMap(secondaryVerdicts) : null;
  const deterministic = verdictMap(deterministicVerdicts);
  const missing = [];
  for (const field of required) {
    const first = primary.get(field);
    const second = secondary?.get(field);
    const source = deterministic.get(field);
    if (source?.verdict === 'contradicted') {
      return { status: 'contradicted', missing: [], required };
    }
    if (source?.verdict === 'supported') continue;
    if (first?.verdict === 'contradicted' || second?.verdict === 'contradicted') {
      return { status: 'contradicted', missing: [], required };
    }
    if (!first || first.verdict !== 'supported') missing.push(`primary:${field}`);
    if (secondary && (!second || second.verdict !== 'supported')) {
      missing.push(`secondary:${field}`);
    }
  }
  return {
    status: missing.length ? 'insufficient' : 'supported',
    missing,
    required,
  };
}

function failureRecord({
  packetId,
  stage,
  code,
  message,
  candidateRef = null,
  details = null,
  reviewAttempt = 0,
  now,
}) {
  const body = {
    packetId,
    stage,
    code,
    message: String(message || ''),
    candidateRef,
    details,
    reviewAttempt: Number(reviewAttempt || 0),
  };
  return {
    failureId: `failure:${stableHash(body)}`,
    ...body,
    createdAt: now,
  };
}

function claimIdsFromEventCandidate(candidate, field, refToClaimId) {
  return (Array.isArray(candidate[field]) ? candidate[field] : [])
    .map((ref) => refToClaimId.get(String(ref)))
    .filter(Boolean);
}

function deterministicImportance(event, claimsById, memoryPolicy = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const allClaimIds = [...new Set(EVENT_CLAIM_FIELDS.flatMap((field) => event[field]))];
  const claims = allClaimIds.map((id) => claimsById.get(id)).filter(Boolean);
  const rationale = new Set();
  const hardPreserveReasons = new Set();
  const dimensions = Object.fromEntries(IMPORTANCE_DIMENSIONS.map((name) => [name, 0]));
  const mark = (dimension, value, matchingClaims, reason = null) => {
    if (!matchingClaims.length) return;
    dimensions[dimension] = Math.max(dimensions[dimension], Math.min(2, value));
    matchingClaims.forEach((claim) => rationale.add(claim.claimId));
    if (reason) hardPreserveReasons.add(reason);
  };

  const explicitSignal = claims.filter((claim) => (
    claim.speakerEntityId === policy.owner.entityId
    && /记住|很重要|别忘|以后|长期|永远|必须/.test(
      `${claim.content}\n${claim.objectLiteral || ''}`,
    )
  ));
  mark('explicitUserSignal', 2, explicitSignal, explicitSignal.length ? 'explicit_user_signal' : null);
  const commitments = claims.filter((claim) => ['commitment', 'boundary'].includes(claim.kind));
  mark('commitmentOrBoundary', 2, commitments, commitments.length ? 'commitment_or_boundary' : null);
  const identity = claims.filter((claim) => ['identity', 'address'].includes(claim.kind));
  mark(
    'identityOrRelationshipChange',
    2,
    identity,
    identity.length ? 'identity_or_address' : null,
  );
  const consequence = [
    ...event.consequenceClaimIds,
    ...event.laterActionClaimIds,
    ...event.repairClaimIds,
  ].map((id) => claimsById.get(id)).filter(Boolean);
  mark('consequenceAndRepair', consequence.length > 1 ? 2 : 1, consequence);
  const corrections = claims.filter((claim) => (
    claim.kind === 'correction' || claim.supersedesClaimIds.length > 0
  ));
  mark('noveltyOrCorrection', 2, corrections, corrections.length ? 'correction' : null);
  const retrieval = claims.filter((claim) => (
    claim.hardPreserve
    || ['preference', 'commitment', 'boundary', 'identity', 'address', 'correction'].includes(claim.kind)
  ));
  mark('futureRetrievalValue', retrieval.some((claim) => claim.hardPreserve) ? 2 : 1, retrieval);
  const emotions = claims.filter((claim) => claim.kind === 'emotion');
  mark('emotionalImpact', emotions.length > 1 ? 2 : 1, emotions);
  if (event.unresolvedClaimIds.length) {
    const unresolved = event.unresolvedClaimIds.map((id) => claimsById.get(id)).filter(Boolean);
    mark('persistence', 1, unresolved, 'unresolved');
  }
  const score = IMPORTANCE_DIMENSIONS.reduce(
    (sum, dimension) => sum + dimensions[dimension],
    0,
  );
  return {
    ...dimensions,
    score,
    rationaleClaimIds: [...rationale],
    hardPreserveReasons: [...hardPreserveReasons],
  };
}

function normalizeEventCandidate(candidate, {
  packet,
  refToClaimId,
  claimsById,
  memoryPolicy,
  entities,
  index,
}) {
  const event = {
    eventId: '',
    title: canonicalizeOwnerNarration(
      canonicalizeReadableEntityNames(
        candidate.title || `已核验事件 ${index + 1}`,
        entities,
      ),
      {
        entityIds: candidate.participantEntityIds,
        memoryPolicy,
        entities,
      },
    ),
    occurredFrom: parseIso(candidate.occurredFrom || packet.occurredFrom, 'event.occurredFrom'),
    occurredTo: parseIso(candidate.occurredTo || packet.occurredTo, 'event.occurredTo'),
    participantEntityIds: Array.isArray(candidate.participantEntityIds)
      ? [...new Set(candidate.participantEntityIds.map(String))]
      : [],
    relationEdges: [],
    importance: null,
    status: 'pending',
  };
  for (const field of EVENT_CLAIM_FIELDS) {
    const requestedRefs = Array.isArray(candidate[field]) ? candidate[field].map(String) : [];
    const missingRefs = requestedRefs.filter((ref) => !refToClaimId.has(ref));
    if (missingRefs.length) {
      throw new Error(`${field} 引用了未通过 claim：${missingRefs.join(', ')}`);
    }
    event[field] = claimIdsFromEventCandidate(candidate, field, refToClaimId);
  }
  event.relationEdges = (Array.isArray(candidate.relationEdges) ? candidate.relationEdges : [])
    .map((relation) => {
      const fromClaimId = refToClaimId.get(String(relation.fromClaimId || relation.fromClaimRef));
      const toClaimId = refToClaimId.get(String(relation.toClaimId || relation.toClaimRef));
      const evidenceClaimIds = (relation.evidenceClaimIds || relation.evidenceClaimRefs || [])
        .map((ref) => refToClaimId.get(String(ref)))
        .filter(Boolean);
      return {
        fromClaimId,
        toClaimId,
        type: String(relation.type || 'associated_with'),
        explicit: relation.explicit === true,
        evidenceClaimIds,
        status: relation.status || 'pending',
      };
    })
    .filter((relation) => relation.fromClaimId && relation.toClaimId);
  const referencedIds = [...new Set(EVENT_CLAIM_FIELDS.flatMap((field) => event[field]))];
  const referencedClaims = referencedIds.map((id) => claimsById.get(id)).filter(Boolean);
  event.status = referencedClaims.length > 0
    && referencedClaims.every((claim) => claim.verificationStatus === 'supported')
    ? 'accepted'
    : 'uncertain';
  for (const relation of event.relationEdges) {
    const relationClaims = [
      claimsById.get(relation.fromClaimId),
      claimsById.get(relation.toClaimId),
      ...relation.evidenceClaimIds.map((id) => claimsById.get(id)),
    ].filter(Boolean);
    if (
      relationClaims.every((claim) => claim.verificationStatus === 'supported')
      && (
        !['causes', 'motivates'].includes(relation.type)
        || (relation.explicit && relation.evidenceClaimIds.length > 0)
      )
    ) {
      relation.status = 'supported';
    } else {
      relation.status = 'insufficient';
      if (['causes', 'motivates'].includes(relation.type)) event.status = 'uncertain';
    }
  }
  event.eventId = `event:${stableHash({
    packetId: packet.packetId,
    title: event.title,
    claimIds: referencedIds,
    relations: event.relationEdges,
  })}`;
  event.importance = deterministicImportance(event, claimsById, memoryPolicy);
  return event;
}

function semanticPromptPayload(packet, entities, partialReview = null) {
  return {
    pipelineVersion: PIPELINE_VERSION,
    packetId: packet.packetId,
    entities,
    rawMessages: packet.rawMessages,
    ...(partialReview ? { partialReview } : {}),
  };
}

function canonicalizeRawSenderEntities(rawMessages, sourceEntities, canonicalEntities) {
  const sourceById = new Map(
    (sourceEntities || []).map((entity) => [String(entity.entityId || ''), entity]),
  );
  const canonicalIds = new Set(
    (canonicalEntities || []).map((entity) => String(entity.entityId || '')),
  );
  return (rawMessages || []).map((message) => {
    const senderEntityId = String(message?.senderEntityId || '');
    const canonicalEntityId = String(
      sourceById.get(senderEntityId)?.canonicalEntityId || '',
    );
    if (!canonicalEntityId) return message;
    if (!canonicalIds.has(canonicalEntityId)) {
      throw new Error(
        `raw sender alias ${senderEntityId} 指向未注册 canonical entity ${canonicalEntityId}`,
      );
    }
    return { ...message, senderEntityId: canonicalEntityId };
  });
}

class SemanticMemoryPipeline {
  constructor({
    store,
    entities = [],
    sourceEntities = entities,
    extract,
    verify,
    verifyHighRisk = null,
    extractorModel = 'unknown',
    extractorPromptVersion = 'semantic-extractor-v1',
    requireSecondaryHighRisk = true,
    memoryPolicy = {},
    clock = () => new Date().toISOString(),
    log = console.log,
  } = {}) {
    if (!store) throw new Error('SemanticMemoryPipeline 缺少 store');
    if (typeof extract !== 'function') throw new Error('SemanticMemoryPipeline 缺少 extract');
    if (typeof verify !== 'function') throw new Error('SemanticMemoryPipeline 缺少 verify');
    this.store = store;
    this.entities = entities;
    // `entities` 是只允许 extractor/claims 使用的 canonical registry；历史 raw
    // packet 可能保留 canonicalization 之前的 Telegram alias ID。sourceEntities
    // 保留完整 append-only 来源注册表，只用于验证 raw sender 的确存在以及为模型
    // 映射到 canonical ID，绝不因此允许 claims 写回 alias ID。
    this.sourceEntities = sourceEntities;
    this.extract = extract;
    this.verify = verify;
    this.verifyHighRisk = verifyHighRisk;
    this.extractorModel = extractorModel;
    this.extractorPromptVersion = extractorPromptVersion;
    this.requireSecondaryHighRisk = requireSecondaryHighRisk;
    this.memoryPolicy = normalizeMemoryPolicy(memoryPolicy);
    this.clock = clock;
    this.log = log;
    this.store.initialize({ entities: sourceEntities });
  }

  async _verifyClaim(claim, packet) {
    const modelRawMessages = canonicalizeRawSenderEntities(
      packet.rawMessages,
      this.sourceEntities,
      this.entities,
    );
    const context = {
      pipelineVersion: PIPELINE_VERSION,
      packetId: packet.packetId,
      entities: this.entities,
      rawMessages: modelRawMessages,
      claim: { ...claim, verificationStatus: 'pending' },
      requiredFields: requiredVerifierFields(claim),
    };
    let primaryVerdicts;
    let secondaryVerdicts = null;
    const notes = [];
    const runVerifier = async (verifier, verifierName) => {
      const verifyOnce = async (verificationRepair = null) => {
        const payload = verificationRepair
          ? { ...context, verificationRepair }
          : context;
        return validateVerifierEvidence(
          normalizeVerifierResult(await verifier(payload), verifierName),
          packet,
        );
      };
      let verdicts = await verifyOnce();
      const invalid = verdicts.filter((verdict) => verdict.evidenceValidationError);
      if (invalid.length === 0) return verdicts;
      notes.push(
        `${verifierName} verifier evidence repair requested: `
        + invalid.map((verdict) => verdict.field).join(', '),
      );
      verdicts = await verifyOnce({
        reason: 'invalid_exact_quote',
        fields: invalid.map((verdict) => verdict.field),
      });
      return verdicts;
    };
    try {
      primaryVerdicts = await runVerifier(this.verify, 'primary');
    } catch (error) {
      primaryVerdicts = context.requiredFields.map((field) => ({
        field,
        verdict: 'insufficient',
        reason: `primary verifier unavailable: ${error.message}`,
        evidence: [],
        verifier: 'primary',
      }));
      notes.push(`primary verifier unavailable: ${error.message}`);
    }
    if (isHighRiskClaim(claim)) {
      if (typeof this.verifyHighRisk === 'function') {
        try {
          secondaryVerdicts = await runVerifier(this.verifyHighRisk, 'secondary');
        } catch (error) {
          secondaryVerdicts = context.requiredFields.map((field) => ({
            field,
            verdict: 'insufficient',
            reason: `secondary verifier unavailable: ${error.message}`,
            evidence: [],
            verifier: 'secondary',
          }));
          notes.push(`secondary verifier unavailable: ${error.message}`);
        }
      } else if (this.requireSecondaryHighRisk) {
        secondaryVerdicts = context.requiredFields.map((field) => ({
          field,
          verdict: 'insufficient',
          reason: 'secondary verifier is required for high-risk claim',
          evidence: [],
          verifier: 'secondary',
        }));
        notes.push('secondary verifier missing for high-risk claim');
      }
    }
    const deterministicVerdicts = deterministicSourceVerdicts(claim, packet);
    const resolution = resolveVerificationStatus(
      claim,
      primaryVerdicts,
      secondaryVerdicts,
      deterministicVerdicts,
    );
    if (resolution.missing.length) {
      notes.push(`unsupported required slots: ${resolution.missing.join(', ')}`);
    }
    return {
      ...claim,
      verificationStatus: resolution.status,
      verifierNotes: notes,
      verifierVerdicts: [
        ...deterministicVerdicts,
        ...primaryVerdicts,
        ...(secondaryVerdicts || []),
      ],
    };
  }

  async processPacket(packetInput, {
    reviewAttempt = 0,
    priorFailures = [],
    supersedesTransactionId = null,
  } = {}) {
    const packet = packetInput?.rawMessages
      ? createSemanticPacket(packetInput)
      : packetInput;
    if (!packet?.packetId || !Array.isArray(packet.rawMessages)) {
      throw new Error('processPacket 收到无效 packet');
    }
    const rawErrors = validateRawMessages(packet.rawMessages, this.sourceEntities);
    if (rawErrors.length) {
      throw new Error(`raw packet 未通过确定性验证：${rawErrors[0].message}`);
    }
    const modelRawMessages = canonicalizeRawSenderEntities(
      packet.rawMessages,
      this.sourceEntities,
      this.entities,
    );
    // 一切"拿模型输出与来源比对"的判定都必须站在模型看见的那个视图上。模型被
    // 喂的是 canonical sender，如果验证却拿原始 alias 比对，家族 bot 以别名发出
    // 的消息上承载的 claim 会在 P0-ACTOR（speaker 必须等于来源 sender）上必然
    // 被拒——而且模型再也看不到 alias，这个拒绝对它来说完全无法规避。
    // canonicalizeRawSenderEntities 只替换 senderEntityId，text/messageId/
    // textSha256 全部原样，因此 evidence quote 校验不受任何影响。
    const modelPacket = { ...packet, rawMessages: modelRawMessages };
    const transactionId = `transaction:${stableHash({
      pipelineVersion: PIPELINE_VERSION,
      packetId: packet.packetId,
      rawDigest: packet.rawDigest,
      reviewAttempt: Number(reviewAttempt || 0),
    })}`;
    if (this.store.isTransactionCommitted(transactionId)) {
      const review = Number(reviewAttempt || 0) > 0
        ? this.store.packetReviews().find((item) => item.transactionId === transactionId)
        : null;
      const canonicalPacket = review
        ? null
        : this.store.packets({ applyReviews: false })
          .find((item) => item.transactionId === transactionId);
      return {
        status: review?.status || canonicalPacket?.status || 'replayed',
        packetId: packet.packetId,
        transactionId,
        packetManifest: review || canonicalPacket || null,
        claims: [],
        events: [],
        failures: [],
        review,
        replayed: true,
      };
    }
    const now = this.clock();
    let extracted;
    try {
      extracted = await this.extract(semanticPromptPayload(
        modelPacket,
        this.entities,
        Number(reviewAttempt || 0) > 0
          ? {
              attempt: Number(reviewAttempt),
              priorFailures: (priorFailures || []).map((failure) => ({
                stage: String(failure?.stage || 'unknown'),
                code: String(failure?.code || 'unknown'),
                candidateRef: failure?.candidateRef == null
                  ? null
                  : String(failure.candidateRef),
                reason: String(failure?.message || '').slice(0, 500),
              })),
            }
          : null,
      ));
    } catch (error) {
      const failure = failureRecord({
        packetId: packet.packetId,
        stage: 'extract',
        code: 'EXTRACTOR_UNAVAILABLE',
        message: error.message,
        reviewAttempt,
        now,
      });
      this.store.recordFailure(failure);
      const retryable = new Error(`semantic extractor 失败，cursor 未推进：${error.message}`);
      retryable.cause = error;
      retryable.retryable = true;
      throw retryable;
    }
    if (!extracted || typeof extracted !== 'object') {
      throw new Error('semantic extractor 返回值不是对象');
    }
    const rawById = new Map(
      packet.rawMessages.map((message) => [String(message.messageId), message]),
    );
    const claims = [];
    const failures = [];
    if (Number(reviewAttempt || 0) > 0 && extracted.noSignal === true) {
      failures.push(failureRecord({
        packetId: packet.packetId,
        stage: 'extract',
        code: 'PARTIAL_REVIEW_NO_SIGNAL_CONFLICT',
        message: 'partial packet 重审不能用 noSignal 静默消解既有拒绝证据',
        reviewAttempt,
        now,
      }));
    }
    const refToClaimId = new Map();
    for (const [index, candidate] of (extracted.claims || []).entries()) {
      const ref = candidateReference(candidate, index);
      try {
        const normalized = normalizeClaimCandidate(candidate, {
          packet,
          rawById,
          now,
          extractorModel: this.extractorModel,
          extractorPromptVersion: this.extractorPromptVersion,
          memoryPolicy: this.memoryPolicy,
          entities: this.entities,
          index,
        });
        const deterministicErrors = validateClaim(
          normalized,
          modelRawMessages,
          this.entities,
        );
        if (deterministicErrors.length) {
          throw new Error(deterministicErrors.map((error) => error.message).join('; '));
        }
        const verified = await this._verifyClaim(normalized, modelPacket);
        const finalErrors = validateClaim(verified, modelRawMessages, this.entities);
        if (finalErrors.length) {
          throw new Error(finalErrors.map((error) => error.message).join('; '));
        }
        claims.push(verified);
        refToClaimId.set(ref, verified.claimId);
        // 空串不能当映射 key：event 引用数组若含 ""，missingRefs 检查会被绕过并
        // 解析到最后一个成功 claim，引用被悄悄污染指向无关内容。
        if (candidate.claimId) refToClaimId.set(String(candidate.claimId), verified.claimId);
      } catch (error) {
        failures.push(failureRecord({
          packetId: packet.packetId,
          stage: 'claim',
          code: 'CLAIM_REJECTED',
          message: error.message,
          candidateRef: ref,
          details: error.details || null,
          reviewAttempt,
          now,
        }));
      }
    }
    const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
    const events = [];
    for (const [index, candidate] of (extracted.events || []).entries()) {
      const ref = String(candidate.localId || candidate.eventId || `event-${index}`);
      try {
        const event = normalizeEventCandidate(candidate, {
          packet,
          refToClaimId,
          claimsById,
          memoryPolicy: this.memoryPolicy,
          entities: this.entities,
          index,
        });
        const eventErrors = validateEvent(event, claimsById);
        if (eventErrors.length) {
          throw new Error(eventErrors.map((error) => error.message).join('; '));
        }
        events.push(event);
      } catch (error) {
        failures.push(failureRecord({
          packetId: packet.packetId,
          stage: 'event',
          code: 'EVENT_REJECTED',
          message: error.message,
          candidateRef: ref,
          reviewAttempt,
          now,
        }));
      }
    }
    const acceptedClaims = claims.filter(
      (claim) => claim.verificationStatus === 'supported',
    ).length;
    const acceptedEvents = events.filter((event) => event.status === 'accepted').length;
    const packetManifest = {
      recordType: 'semantic-packet',
      packetId: packet.packetId,
      source: packet.source,
      conversationId: packet.conversationId,
      cursorStart: packet.cursorStart,
      cursorEnd: packet.cursorEnd,
      ingestionCursor: packet.cursorEnd,
      rawMessageCount: packet.rawMessageCount,
      rawMessageIds: packet.rawMessages.map((message) => message.messageId),
      rawDigest: packet.rawDigest,
      occurredFrom: packet.occurredFrom,
      occurredTo: packet.occurredTo,
      extractorNoSignal: extracted.noSignal === true,
      noSignalAudit: extracted.noSignalAudit?.triggered === true
        ? {
            triggered: true,
            hintCount: Number(extracted.noSignalAudit.hintCount) || 0,
            persistedNoSignal: extracted.noSignalAudit.persistedNoSignal === true,
          }
        : null,
      status: failures.length ? 'partial' : 'committed',
      counts: {
        candidates: (extracted.claims || []).length,
        claims: claims.length,
        acceptedClaims,
        events: events.length,
        acceptedEvents,
        failures: failures.length,
      },
      pipelineVersion: PIPELINE_VERSION,
      reviewAttempt: Number(reviewAttempt || 0),
    };
    const reviewId = Number(reviewAttempt || 0) > 0
      ? `packet-review:${stableHash({
          packetId: packet.packetId,
          rawDigest: packet.rawDigest,
          reviewAttempt: Number(reviewAttempt),
          pipelineVersion: PIPELINE_VERSION,
        })}`
      : null;
    const reviewRecord = reviewId
      ? {
          ...packetManifest,
          recordType: 'semantic-packet-review',
          reviewId,
          reviewAttempt: Number(reviewAttempt),
          supersedesTransactionId: supersedesTransactionId || null,
          priorFailureIds: (priorFailures || [])
            .map((failure) => String(failure?.failureId || ''))
            .filter(Boolean),
          createdAt: now,
        }
      : null;
    const committed = this.store.commitPacket({
      transactionId,
      packetId: packet.packetId,
      source: packet.source,
      ingestionCursor: packet.cursorEnd,
      packetManifest: reviewRecord ? null : packetManifest,
      reviewRecord,
      claims,
      events,
      failures,
    });
    return {
      status: committed.replayed ? 'replayed' : packetManifest.status,
      packetId: packet.packetId,
      transactionId,
      packetManifest,
      claims,
      events,
      failures,
      review: reviewRecord,
      committed,
    };
  }
}

module.exports = {
  EVENT_CLAIM_FIELDS,
  IMPORTANCE_DIMENSIONS,
  PIPELINE_VERSION,
  SemanticMemoryPipeline,
  canonicalizeOwnerNarration,
  canonicalizeReadableEntityNames,
  codePointIndexOf,
  createSemanticPacket,
  deterministicImportance,
  normalizeEvidence,
  normalizeRawMessage,
  deterministicSourceVerdicts,
  requiredVerifierFields,
  resolveVerificationStatus,
  stableHash,
};
