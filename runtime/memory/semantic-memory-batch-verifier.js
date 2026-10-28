'use strict';

const { isHighRiskClaim } = require('./semantic-memory-validators.js');
const {
  PIPELINE_VERSION,
  deterministicSourceVerdicts,
  normalizeVerifierResult,
  requiredVerifierFields,
  resolveVerificationStatus,
  validateVerifierEvidence,
} = require('./semantic-memory-pipeline.js');
const {
  classifyPropositionVerificationLane,
} = require('./semantic-memory-proposition-contract.js');

const DEFAULT_MAX_CLAIMS = 4;
const DEFAULT_MAX_VERDICT_FIELDS = 20;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function verifierClaimBody(claim) {
  const {
    verifierNotes: _verifierNotes,
    verifierVerdicts: _verifierVerdicts,
    ...body
  } = claim;
  return { ...body, verificationStatus: 'pending' };
}

function createVerificationItems(claims, packet) {
  const refs = new Set();
  return (claims || []).map((claim, index) => {
    const claimRef = String(claim?.claimId || `claim-${index}`);
    if (!claimRef || refs.has(claimRef)) {
      throw new Error(`batch verifier claimRef 缺失或重复: ${claimRef || '<empty>'}`);
    }
    refs.add(claimRef);
    const deterministicVerdicts = deterministicSourceVerdicts(claim, packet);
    const deterministicSupported = new Set(
      deterministicVerdicts
        .filter((verdict) => verdict.verdict === 'supported')
        .map((verdict) => verdict.field),
    );
    return {
      claimRef,
      claim,
      modelClaim: verifierClaimBody(claim),
      evidenceCatalog: (claim.evidence || []).map((evidence, evidenceIndex) => ({
        evidenceRef: `${claimRef}:e${evidenceIndex}`,
        messageId: evidence.messageId,
        quote: evidence.quote,
      })),
      requiredFields: requiredVerifierFields(claim)
        .filter((field) => !deterministicSupported.has(field)),
      deterministicVerdicts,
    };
  });
}

function packVerificationItems(items, {
  maxClaims = DEFAULT_MAX_CLAIMS,
  maxVerdictFields = DEFAULT_MAX_VERDICT_FIELDS,
} = {}) {
  const claimLimit = positiveInteger(maxClaims, DEFAULT_MAX_CLAIMS);
  const fieldLimit = positiveInteger(maxVerdictFields, DEFAULT_MAX_VERDICT_FIELDS);
  const batches = [];
  let current = [];
  let currentFields = 0;
  for (const item of items || []) {
    const fieldCount = Math.max(1, item.requiredFields.length);
    if (
      current.length > 0
      && (current.length >= claimLimit || currentFields + fieldCount > fieldLimit)
    ) {
      batches.push(current);
      current = [];
      currentFields = 0;
    }
    current.push(item);
    currentFields += fieldCount;
  }
  if (current.length) batches.push(current);
  return batches;
}

function assertExactVerdictFields(verdicts, requiredFields, claimRef, verifierName) {
  const expected = new Set(requiredFields);
  const seen = new Set();
  for (const verdict of verdicts) {
    if (!['supported', 'contradicted', 'insufficient'].includes(verdict.verdict)) {
      throw new Error(
        `${verifierName}:${claimRef}:${verdict.field || '<empty>'} 返回非法 verdict ${verdict.verdict || '<empty>'}`,
      );
    }
    if (!expected.has(verdict.field)) {
      throw new Error(`${verifierName}:${claimRef} 返回额外 field ${verdict.field || '<empty>'}`);
    }
    if (seen.has(verdict.field)) {
      throw new Error(`${verifierName}:${claimRef} 重复返回 field ${verdict.field}`);
    }
    seen.add(verdict.field);
  }
  const missing = requiredFields.filter((field) => !seen.has(field));
  if (missing.length) {
    throw new Error(`${verifierName}:${claimRef} 缺少 field ${missing.join(', ')}`);
  }
}

