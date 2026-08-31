// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

class InstanceLockError extends Error {
  constructor(message, code = 'TETHER_INSTANCE_LOCKED') {
    super(message);
    this.name = 'InstanceLockError';
    this.code = code;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// A PID by itself is not a process identity: after a crash the OS can reuse it
// for an unrelated process, leaving a forever-live false lock. Store the
// process start marker and a hash of its command line so a later owner can tell
// "the same PID" from "the same process" without exposing command arguments in
// the lock file. `ps` is available on the Unix platforms Tether currently
// supports; when identity cannot be observed, acquisition remains fail-closed.
function readProcessIdentity(pid, { execImpl = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let output;
  try {
    output = String(execImpl('ps', [
      '-p', String(pid), '-o', 'lstart=', '-o', 'command=',
    ], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }) || '').trim();
  } catch (_) {
    return null;
  }
  // POSIX `lstart` under the C locale is a fixed 24-character timestamp.
  // Reading timestamp and command in one ps snapshot avoids mixing identities
  // if the process exits and the PID is reused between observations.
  const match = output.match(/^(.{24})\s+([\s\S]+)$/u);
  if (!match) return null;
  const [, startedAt, command] = match;
  return {
    startedAt,
    commandSha256: sha256(command),
    isTetherProcess: /(?:^|[\s/])(?:node\s+[^\n]*?)?tether(?:-[\w-]+)?\.cjs(?:\s|$)/i.test(command),
  };
}

function storedProcessIdentity(identity) {
  if (
    typeof identity?.startedAt !== 'string'
    || !identity.startedAt.trim()
    || !/^[a-f0-9]{64}$/.test(String(identity.commandSha256 || ''))
  ) return null;
  return {
    startedAt: identity.startedAt.trim(),
    commandSha256: String(identity.commandSha256),
  };
}

function sameProcessIdentity(stored, observed) {
  const expected = storedProcessIdentity(stored);
  const actual = storedProcessIdentity(observed);
  if (!expected || !actual) return null;
  return expected.startedAt === actual.startedAt
    && expected.commandSha256 === actual.commandSha256;
}

function readLock(filePath) {
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new InstanceLockError('Instance lock is unreadable; refusing an unsafe takeover', 'TETHER_INSTANCE_LOCK_CORRUPT');
  }
  if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value?.token !== 'string' || !value.token) {
    throw new InstanceLockError('Instance lock is malformed; refusing an unsafe takeover', 'TETHER_INSTANCE_LOCK_CORRUPT');
  }
  return value;
}

function acquireInstanceLock(filePath, {
  pid = process.pid,
  clock = () => new Date().toISOString(),
  processAlive = isProcessAlive,
  processIdentity = readProcessIdentity,
} = {}) {
  const resolved = path.resolve(filePath);
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });

  for (;;) {
    let descriptor;
    try {
      descriptor = fs.openSync(resolved, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readLock(resolved);
      if (!existing) continue;
      if (processAlive(existing.pid)) {
        const observedIdentity = processIdentity(existing.pid);
        const identityMatch = sameProcessIdentity(existing.processIdentity, observedIdentity);
        const legacyPidIsUnrelated = !existing.processIdentity
          && observedIdentity?.isTetherProcess === false;
        if (identityMatch !== false && !legacyPidIsUnrelated) {
          throw new InstanceLockError(`Another Tether runtime is already using this storage (pid ${existing.pid})`);
        }
      }
      const stalePath = `${resolved}.stale-${token}`;
      try { fs.renameSync(resolved, stalePath); } catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      fs.unlinkSync(stalePath);
      continue;
    }

    try {
      const identity = storedProcessIdentity(processIdentity(pid));
      fs.writeFileSync(descriptor, `${JSON.stringify({
        pid,
        token,
        acquiredAt: clock(),
        ...(identity ? { processIdentity: identity } : {}),
      })}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      try { fs.closeSync(descriptor); } catch (_) { /* best effort */ }
      try { fs.unlinkSync(resolved); } catch (_) { /* best effort */ }
      throw error;
    }
    fs.closeSync(descriptor);
    fs.chmodSync(resolved, 0o600);

    let released = false;
    return {
      filePath: resolved,
      token,
      release() {
        if (released) return false;
        const current = readLock(resolved);
        if (!current || current.token !== token || current.pid !== pid) return false;
        fs.unlinkSync(resolved);
        released = true;
        return true;
      },
    };
  }
}

module.exports = {
  InstanceLockError,
  acquireInstanceLock,
  isProcessAlive,
  readLock,
  readProcessIdentity,
  sameProcessIdentity,
};
