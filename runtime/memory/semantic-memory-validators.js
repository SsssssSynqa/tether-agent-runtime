// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');

const CLAIM_KINDS = new Set([
  'speech',
  'action',
  'state',
  'preference',
  'commitment',
  'boundary',
  'identity',
  'address',
  'correction',
  'interpretation',
  'emotion',
  'outcome',
]);

const POLARITIES = new Set(['positive', 'negative']);
const MODALITIES = new Set([
  'asserted',
  'requested',
  'promised',
  'possible',
  'sarcastic',
]);
const EPISTEMIC_STATUSES = new Set(['explicit', 'inferred', 'unknown']);
const VERIFICATION_STATUSES = new Set([
  'pending',
  'supported',
  'contradicted',
  'insufficient',
  'invalidated',
]);
const AUTHORITATIVE_STATUSES = new Set(['supported']);

const HIGH_RISK_KINDS = new Set([
  'commitment',
  'boundary',
  'identity',
  'address',
  'correction',
  'emotion',
]);

const HIGH_RISK_PREDICATES = new Set([
  'addresses_as',
  'uses_nickname_for',
  'renamed_to',
  'requests_address_as',
  'accepts_request',
  'rejects_request',
  'promises',
  'forbids',
  'permits',
  'revokes',
  'corrects',
  'causes',
  'motivates',
]);

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function codePoints(value) {
  return Array.from(String(value));
}

function sliceCodePoints(value, start, end) {
  return codePoints(value).slice(start, end).join('');
}

function entityIds(registry) {
  if (Array.isArray(registry)) {
    return new Set(registry.map((entry) => String(entry.entityId)));
  }
  return new Set(Object.keys(registry || {}));
}

function rawMessageMap(rawMessages) {
  return new Map((rawMessages || []).map((message) => [String(message.messageId), message]));
}

function pushError(errors, code, message, details = {}) {
  errors.push({ code, message, ...details });
}

function validateRawMessages(rawMessages, registry) {
  const errors = [];
  const ids = new Set();
  const entities = entityIds(registry);
  for (const [index, message] of (rawMessages || []).entries()) {
    const pointer = `rawMessages[${index}]`;
    if (!message || typeof message !== 'object') {
      pushError(errors, 'SCHEMA-RAW', `${pointer} must be an object`);
      continue;
    }
    const messageId = String(message.messageId || '');
    if (!messageId) pushError(errors, 'SCHEMA-RAW', `${pointer}.messageId is required`);
    if (ids.has(messageId)) {
      pushError(errors, 'P0-EVIDENCE', `duplicate raw message id ${messageId}`, { messageId });
    }
    ids.add(messageId);
    if (!entities.has(String(message.senderEntityId || ''))) {
      pushError(
        errors,
        'P0-ENTITY',
        `${pointer}.senderEntityId is not in registry`,
        { messageId, senderEntityId: message.senderEntityId || null },
      );
    }
    if (typeof message.text !== 'string') {
      pushError(errors, 'SCHEMA-RAW', `${pointer}.text must be a string`, { messageId });
    } else if (message.textSha256 !== sha256Text(message.text)) {
      pushError(errors, 'P0-EVIDENCE', `${pointer}.textSha256 does not match`, { messageId });
    }
    if (message.replyToMessageId) {
      const replyId = String(message.replyToMessageId);
      const sameConversation = (rawMessages || []).some(
        (candidate) => String(candidate.messageId) === replyId,
      );
      if (!sameConversation && message.replyTargetAvailable !== false) {
        pushError(
          errors,
          'P0-EVIDENCE',
          `${pointer}.replyToMessageId is missing from fixture`,
          { messageId, replyToMessageId: replyId },
        );
      }
    }
  }
  return errors;
}