function inspectBatchVerifierResult(result, items, verifierName) {
  if (!result || !Array.isArray(result.results)) {
    throw new Error(`${verifierName} 没有返回 results 数组`);
  }
  const expected = new Map(items.map((item) => [item.claimRef, item]));
  const entries = new Map();
  const duplicateRefs = new Set();
  for (const entry of result.results) {
    const claimRef = String(entry?.claimRef || '');
    if (!expected.has(claimRef)) {
      throw new Error(`${verifierName} 返回额外 claimRef ${claimRef || '<empty>'}`);
    }
    if (entries.has(claimRef)) duplicateRefs.add(claimRef);
    else entries.set(claimRef, entry);
  }
  const valid = new Map();
  const invalid = new Map();
  for (const item of items) {
    if (duplicateRefs.has(item.claimRef)) {
      invalid.set(item.claimRef, new Error(`${verifierName} 重复返回 claimRef ${item.claimRef}`));
      continue;
    }
    const entry = entries.get(item.claimRef);
    if (!entry) {
      invalid.set(item.claimRef, new Error(`${verifierName} 缺少 claimRef ${item.claimRef}`));
      continue;
    }
    try {
      const evidenceByRef = new Map(
        item.evidenceCatalog.map((evidence) => [evidence.evidenceRef, evidence]),
      );
      const verdicts = normalizeVerifierResult(entry, verifierName).map((verdict) => ({
        ...verdict,
        evidence: verdict.evidence.map((evidence) => {
          const evidenceRef = String(evidence?.evidenceRef || '');
          if (!evidenceRef) return evidence;
          const catalogEvidence = evidenceByRef.get(evidenceRef);
          if (!catalogEvidence) {
            throw new Error(
              `${verifierName}:${item.claimRef}:${verdict.field} 返回未知 evidenceRef ${evidenceRef}`,
            );
          }
          return catalogEvidence;
        }),
      }));
      assertExactVerdictFields(
        verdicts,
        item.requiredFields,
        item.claimRef,
        verifierName,
      );
      valid.set(item.claimRef, verdicts);
    } catch (error) {
      invalid.set(item.claimRef, error);
    }
  }
  return { valid, invalid };
}

function verifierPayload(common, items, verificationRepair = null) {
  return {
    ...common,
    claims: items.map((item) => ({
      claimRef: item.claimRef,
      claim: item.modelClaim,
      requiredFields: item.requiredFields,
      evidenceCatalog: item.evidenceCatalog,
    })),
    ...(verificationRepair ? { verificationRepair } : {}),
  };
}

function insufficientVerdicts(item, verifierName, reason) {
  return item.requiredFields.map((field) => ({
    field,
    verdict: 'insufficient',
    reason,
    evidence: [],
    verifier: verifierName,
  }));
}

function replaceVerdicts(original, replacements) {
  const replacementByField = new Map(replacements.map((verdict) => [verdict.field, verdict]));
  return original.map((verdict) => replacementByField.get(verdict.field) || verdict);
}

function createMetrics(items) {
  return {
    claims: items.length,
    highRiskClaims: items.filter((item) => isHighRiskClaim(item.claim)).length,
    serialMinimumCalls: items.length
      + items.filter((item) => isHighRiskClaim(item.claim)).length,
    batchCalls: 0,
    repairBatchCalls: 0,
    batchFailures: 0,
    batchSplits: 0,
    singleFallbackCalls: 0,
    singleRepairCalls: 0,
    focusedSingleCalls: 0,
  };
}

function requiresFocusedPrimaryVerification(item, packet) {
  return classifyPropositionVerificationLane(item.claim, packet).lane === 'focused-single';
}

function addNote(notesByRef, claimRef, note) {
  const notes = notesByRef.get(claimRef) || [];
  notes.push(String(note));
  notesByRef.set(claimRef, notes);
}

