// SPDX-License-Identifier: Apache-2.0 AND MIT
'use strict';

// Portions derived from Codex-tg-Bridge/src/rate-limit.mjs (MIT).
// Copyright (c) 2026 Codex-tg-Bridge contributors. See THIRD_PARTY_NOTICES.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_INTERVAL_MS = 10000;
const STATE_DIR = path.join(os.homedir(), '.tether', 'telegram-rate-limit');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statePaths(chatId, stateDir = STATE_DIR) {
  const safeChatId = String(chatId).replace(/[^0-9-]/g, '_');
  const statePath = path.join(stateDir, `${safeChatId}.last-send-at`);
  return { statePath, lockPath: `${statePath}.lock` };
}

async function acquireLock(lockPath) {
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > 120000) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      await sleep(25);
    }
  }
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
  await acquireLock(lockPath);

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
      fs.rmdirSync(lockPath);
    } catch (error) {
      // Same post-send rule: lock cleanup is maintenance, not delivery status.
      if (log) log(`Telegram group rate-limit lock cleanup failed: ${error.message}`);
    }
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  sendWithGroupRateLimit,
};
