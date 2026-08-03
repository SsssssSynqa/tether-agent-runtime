// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
        throw new InstanceLockError(`Another Tether runtime is already using this storage (pid ${existing.pid})`);
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
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid, token, acquiredAt: clock() })}\n`, 'utf8');
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

module.exports = { InstanceLockError, acquireInstanceLock, isProcessAlive, readLock };