async function runSingleVerifier({
  item,
  common,
  packet,
  verifier,
  verifierName,
  metrics,
  notesByRef,
  metric = 'singleFallbackCalls',
}) {
  if (typeof verifier !== 'function') {
    const reason = `${verifierName} verifier unavailable`;
    addNote(notesByRef, item.claimRef, reason);
    return insufficientVerdicts(item, verifierName, reason);
  }
  const verifyOnce = async (verificationRepair = null) => {
    const payload = {
      ...common,
      claim: item.modelClaim,
      requiredFields: item.requiredFields,
      ...(verificationRepair ? { verificationRepair } : {}),
    };
    const verdicts = normalizeVerifierResult(await verifier(payload), verifierName);
    assertExactVerdictFields(verdicts, item.requiredFields, item.claimRef, verifierName);
    return validateVerifierEvidence(verdicts, packet);
  };
  try {
    metrics[metric] += 1;
    let verdicts = await verifyOnce();
    const invalid = verdicts.filter((verdict) => verdict.evidenceValidationError);
    if (!invalid.length) return verdicts;
    metrics.singleRepairCalls += 1;
    addNote(
      notesByRef,
      item.claimRef,
      `${verifierName} single evidence repair: ${invalid.map((verdict) => verdict.field).join(', ')}`,
    );
    verdicts = await verifyOnce({
      reason: 'invalid_exact_quote',
      fields: invalid.map((verdict) => verdict.field),
    });
    return verdicts;
  } catch (error) {
    if (error?.code === 'HELPER_QUOTA_WAIT') throw error;
    const reason = `${verifierName} verifier unavailable: ${error.message}`;
    addNote(notesByRef, item.claimRef, reason);
    return insufficientVerdicts(item, verifierName, reason);
  }
}

async function runBatchOnce({
  items,
  common,
  packet,
  batchVerifier,
  singleVerifier,
  verifierName,
  metrics,
  notesByRef,
}) {
  metrics.batchCalls += 1;
  const result = await batchVerifier(verifierPayload(common, items));
  const inspected = inspectBatchVerifierResult(result, items, verifierName);
  const verdictsByRef = new Map();
  const fallbackItems = [];
  for (const item of items) {
    const structuralError = inspected.invalid.get(item.claimRef);
    if (structuralError) {
      addNote(notesByRef, item.claimRef, `batch contract fallback: ${structuralError.message}`);
      fallbackItems.push(item);
      continue;
    }
    verdictsByRef.set(
      item.claimRef,
      validateVerifierEvidence(inspected.valid.get(item.claimRef), packet),
    );
  }

  const repairItems = [];
  const repairFieldsByRef = new Map();
  for (const item of items) {
    const verdicts = verdictsByRef.get(item.claimRef);
    if (!verdicts) continue;
    const fields = verdicts
      .filter((verdict) => verdict.evidenceValidationError)
      .map((verdict) => verdict.field);
    if (!fields.length) continue;
    repairFieldsByRef.set(item.claimRef, fields);
    repairItems.push({ ...item, requiredFields: fields });
  }

  if (repairItems.length) {
    metrics.batchCalls += 1;
    metrics.repairBatchCalls += 1;
    try {
      const repaired = inspectBatchVerifierResult(
        await batchVerifier(verifierPayload(common, repairItems, {
          reason: 'invalid_exact_quote',
          claims: repairItems.map((item) => ({
            claimRef: item.claimRef,
            fields: item.requiredFields,
          })),
        })),
        repairItems,
        verifierName,
      );
      for (const item of repairItems) {
        const structuralError = repaired.invalid.get(item.claimRef);
        if (structuralError) {
          addNote(notesByRef, item.claimRef, `batch repair fallback: ${structuralError.message}`);
          fallbackItems.push(items.find((candidate) => candidate.claimRef === item.claimRef));
          continue;
        }
        const repairedVerdicts = validateVerifierEvidence(
          repaired.valid.get(item.claimRef),
          packet,
        );
        if (repairedVerdicts.some((verdict) => verdict.evidenceValidationError)) {
          addNote(notesByRef, item.claimRef, 'batch repair still contained invalid exact quote');
          fallbackItems.push(items.find((candidate) => candidate.claimRef === item.claimRef));
          continue;
        }
        verdictsByRef.set(
          item.claimRef,
          replaceVerdicts(verdictsByRef.get(item.claimRef), repairedVerdicts),
        );
      }
    } catch (error) {
      if (error?.code === 'HELPER_QUOTA_WAIT') throw error;
      for (const item of repairItems) {
        addNote(notesByRef, item.claimRef, `batch repair request failed: ${error.message}`);
        fallbackItems.push(items.find((candidate) => candidate.claimRef === item.claimRef));
      }
    }
  }

  for (const item of new Map(
    fallbackItems.filter(Boolean).map((candidate) => [candidate.claimRef, candidate]),
  ).values()) {
    verdictsByRef.set(item.claimRef, await runSingleVerifier({
      item,
      common,
      packet,
      verifier: singleVerifier,
      verifierName,
      metrics,
      notesByRef,
    }));
  }
  return verdictsByRef;
}

