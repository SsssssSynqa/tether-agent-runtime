// SPDX-License-Identifier: Apache-2.0
'use strict';

const PROPOSITION_CONTRACT_VERSION = 'semantic-proposition-contract-v1';

// polarity describes whether the predicate relation holds; modality describes
// the represented proposition, not merely whether the source sentence uses an
// imperative or question mark. These lines are shared by extractor and both
// verifier prompts so the ontology is not re-invented independently per call.
const PROPOSITION_CONTRACT_PROMPT_LINES = Object.freeze([
  `Proposition contract: ${PROPOSITION_CONTRACT_VERSION}.`,
  'polarity=positive means the predicate relation is affirmed; polarity=negative means that exact relation is explicitly negated.',
  'Prefer a precise positive predicate such as rejects_request or forbids over encoding the same fact as negative accepts_request or negative permits.',
  'modality=asserted means the claim represents a stated fact, state, stance, refusal, boundary, or completed action.',
  'modality=requested means the claim itself represents an action the speaker asks a target to perform; an imperative surface form does not make a separately modeled boundary or refusal requested.',
  'modality=promised means the speaker commits their own future action or state.',
  'modality=possible requires explicit uncertainty, hypothesis, or condition in the raw source.',
  'modality=sarcastic requires explicit contextual support that the proposition is non-literal or ironic.',
  'A temporal or numeric qualifier must be explicit in the cited raw text; never infer now, today, frequency, duration, or quantity from message time or conversational proximity.',
]);

const SPEECH_ACT_PREDICATE = /(?:request|ask|command|instruct|order|forbid|permit|allow|deny|reject|refus|promise|commit|correct|rename|address|nickname|revoke)/i;
const AMBIGUOUS_PRONOUN = /(?:^|\W)(?:he|she|they|them|it|his|her|their)(?:$|\W)|[他她它祂]/iu;

function occurrences(text, quote) {
  if (!quote) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(quote, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, quote.length);
  }
  return count;
}

function laterParticipantMayContradict(claim, packet) {
  const indexByMessageId = new Map(
    (packet?.rawMessages || []).map((message, index) => [String(message.messageId), index]),
  );
  const evidenceIndexes = (claim?.evidence || [])
    .map((evidence) => indexByMessageId.get(String(evidence.messageId)))
    .filter(Number.isInteger);
  if (!evidenceIndexes.length) return false;
  const lastEvidenceIndex = Math.max(...evidenceIndexes);
  const laterSenders = new Set(
    (packet.rawMessages || []).slice(lastEvidenceIndex + 1)
      .map((message) => String(message.senderEntityId || ''))
      .filter(Boolean),
  );
  return [
    claim.speakerEntityId,
    claim.subjectEntityId,
    claim.objectEntityId,
    claim.targetEntityId,
  ].some((entityId) => entityId && laterSenders.has(String(entityId)));
}

function classifyPropositionVerificationLane(claim, packet) {
  const reasons = [];
  if (String(claim?.polarity || '') !== 'positive') reasons.push('non-positive-polarity');
  if (String(claim?.modality || '') !== 'asserted') reasons.push('non-asserted-modality');
  const evidenceText = (claim?.evidence || [])
    .map((evidence) => String(evidence?.quote || ''))
    .join('\n');
  const temporalQualifier = String(claim?.temporalQualifier || '').trim();
  if (temporalQualifier && !evidenceText.includes(temporalQualifier)) {
    reasons.push('unsupported-temporal-qualifier');
  }
  if (Array.isArray(claim?.numericQualifiers) && claim.numericQualifiers.length) {
    reasons.push('numeric-qualifier');
  }
  if (SPEECH_ACT_PREDICATE.test(String(claim?.predicate || ''))) {
    reasons.push('speech-act-predicate');
  }
  // When the same entity is encoded as both object and beneficiary/target,
  // the verifier must resolve two distinct semantic roles from the raw text.
  // A real history shadow showed a batch accepting "the place is the owner's" as
  // if the owner were also the reserved object. Keep this role-resolution shape on
  // the focused lane instead of letting neighboring claims bias the mapping.
  if (
    claim?.objectEntityId
    && claim?.targetEntityId
    && String(claim.objectEntityId) === String(claim.targetEntityId)
  ) {
    reasons.push('overlapping-object-target-roles');
  }
  if (laterParticipantMayContradict(claim, packet)) reasons.push('later-participant-reply');

  const messageById = new Map(
    (packet?.rawMessages || []).map((message) => [String(message.messageId), message]),
  );
  for (const evidence of claim?.evidence || []) {
    const quote = String(evidence?.quote || '');
    const sourceText = String(messageById.get(String(evidence?.messageId))?.text || '');
    if (Array.from(quote).length < 4 || occurrences(sourceText, quote) !== 1) {
      reasons.push('short-or-repeated-evidence');
      break;
    }
  }
  const hasThirdPartyRole = [claim?.subjectEntityId, claim?.objectEntityId, claim?.targetEntityId]
    .some((entityId) => entityId && String(entityId) !== String(claim?.speakerEntityId || ''));
  if (hasThirdPartyRole) {
    if (AMBIGUOUS_PRONOUN.test(evidenceText)) reasons.push('third-party-pronoun');
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    lane: uniqueReasons.length ? 'focused-single' : 'bounded-batch',
    reasons: uniqueReasons,
    contractVersion: PROPOSITION_CONTRACT_VERSION,
  };
}

module.exports = {
  PROPOSITION_CONTRACT_PROMPT_LINES,
  PROPOSITION_CONTRACT_VERSION,
  classifyPropositionVerificationLane,
  laterParticipantMayContradict,
};
