'use strict';

function telegramErrorDiagnostics(error, method, timing = {}) {
  const codes = new Set();
  const seen = new Set();
  const pending = [error];
  for (let count = 0; pending.length && count < 16; count += 1) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const code = String(value.code || '');
    // Only transport identifiers, never cause messages, URLs, headers or bodies.
    if (/^(?:E(?:AI_AGAIN|CONNRESET|CONNREFUSED|PIPE|TIMEDOUT|NOTFOUND|HOSTUNREACH|NETUNREACH|ADDRNOTAVAIL)|UND_ERR_[A-Z_]{1,40}|ABORT_ERR)$/.test(code)) codes.add(code);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
  const status = Number(error?.status);
  return {
    method: ['getUpdates', 'getMe', 'getMyCommands', 'sendMessage', 'sendDocument', 'editMessageText'].includes(method) ? method : 'unknown',
    name: ['Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    transportCodes: [...codes],
    ...(['getUpdates', 'intake', 'command-menu'].includes(timing.phase) ? { phase: timing.phase } : {}),
    ...(typeof timing.elapsedMs === 'number' && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0
      ? { elapsedMs: Math.round(timing.elapsedMs) } : {}),
  };
}

module.exports = { telegramErrorDiagnostics };