async function runResilientBatch({
  items,
  common,
  packet,
  batchVerifier,
  singleVerifier,
  verifierName,
  metrics,
  notesByRef,
}) {
  if (typeof batchVerifier !== 'function') {
    const entries = [];
    for (const item of items) {
      entries.push([
        item.claimRef,
        await runSingleVerifier({
        item,
        common,
        packet,
        verifier: singleVerifier,
        verifierName,
        metrics,
        notesByRef,
      }),
      ]);
    }
    return new Map(entries);
  }
  try {
    return await runBatchOnce({
      items,
      common,
      packet,
      batchVerifier,
      singleVerifier,
      verifierName,
      metrics,
      notesByRef,
    });
  } catch (error) {
    if (error?.code === 'HELPER_QUOTA_WAIT') throw error;
    metrics.batchFailures += 1;
    for (const item of items) {
      addNote(notesByRef, item.claimRef, `batch request failed: ${error.message}`);
    }
    if (items.length === 1) {
      const item = items[0];
      return new Map([[
        item.claimRef,
        await runSingleVerifier({
          item,
          common,
          packet,
          verifier: singleVerifier,
          verifierName,
          metrics,
          notesByRef,
        }),
      ]]);
    }
    metrics.batchSplits += 1;
    const middle = Math.ceil(items.length / 2);
    const left = await runResilientBatch({
      items: items.slice(0, middle),
      common,
      packet,
      batchVerifier,
      singleVerifier,
      verifierName,
      metrics,
      notesByRef,
    });
    const right = await runResilientBatch({
      items: items.slice(middle),
      common,
      packet,
      batchVerifier,
      singleVerifier,
      verifierName,
      metrics,
      notesByRef,
    });
    return new Map([...left, ...right]);
  }
}

async function verifyItemBatches({
  items,
  common,
  packet,
  batchVerifier,
  singleVerifier,
  verifierName,
  metrics,
  notesByRef,
  maxClaims,
  maxVerdictFields,
}) {
  const verdictsByRef = new Map();
  for (const batch of packVerificationItems(items, { maxClaims, maxVerdictFields })) {
    const verified = await runResilientBatch({
      items: batch,
      common,
      packet,
      batchVerifier,
      singleVerifier,
      verifierName,
      metrics,
      notesByRef,
    });
    for (const [claimRef, verdicts] of verified) verdictsByRef.set(claimRef, verdicts);
  }
  return verdictsByRef;
}

