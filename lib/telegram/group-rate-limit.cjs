// SPDX-License-Identifier: Apache-2.0 AND MIT
'use strict';

// Portions derived from Codex-tg-Bridge/src/rate-limit.mjs (MIT).
// Copyright (c) 2026 Codex-tg-Bridge contributors. See THIRD_PARTY_NOTICES.md.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_INTERVAL_MS = 10000;
const DEFAULT_LOCK_STALE_MS = 120000;
const DEFAULT_LOCK_HEARTBEAT_MS = 30000;
const STATE_DIR = path.join(os.homedir(), '.tether', 'telegram-rate-limit');
const activeLockLeases = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statePaths(chatId, stateDir = STATE_DIR) {
  const safeChatId = String(chatId).replace(/[^0-9-]/g, '_');
  const statePath = path.join(stateDir, `${safeChatId}.last-send-at`);
  return { statePath, lockPath: `${statePath}.lock` };
}

function legacyOwnerFile(lockPath) {
  return path.join(lockPath, 'owner');
}

function leaseOwnerFile(lockPath, token) {
  return path.join(lockPath, `owner.${token}`);
}

function readLockOwner(lockPath) {
  try {
    const modern = fs.readdirSync(lockPath).find((name) => name.startsWith('owner.'));
    if (modern) {
      return {
        token: modern.slice('owner.'.length),
        heartbeatPath: path.join(lockPath, modern),
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
  try {
    return {
      token: String(fs.readFileSync(legacyOwnerFile(lockPath), 'utf8')).trim(),
      heartbeatPath: legacyOwnerFile(lockPath),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function isOwnerGone(owner) {
  const match = /^(\d+)-/.exec(String(owner?.token || ''));
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function startLockHeartbeat(lockPath, token, heartbeatMs) {
  if (!(heartbeatMs > 0)) return;
  const heartbeatPath = leaseOwnerFile(lockPath, token);
  const timer = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(heartbeatPath, now, now);
    } catch (error) {
      if (error.code === 'ENOENT') {
        clearInterval(timer);
        activeLockLeases.delete(token);
      }
    }
  }, heartbeatMs);
  timer.unref?.();
  activeLockLeases.set(token, { timer });
}

async function acquireLock(lockPath, options = {}) {
  const staleMs = Math.max(1, Number(options.staleMs || DEFAULT_LOCK_STALE_MS));
  const heartbeatMs = options.heartbeatMs === 0
    ? 0
    : Math.max(1, Number(
      options.heartbeatMs || Math.min(DEFAULT_LOCK_HEARTBEAT_MS, Math.floor(staleMs / 3)),
    ));
  const token = `${process.pid}-${crypto.randomUUID()}`;
  // Publish a fully-owned directory atomically: contenders never see the
  // ownerless gap between mkdir and writing the marker. rename also replaces
  // an empty release tombstone, but cannot replace a nonempty current lease.
  const candidate = `${lockPath}.candidate-${token}`;
  fs.mkdirSync(candidate, { mode: 0o700 });
  try {
    fs.writeFileSync(leaseOwnerFile(candidate, token), token, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    for (;;) {
      try {
        const now = new Date();
        fs.utimesSync(leaseOwnerFile(candidate, token), now, now);
        fs.renameSync(candidate, lockPath);
        startLockHeartbeat(lockPath, token, heartbeatMs);
        return token;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      try {
        const owner = readLockOwner(lockPath);
        const ageMs = owner ? Date.now() - fs.statSync(owner.heartbeatPath).mtimeMs : 0;
        if (owner && (isOwnerGone(owner) || ageMs > staleMs)) {
          // Retire only the observed generation, never rename the authority:
          // another contender may already have replaced it since our read.
          fs.rmSync(owner.heartbeatPath, { force: true });
          continue;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await sleep(25);
    }
  } finally {
    // This unique unpublished candidate is never an authoritative lock.
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function releaseLock(lockPath, token) {
  const lease = activeLockLeases.get(token);
  if (lease) {
    clearInterval(lease.timer);
    activeLockLeases.delete(token);
  }
  const current = readLockOwner(lockPath);
  if (!current || current.token !== token) return { released: false, reason: 'stolen' };
  // Only delete this token-named marker. An old release can never rmdir a
  // replacement owner's authoritative lock directory.
  fs.rmSync(current.heartbeatPath, { force: true });
  return { released: true };
}

async function sendWithGroupRateLimit(chatId, send, options = {}) {
  const shouldSend = typeof options.shouldSend === 'function' ? options.shouldSend : null;
  const rateLimitedGroupIds = new Set(
    (options.rateLimitedGroupIds || []).map((value) => String(value)),
  );
  if (!rateLimitedGroupIds.has(String(chatId))) {
    if (shouldSend && !shouldSend()) return { skipped: true };
    return send();
  }

  const intervalMs = Number(options.intervalMs || DEFAULT_INTERVAL_MS);
  const log = typeof options.log === 'function' ? options.log : null;
  const stateDir = options.stateDir || STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const { statePath, lockPath } = statePaths(chatId, stateDir);
  const lockToken = await acquireLock(lockPath);

  try {
    let lastSentAt = 0;
    try {
      lastSentAt = Number(fs.readFileSync(statePath, 'utf8').trim()) || 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const waitMs = Math.max(0, lastSentAt + intervalMs - Date.now());
    if (waitMs > 0 && log) log(`Telegram group send queued wait_ms=${waitMs}`);
    if (waitMs > 0) await sleep(waitMs);
    if (shouldSend && !shouldSend()) {
      if (log) log('Telegram group send cancelled before delivery');
      return { skipped: true };
    }

    const result = await send();
    // Telegram has already accepted the message. A local rate-limit bookkeeping
    // failure must not turn that success into an upstream failure, otherwise a
    // durable caller will retry and post a duplicate.
    try {
      fs.writeFileSync(statePath, String(Date.now()), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(statePath, 0o600);
    } catch (error) {
      if (log) log(`Telegram group rate-limit state write failed after delivery: ${error.message}`);
    }
    return result;
  } finally {
    try {
      const outcome = releaseLock(lockPath, lockToken);
      if (!outcome.released && log) {
        log('Telegram group rate-limit lock lease lost; preserving the current owner lock');
      }
    } catch (error) {
      // Same post-send rule: lock cleanup is maintenance, not delivery status.
      if (log) log(`Telegram group rate-limit lock cleanup failed: ${error.message}`);
    }
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  acquireLock,
  releaseLock,
  sendWithGroupRateLimit,
};
