'use strict';
/*
 * Timestamps for a long-running process's stdout/stderr.
 *
 * Ported from the source bridge (2026-08-22). Raw console lines under a
 * supervisor or launchd redirect carry no time at all, so incident forensics
 * degrade to guessing from file mtimes. ISO UTC matches the `at` fields in the
 * causal journal and durable inbox, so log lines line up with records.
 *
 * Install only in real entrypoints; required test modules stay untouched.
 */
function installLogTimestamps(target = console) {
  for (const level of ['log', 'error', 'warn']) {
    if (typeof target[level] !== 'function') continue;
    if (target[level].__timestamped) continue;
    const original = target[level].bind(target);
    const wrapped = (...args) => original(`[${new Date().toISOString()}]`, ...args);
    wrapped.__timestamped = true;
    target[level] = wrapped;
  }
}

module.exports = { installLogTimestamps };