function validateEvidenceSpan(evidence, messages, claimId = null) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object') {
    pushError(errors, 'P0-EVIDENCE', 'evidence must be an object', { claimId });
    return errors;
  }
  const messageId = String(evidence.messageId || '');
  const message = messages.get(messageId);
  if (!message) {
    pushError(errors, 'P0-EVIDENCE', `evidence source ${messageId} does not exist`, {
      claimId,
      messageId,
    });
    return errors;
  }
  if (evidence.offsetUnit !== 'unicode_code_point') {
    pushError(errors, 'P0-EVIDENCE', 'evidence offsetUnit must be unicode_code_point', {
      claimId,
      messageId,
    });
  }
  const start = Number(evidence.start);
  const end = Number(evidence.end);
  const length = codePoints(message.text).length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > length) {
    pushError(errors, 'P0-EVIDENCE', 'evidence range is invalid', {
      claimId,
      messageId,
      start: evidence.start,
      end: evidence.end,
      sourceLength: length,
    });
    return errors;
  }
  const actualQuote = sliceCodePoints(message.text, start, end);
  if (actualQuote !== evidence.quote) {
    pushError(errors, 'P0-EVIDENCE', 'evidence quote is not the exact source span', {
      claimId,
      messageId,
      expectedQuote: actualQuote,
      actualQuote: evidence.quote,
    });
  }
  if (evidence.textSha256 !== message.textSha256) {
    pushError(errors, 'P0-EVIDENCE', 'evidence raw hash does not match source', {
      claimId,
      messageId,
    });
  }
  return errors;
}

function validateClaim(claim, rawMessages, registry) {
  const errors = [];
  const messages = rawMessageMap(rawMessages);
  const entities = entityIds(registry);
  const claimId = String(claim?.claimId || '');
  if (!claim || typeof claim !== 'object') {
    pushError(errors, 'SCHEMA-CLAIM', 'claim must be an object');
    return errors;
  }
  if (!claimId) pushError(errors, 'SCHEMA-CLAIM', 'claimId is required');
  if (!CLAIM_KINDS.has(claim.kind)) {
    pushError(errors, 'SCHEMA-CLAIM', `invalid claim kind ${claim.kind}`, { claimId });
  }
  if (!claim.predicate || typeof claim.predicate !== 'string') {
    pushError(errors, 'SCHEMA-CLAIM', 'predicate is required', { claimId });
  }
  if (!POLARITIES.has(claim.polarity)) {
    pushError(errors, 'SCHEMA-CLAIM', `invalid polarity ${claim.polarity}`, { claimId });
  }
  if (!MODALITIES.has(claim.modality)) {
    pushError(errors, 'SCHEMA-CLAIM', `invalid modality ${claim.modality}`, { claimId });
  }
  if (!EPISTEMIC_STATUSES.has(claim.epistemicStatus)) {
    pushError(
      errors,
      'SCHEMA-CLAIM',
      `invalid epistemicStatus ${claim.epistemicStatus}`,
      { claimId },
    );
  }
  if (!VERIFICATION_STATUSES.has(claim.verificationStatus)) {
    pushError(
      errors,
      'SCHEMA-CLAIM',
      `invalid verificationStatus ${claim.verificationStatus}`,
      { claimId },
    );
  }
  for (const field of ['speakerEntityId', 'subjectEntityId', 'objectEntityId', 'targetEntityId']) {
    const value = claim[field];
    if (value !== null && value !== undefined && !entities.has(String(value))) {
      pushError(errors, 'P0-ENTITY', `${field} is not in entity registry`, {
        claimId,
        field,
        entityId: value,
      });
    }
  }
  if (!Array.isArray(claim.numericQualifiers)) {
    pushError(errors, 'SCHEMA-CLAIM', 'numericQualifiers must be an array', { claimId });
  }
  if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
    if (claim.epistemicStatus !== 'unknown') {
      pushError(errors, 'P0-EVIDENCE', 'non-unknown claim requires evidence', { claimId });
    }
  } else {
    for (const evidence of claim.evidence) {
      errors.push(...validateEvidenceSpan(evidence, messages, claimId));
    }
  }

  if (claim.speakerEntityId && Array.isArray(claim.evidence)) {
    for (const evidence of claim.evidence) {
      const source = messages.get(String(evidence.messageId));
      if (
        source
        && String(source.senderEntityId) !== String(claim.speakerEntityId)
        && evidence.role !== 'quoted_statement'
      ) {
        pushError(errors, 'P0-ACTOR', 'claim speaker differs from source sender', {
          claimId,
          speakerEntityId: claim.speakerEntityId,
          sourceSenderEntityId: source.senderEntityId,
          messageId: evidence.messageId,
        });
      }
    }
  }

  if (
    AUTHORITATIVE_STATUSES.has(claim.verificationStatus)
    && claim.epistemicStatus === 'unknown'
  ) {
    pushError(errors, 'P0-EVIDENCE', 'unknown claim cannot be authoritative', { claimId });
  }
  return errors;
}

