'use strict';
const { classifyDurableError } = require('./durable-error-policy');
const { telegramErrorDiagnostics } = require('./telegram-error-diagnostics');
const ref = value => typeof value === 'string' && /^[\w:./-]{1,512}$/.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const categories = new Set(['telegram_delivery_unknown_held', 'telegram_delivery_unknown', 'causal_ambiguity', 'manual_retry_only', 'circuit_open', 'explicit_pause', 'telegram_rate_limit', 'provider_balance', 'provider_quota', 'provider_unavailable', 'ordinary_failure']);
const method = value => ['sendMessage', 'sendDocument', 'sendDice', 'editMessageText'].includes(value) ? value : null;

// Only receipt references and bounded transport fields, never error bodies/URLs/params.
function deliveryFailureMetadata(error = {}) {
  const parts = Array.isArray(error.deliveryParts) ? error.deliveryParts : [];
  return {
    category: categories.has(error.category) ? error.category : classifyDurableError(error).category,
    publicationEffectId: ref(error.publicationEffectId),
    deliveryKey: ref(error.deliveryKey),
    attemptId: ref(error.attemptId),
    deliveryAttemptNumber: number(error.deliveryAttemptNumber),
    telegramMethod: method(error.telegramMethod),
    httpStatus: Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
    retryAfter: number(error.retryAfter),
    deliveryOutcome: ['unknown', 'failed'].includes(error.deliveryOutcome) ? error.deliveryOutcome : null,
    transportCodes: telegramErrorDiagnostics(error, error.telegramMethod).transportCodes,
    parts: parts.slice(0, 64).map(value => { const part = value && typeof value === 'object' ? value : {}; return ({
      partId: ref(part.partId), requestId: ref(part.requestId), requestNumber: number(part.requestNumber),
      method: method(part.method), status: ['acked', 'failed', 'delivery_unknown', 'not_attempted'].includes(part.status) ? part.status : 'delivery_unknown',
      httpStatus: Number.isInteger(part.httpStatus) && part.httpStatus >= 100 && part.httpStatus <= 599 ? part.httpStatus : null,
      retryAfter: number(part.retryAfter),
      transportCodes: telegramErrorDiagnostics({ errors: (Array.isArray(part.transportCodes) ? part.transportCodes : []).slice(0, 16).map(code => ({ code })) }).transportCodes,
    }); }),
    partCount: Math.max(parts.length, number(error.deliveryPartCount) || 0),
    partsTruncated: parts.length > 64 || number(error.deliveryPartCount) > parts.length,
  };
}

function publicationFailureError(message, current = {}, effectId) {
  const error = new Error(message);
  Object.assign(error, {
    status: current.httpStatus, retryAfter: current.retryAfter, deliveryFailure: true,
    deliveryOutcome: current.status === 'failed' ? 'failed' : 'unknown',
    publicationEffectId: effectId, deliveryKey: effectId, attemptId: current.attemptId,
    deliveryParts: current.deliveryParts, deliveryPartCount: current.deliveryPartCount,
  });
  const failedPart = Array.isArray(current.deliveryParts) ? current.deliveryParts.find(part => part && part.status !== 'acked') : null;
  error.telegramMethod = failedPart?.method;
  error.deliveryAttemptNumber = failedPart?.requestNumber;
  error.errors = (Array.isArray(failedPart?.transportCodes) ? failedPart.transportCodes : []).map(code => ({ code }));
  return error;
}
module.exports = { deliveryFailureMetadata, publicationFailureError };
