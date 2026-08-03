// SPDX-License-Identifier: Apache-2.0
'use strict';
// Telegram polling watchdog: after either the failure-count or failure-duration
// threshold is reached, the caller may exit and let its process supervisor recover.

function createPollWatchdog({
  maxConsecutiveFailures = 100,
  maxFailureDurationMs = 10 * 60 * 1000,
  now = Date.now,
} = {}) {
  let consecutiveFailures = 0;
  let failingSince = null;

  return {
    recordFailure() {
      consecutiveFailures++;
      if (failingSince === null) failingSince = now();
    },
    recordSuccess() {
      consecutiveFailures = 0;
      failingSince = null;
    },
    shouldGiveUp() {
      if (consecutiveFailures >= maxConsecutiveFailures) return true;
      if (failingSince !== null && now() - failingSince >= maxFailureDurationMs) return true;
      return false;
    },
  };
}

module.exports = { createPollWatchdog };