function claimTuple(claim) {
  return {
    kind: claim.kind || null,
    speakerEntityId: claim.speakerEntityId ?? null,
    subjectEntityId: claim.subjectEntityId ?? null,
    predicate: claim.predicate || null,
    objectEntityId: claim.objectEntityId ?? null,
    objectLiteral: claim.objectLiteral ?? null,
    targetEntityId: claim.targetEntityId ?? null,
    polarity: claim.polarity || null,
    modality: claim.modality || null,
    temporalQualifier: claim.temporalQualifier ?? null,
    numericQualifiers: Array.isArray(claim.numericQualifiers)
      ? [...claim.numericQualifiers].map(String).sort()
      : [],
  };
}

function claimSignature(claim) {
  return JSON.stringify(claimTuple(claim));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function classifyTupleMismatch(gold, candidate) {
  const actorFields = ['speakerEntityId', 'subjectEntityId', 'objectEntityId', 'targetEntityId'];
  if (actorFields.some((field) => !sameValue(gold[field], candidate[field]))) {
    return 'P0-ACTOR';
  }
  if (!sameValue(gold.predicate, candidate.predicate) || !sameValue(gold.kind, candidate.kind)) {
    return 'P0-PREDICATE';
  }
  if (!sameValue(gold.polarity, candidate.polarity)) return 'P0-POLARITY';
  if (!sameValue(gold.modality, candidate.modality)) return 'P0-POLARITY';
  if (
    !sameValue(gold.temporalQualifier, candidate.temporalQualifier)
    || !sameValue(gold.numericQualifiers, candidate.numericQualifiers)
  ) {
    return 'P0-QUALIFIER';
  }
  return 'P1-MISMATCH';
}

function mismatchDistance(gold, candidate) {
  const fields = Object.keys(gold);
  return fields.reduce(
    (distance, field) => distance + (sameValue(gold[field], candidate[field]) ? 0 : 1),
    0,
  );
}

function isHighRiskClaim(claim) {
  return HIGH_RISK_KINDS.has(claim.kind) || HIGH_RISK_PREDICATES.has(claim.predicate);
}

function validateEvent(event, claimsById) {
  const errors = [];
  const eventId = String(event?.eventId || '');
  if (!event || typeof event !== 'object') {
    pushError(errors, 'SCHEMA-EVENT', 'event must be an object');
    return errors;
  }
  if (!eventId) pushError(errors, 'SCHEMA-EVENT', 'eventId is required');
  const claimFields = [
    'initialStateClaimIds',
    'triggerClaimIds',
    'interpretationClaimIds',
    'emotionOrStanceClaimIds',
    'actionClaimIds',
    'consequenceClaimIds',
    'laterActionClaimIds',
    'repairClaimIds',
    'unresolvedClaimIds',
  ];
  for (const field of claimFields) {
    if (!Array.isArray(event[field])) {
      pushError(errors, 'SCHEMA-EVENT', `${field} must be an array`, { eventId });
      continue;
    }
    for (const claimId of event[field]) {
      const claim = claimsById.get(String(claimId));
      if (!claim) {
        pushError(errors, 'P0-EVIDENCE', `${field} references missing claim`, {
          eventId,
          claimId,
        });
      } else if (event.status === 'accepted' && claim.verificationStatus !== 'supported') {
        pushError(errors, 'P0-CASCADE', 'accepted event references non-supported claim', {
          eventId,
          claimId,
          verificationStatus: claim.verificationStatus,
        });
      }
    }
  }
  for (const relation of Array.isArray(event.relationEdges) ? event.relationEdges : []) {
    if (!claimsById.has(String(relation.fromClaimId))) {
      pushError(errors, 'P0-EVIDENCE', 'relation fromClaimId is missing', {
        eventId,
        claimId: relation.fromClaimId,
      });
    }
    if (!claimsById.has(String(relation.toClaimId))) {
      pushError(errors, 'P0-EVIDENCE', 'relation toClaimId is missing', {
        eventId,
        claimId: relation.toClaimId,
      });
    }
    if (
      ['causes', 'motivates'].includes(relation.type)
      && relation.status === 'supported'
      && (!relation.explicit || !Array.isArray(relation.evidenceClaimIds)
        || relation.evidenceClaimIds.length === 0)
    ) {
      pushError(errors, 'P0-CAUSE', 'supported causal edge lacks explicit evidence', {
        eventId,
        relation,
      });
    }
  }
  return errors;
}

function validateProjection(projection, claimsById, eventsById) {
  const errors = [];
  const projectionId = String(projection?.projectionId || '');
  if (!projection || typeof projection !== 'object') {
    pushError(errors, 'SCHEMA-PROJECTION', 'projection must be an object');
    return errors;
  }
  if (!projectionId) pushError(errors, 'SCHEMA-PROJECTION', 'projectionId is required');
  for (const sentence of Array.isArray(projection.sentences) ? projection.sentences : []) {
    const claimIds = Array.isArray(sentence.supportClaimIds) ? sentence.supportClaimIds : [];
    const eventIds = Array.isArray(sentence.supportEventIds) ? sentence.supportEventIds : [];
    if (claimIds.length === 0 && eventIds.length === 0) {
      pushError(errors, 'P0-EVIDENCE', 'authoritative sentence lacks support ids', {
        projectionId,
        sentenceId: sentence.sentenceId || null,
      });
    }
    for (const claimId of claimIds) {
      const claim = claimsById.get(String(claimId));
      if (!claim || claim.verificationStatus !== 'supported') {
        pushError(errors, 'P0-CASCADE', 'sentence references missing or unverified claim', {
          projectionId,
          sentenceId: sentence.sentenceId || null,
          claimId,
        });
      }
    }
    for (const eventId of eventIds) {
      const event = eventsById.get(String(eventId));
      if (!event || event.status !== 'accepted') {
        pushError(errors, 'P0-CASCADE', 'sentence references missing or unaccepted event', {
          projectionId,
          sentenceId: sentence.sentenceId || null,
          eventId,
        });
      }
    }
  }
  return errors;
}

function validateMemoryBundle(bundle) {
  const errors = [];
  const rawMessages = bundle?.rawMessages || [];
  const registry = bundle?.entities || [];
  errors.push(...validateRawMessages(rawMessages, registry));
  const claims = bundle?.claims || [];
  const claimIds = new Set();
  for (const claim of claims) {
    if (claimIds.has(String(claim.claimId))) {
      pushError(errors, 'P0-EVIDENCE', 'duplicate claim id', { claimId: claim.claimId });
    }
    claimIds.add(String(claim.claimId));
    errors.push(...validateClaim(claim, rawMessages, registry));
  }
  const claimsById = new Map(claims.map((claim) => [String(claim.claimId), claim]));
  const events = bundle?.events || [];
  const eventIds = new Set();
  for (const event of events) {
    if (eventIds.has(String(event.eventId))) {
      pushError(errors, 'P0-EVIDENCE', 'duplicate event id', { eventId: event.eventId });
    }
    eventIds.add(String(event.eventId));
    errors.push(...validateEvent(event, claimsById));
  }
  const eventsById = new Map(events.map((event) => [String(event.eventId), event]));
  for (const projection of bundle?.projections || []) {
    errors.push(...validateProjection(projection, claimsById, eventsById));
  }
  return {
    passed: errors.length === 0,
    errors,
    counts: {
      rawMessages: rawMessages.length,
      claims: claims.length,
      events: events.length,
      projections: (bundle?.projections || []).length,
    },
  };
}

function evaluateCandidate(fixture, candidate) {
  const validation = validateMemoryBundle({
    entities: fixture.entities,
    rawMessages: fixture.rawMessages,
    claims: candidate.claims || [],
    events: candidate.events || [],
    projections: candidate.projections || [],
  });
  const errors = [...validation.errors];
  const accepted = (candidate.claims || []).filter(
    (claim) => claim.verificationStatus === 'supported',
  );
  const acceptedBySignature = new Map(
    accepted.map((claim) => [claimSignature(claim), claim]),
  );
  const matchedCandidateIds = new Set();
  let requiredClaims = 0;
  let matchedRequiredClaims = 0;

  for (const goldClaim of fixture.goldClaims || []) {
    if (goldClaim.required === false) continue;
    requiredClaims += 1;
    const signature = claimSignature(goldClaim);
    const exact = acceptedBySignature.get(signature);
    if (exact) {
      matchedRequiredClaims += 1;
      matchedCandidateIds.add(String(exact.claimId));
      continue;
    }
    const goldTuple = claimTuple(goldClaim);
    const nearest = accepted
      .map((claim) => ({ claim, tuple: claimTuple(claim) }))
      .sort(
        (left, right) => mismatchDistance(goldTuple, left.tuple)
          - mismatchDistance(goldTuple, right.tuple),
      )[0];
    const code = nearest && mismatchDistance(goldTuple, nearest.tuple) <= 2
      ? classifyTupleMismatch(goldTuple, nearest.tuple)
      : (goldClaim.hardPreserve ? 'P0-TRIGGER' : 'P1-MISSING');
    pushError(errors, code, 'required gold claim is missing or changed', {
      goldClaimId: goldClaim.claimId,
      nearestCandidateClaimId: nearest?.claim?.claimId || null,
    });
  }

  for (const forbidden of fixture.forbiddenClaims || []) {
    const match = acceptedBySignature.get(claimSignature(forbidden.claim));
    if (match) {
      pushError(
        errors,
        forbidden.code || 'P0-PREDICATE',
        forbidden.reason || 'forbidden claim was accepted',
        { candidateClaimId: match.claimId },
      );
      matchedCandidateIds.add(String(match.claimId));
    }
  }

  if (fixture.exhaustiveClaims === true) {
    const goldSignatures = new Set((fixture.goldClaims || []).map(claimSignature));
    for (const claim of accepted) {
      if (goldSignatures.has(claimSignature(claim))) continue;
      if (matchedCandidateIds.has(String(claim.claimId))) continue;
      pushError(
        errors,
        isHighRiskClaim(claim) ? 'P0-PREDICATE' : 'P1-EXTRA',
        'authoritative claim is not supported by the exhaustive gold set',
        { candidateClaimId: claim.claimId },
      );
    }
  }

  const p0Errors = errors.filter((error) => String(error.code).startsWith('P0-'));
  return {
    passed: errors.length === 0,
    p0Passed: p0Errors.length === 0,
    errors,
    metrics: {
      requiredClaims,
      matchedRequiredClaims,
      hardPreserveRecall: requiredClaims === 0 ? 1 : matchedRequiredClaims / requiredClaims,
      p0Errors: p0Errors.length,
      totalErrors: errors.length,
    },
  };
}

module.exports = {
  AUTHORITATIVE_STATUSES,
  CLAIM_KINDS,
  EPISTEMIC_STATUSES,
  HIGH_RISK_KINDS,
  HIGH_RISK_PREDICATES,
  MODALITIES,
  POLARITIES,
  VERIFICATION_STATUSES,
  claimSignature,
  claimTuple,
  codePoints,
  evaluateCandidate,
  isHighRiskClaim,
  sha256Text,
  sliceCodePoints,
  validateClaim,
  validateEvidenceSpan,
  validateEvent,
  validateMemoryBundle,
  validateProjection,
  validateRawMessages,
};