async function verifyClaimsInMicroBatches({
  claims,
  packet,
  entities = [],
  verifyBatch,
  verifySingle,
  verifyHighRiskBatch = null,
  verifyHighRiskSingle = null,
  requireSecondaryHighRisk = true,
  maxClaims = DEFAULT_MAX_CLAIMS,
  maxVerdictFields = DEFAULT_MAX_VERDICT_FIELDS,
} = {}) {
  if (!packet || !Array.isArray(packet.rawMessages)) {
    throw new Error('micro-batch verifier 缺少 raw packet');
  }
  const items = createVerificationItems(claims, packet);
  const metrics = createMetrics(items);
  const notesByRef = new Map();
  const laneByRef = new Map(items.map((item) => [
    item.claimRef,
    classifyPropositionVerificationLane(item.claim, packet),
  ]));
  metrics.focusedReasonCounts = {};
  for (const lane of laneByRef.values()) {
    if (lane.lane !== 'focused-single') continue;
    for (const reason of lane.reasons) {
      metrics.focusedReasonCounts[reason] = Number(metrics.focusedReasonCounts[reason] || 0) + 1;
    }
  }
  const common = {
    pipelineVersion: PIPELINE_VERSION,
    packetId: packet.packetId,
    entities,
    rawMessages: packet.rawMessages,
  };
  const primaryByRef = await verifyItemBatches({
    items: items.filter((item) => laneByRef.get(item.claimRef).lane === 'bounded-batch'),
    common,
    packet,
    batchVerifier: verifyBatch,
    singleVerifier: verifySingle,
    verifierName: 'primary',
    metrics,
    notesByRef,
    maxClaims,
    maxVerdictFields,
  });
  for (const item of items.filter(
    (candidate) => laneByRef.get(candidate.claimRef).lane === 'focused-single',
  )) {
    addNote(
      notesByRef,
      item.claimRef,
      `focused primary verification: ${laneByRef.get(item.claimRef).reasons.join(', ')}`,
    );
    primaryByRef.set(item.claimRef, await runSingleVerifier({
      item,
      common,
      packet,
      verifier: verifySingle,
      verifierName: 'primary',
      metrics,
      notesByRef,
      metric: 'focusedSingleCalls',
    }));
  }

  const highRiskItems = items.filter((item) => isHighRiskClaim(item.claim));
  let secondaryByRef = new Map();
  if (highRiskItems.length && (verifyHighRiskBatch || verifyHighRiskSingle)) {
    secondaryByRef = await verifyItemBatches({
      items: highRiskItems,
      common,
      packet,
      batchVerifier: verifyHighRiskBatch,
      singleVerifier: verifyHighRiskSingle,
      verifierName: 'secondary',
      metrics,
      notesByRef,
      maxClaims,
      maxVerdictFields,
    });
  } else if (highRiskItems.length && requireSecondaryHighRisk) {
    secondaryByRef = new Map(highRiskItems.map((item) => {
      const reason = 'secondary verifier is required for high-risk claim';
      addNote(notesByRef, item.claimRef, reason);
      return [item.claimRef, insufficientVerdicts(item, 'secondary', reason)];
    }));
  }

  const verifiedClaims = items.map((item) => {
    const primaryVerdicts = primaryByRef.get(item.claimRef)
      || insufficientVerdicts(item, 'primary', 'primary batch result missing');
    const secondaryVerdicts = isHighRiskClaim(item.claim)
      ? secondaryByRef.get(item.claimRef) || null
      : null;
    const resolution = resolveVerificationStatus(
      item.claim,
      primaryVerdicts,
      secondaryVerdicts,
      item.deterministicVerdicts,
    );
    const notes = notesByRef.get(item.claimRef) || [];
    if (resolution.missing.length) {
      notes.push(`unsupported required slots: ${resolution.missing.join(', ')}`);
    }
    return {
      ...item.claim,
      verificationStatus: resolution.status,
      verifierNotes: notes,
      verifierVerdicts: [
        ...item.deterministicVerdicts,
        ...primaryVerdicts,
        ...(secondaryVerdicts || []),
      ],
    };
  });
  return {
    claims: verifiedClaims,
    metrics: {
      ...metrics,
      effectiveCalls: metrics.batchCalls
        + metrics.focusedSingleCalls
        + metrics.singleFallbackCalls
        + metrics.singleRepairCalls,
    },
  };
}

module.exports = {
  DEFAULT_MAX_CLAIMS,
  DEFAULT_MAX_VERDICT_FIELDS,
  assertExactVerdictFields,
  createVerificationItems,
  inspectBatchVerifierResult,
  packVerificationItems,
  requiresFocusedPrimaryVerification,
  verifyClaimsInMicroBatches,
};
