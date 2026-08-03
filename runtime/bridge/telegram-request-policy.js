// SPDX-License-Identifier: Apache-2.0
'use strict';

const DEFAULT_TELEGRAM_TIMEOUT_MS = 40_000;
const LONG_POLL_GRACE_MS = 15_000;

function telegramRequestTimeoutMs(method, params = {}) {
  if (method !== 'getUpdates') return DEFAULT_TELEGRAM_TIMEOUT_MS;
  const serverTimeoutMs = Math.max(0, Number(params.timeout) || 0) * 1000;
  return Math.max(DEFAULT_TELEGRAM_TIMEOUT_MS, serverTimeoutMs + LONG_POLL_GRACE_MS);
}

module.exports = {
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  LONG_POLL_GRACE_MS,
  telegramRequestTimeoutMs,
};
