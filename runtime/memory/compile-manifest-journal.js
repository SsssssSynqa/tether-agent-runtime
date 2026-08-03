// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_RECORDS = 50;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const LOCK_STALE_MS = 2 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeAllSync(fd, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('compile manifest 写入返回 0 bytes');
    offset += written;
  }
}

function atomicWritePrivate(filePath, content) {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    writeAllSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(directory);
}

function appendPrivate(filePath, content) {
  ensurePrivateDirectory(path.dirname(filePath));
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    writeAllSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function waitSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function releaseStaleLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); } catch (_) {}
  if (Date.now() - stat.mtimeMs < LOCK_STALE_MS || pidAlive(Number(owner?.pid))) return;
  try { fs.unlinkSync(path.join(lockPath, 'owner.json')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { fs.rmdirSync(lockPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function withJournalLock(filePath, operation, { timeoutMs = 3000 } = {}) {
  const lockPath = `${filePath}.rotation-lock`;
  ensurePrivateDirectory(path.dirname(filePath));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 3000);
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      releaseStaleLock(lockPath);
      if (Date.now() >= deadline) {
        const failure = new Error(`compile manifest rotation lock 超时：${lockPath}`);
        failure.code = 'COMPILE_MANIFEST_LOCK_TIMEOUT';
        throw failure;
      }
      waitSync(20);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.unlinkSync(path.join(lockPath, 'owner.json')); } catch (_) {}
    try { fs.rmdirSync(lockPath); } catch (_) {}
  }
}

function nonEmptyLines(raw) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0x0a) continue;
    const line = raw.subarray(start, index);
    start = index + 1;
    let nonWhitespace = false;
    for (const byte of line) {
      if (![0x09, 0x0a, 0x0d, 0x20].includes(byte)) {
        nonWhitespace = true;
        break;
      }
    }
    if (nonWhitespace) lines.push(Buffer.from(line));
  }
  return lines;
}

function lineBuffer(lines) {
  if (!lines.length) return Buffer.alloc(0);
  return Buffer.concat(lines.flatMap((line) => [line, Buffer.from('\n')]));
}

function readLastLineDigest(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.size <= 0) return null;
  const fd = fs.openSync(filePath, 'r');
  let position = stat.size;
  let suffix = Buffer.alloc(0);
  try {
    while (position > 0) {
      const readSize = Math.min(64 * 1024, position);
      position -= readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      suffix = Buffer.concat([chunk, suffix]);
      let end = suffix.length;
      while (
        end > 0
        && [0x09, 0x0a, 0x0d, 0x20].includes(suffix[end - 1])
      ) end -= 1;
      if (end <= 0) continue;
      const newline = suffix.lastIndexOf(0x0a, end - 1);
      if (newline >= 0 || position === 0) {
        return sha256(suffix.subarray(newline + 1, end));
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function scanActive(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') raw = Buffer.alloc(0);
    else throw error;
  }
  const lines = nonEmptyLines(raw);
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  return {
    raw,
    lines,
    activeBytes: raw.length,
    activeRecords: lines.length,
    activeDevice: stat?.dev ?? null,
    activeInode: stat?.ino ?? null,
    tailSha256: lines.length ? sha256(lines.at(-1)) : null,
  };
}

function stateFileFor(filePath) {
  return `${filePath}.active-state.json`;
}

function archiveDirectoryFor(filePath) {
  return `${filePath}.archive`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function stateMatches(filePath, state) {
  if (!state || state.schemaVersion !== 1) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return error.code === 'ENOENT'
      && Number(state.activeBytes) === 0
      && Number(state.activeRecords) === 0;
  }
  return Number(state.activeBytes) === stat.size
    && Number(state.activeDevice) === stat.dev
    && Number(state.activeInode) === stat.ino
    && String(state.tailSha256 || '') === String(readLastLineDigest(filePath) || '');
}

function activeState(filePath) {
  const saved = readJson(stateFileFor(filePath));
  if (stateMatches(filePath, saved)) return saved;
  const scanned = scanActive(filePath);
  return {
    schemaVersion: 1,
    activeBytes: scanned.activeBytes,
    activeRecords: scanned.activeRecords,
    activeDevice: scanned.activeDevice,
    activeInode: scanned.activeInode,
    tailSha256: scanned.tailSha256,
  };
}

function persistState(filePath, state, limits) {
  atomicWritePrivate(stateFileFor(filePath), `${JSON.stringify({
    schemaVersion: 1,
    sourceFile: path.basename(filePath),
    activeBytes: state.activeBytes,
    activeRecords: state.activeRecords,
    activeDevice: state.activeDevice,
    activeInode: state.activeInode,
    tailSha256: state.tailSha256,
    maxRecords: limits.maxRecords,
    maxBytes: limits.maxBytes,
    retainRecords: limits.retainRecords,
    retainBytes: limits.retainBytes,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function normalizeLimits({
  maxRecords = DEFAULT_MAX_RECORDS,
  maxBytes = DEFAULT_MAX_BYTES,
  retainRecords = null,
  retainBytes = null,
} = {}) {
  const normalizedMaxRecords = Math.max(
    1,
    Math.floor(Number(maxRecords) || DEFAULT_MAX_RECORDS),
  );
  const normalizedMaxBytes = Math.max(
    1024,
    Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES),
  );
  // 高低水位避免 active=50 时每追加一条就制造一个单行 archive shard。
  // 默认触顶后收回到一半；active 始终不超过 max，archive 仍逐字节无损。
  const normalizedRetainRecords = Math.min(
    normalizedMaxRecords,
    Math.max(
      1,
      Math.floor(Number(retainRecords) || Math.ceil(normalizedMaxRecords / 2)),
    ),
  );
  const normalizedRetainBytes = Math.min(
    normalizedMaxBytes,
    Math.max(
      1,
      Math.floor(Number(retainBytes) || Math.ceil(normalizedMaxBytes / 2)),
    ),
  );
  return {
    maxRecords: normalizedMaxRecords,
    maxBytes: normalizedMaxBytes,
    retainRecords: normalizedRetainRecords,
    retainBytes: normalizedRetainBytes,
  };
}

function compactTimestamp(line, fallback) {
  try {
    const value = JSON.parse(line.toString('utf8'))?.compiledAt;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().replace(/[-:.]/g, '');
    }
  } catch (_) {}
  return fallback;
}

function ensureArchiveSegment(filePath, archivedLines, transaction) {
  const content = lineBuffer(archivedLines);
  const digest = sha256(content);
  const archiveDirectory = archiveDirectoryFor(filePath);
  ensurePrivateDirectory(archiveDirectory);
  const firstAt = compactTimestamp(archivedLines[0], 'unknown-first');
  const lastAt = compactTimestamp(archivedLines.at(-1), 'unknown-last');
  const archivePath = path.join(
    archiveDirectory,
    `${transaction.order}--${firstAt}--${lastAt}--${transaction.id.slice(0, 20)}.jsonl`,
  );
  if (fs.existsSync(archivePath)) {
    const existing = fs.readFileSync(archivePath);
    if (existing.length !== content.length || sha256(existing) !== digest) {
      const error = new Error(`compile manifest archive digest 冲突：${archivePath}`);
      error.code = 'COMPILE_MANIFEST_ARCHIVE_CONFLICT';
      throw error;
    }
    return { archivePath, digest, bytes: content.length, existed: true };
  }
  const temporary = `${archivePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    writeAllSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, archivePath);
  fs.chmodSync(archivePath, 0o600);
  fsyncDirectory(archiveDirectory);
  return { archivePath, digest, bytes: content.length, existed: false };
}

function splitForRetention(lines, limits) {
  let retainedBytes = 0;
  let retainedCount = 0;
  let firstRetained = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bytes = lines[index].length + 1;
    const wouldExceedCount = retainedCount >= limits.retainRecords;
    const wouldExceedBytes = retainedCount > 0 && retainedBytes + bytes > limits.retainBytes;
    if (wouldExceedCount || wouldExceedBytes) break;
    retainedBytes += bytes;
    retainedCount += 1;
    firstRetained = index;
  }
  return {
    archived: lines.slice(0, firstRetained),
    retained: lines.slice(firstRetained),
  };
}

function compactUnlocked(filePath, options = {}) {
  const limits = normalizeLimits(options);
  const scanned = scanActive(filePath);
  if (
    scanned.activeRecords <= limits.maxRecords
    && scanned.activeBytes <= limits.maxBytes
  ) {
    persistState(filePath, scanned, limits);
    return {
      compacted: false,
      activeRecords: scanned.activeRecords,
      activeBytes: scanned.activeBytes,
      archivedRecords: 0,
      archivePath: null,
    };
  }
  const { archived, retained } = splitForRetention(scanned.lines, limits);
  if (!archived.length) {
    persistState(filePath, scanned, limits);
    return {
      compacted: false,
      activeRecords: scanned.activeRecords,
      activeBytes: scanned.activeBytes,
      archivedRecords: 0,
      archivePath: null,
      oversizedLatestRecord: true,
    };
  }
  const stat = fs.statSync(filePath, { bigint: true });
  const transaction = {
    id: sha256([
      String(stat.dev),
      String(stat.ino),
      String(scanned.activeBytes),
      sha256(scanned.raw),
      String(archived.length),
      String(retained.length),
    ].join(':')),
    // mtimeNs keeps immutable shards in original rotation order without a
    // mutable central index. A retry after archive fsync sees the same active
    // inode/mtime and therefore resolves to the same shard.
    order: String(stat.mtimeNs).padStart(20, '0'),
  };
  const archive = ensureArchiveSegment(filePath, archived, transaction);
  if (typeof options.afterArchiveCommitted === 'function') {
    options.afterArchiveCommitted({ ...archive, archivedRecords: archived.length });
  }
  const retainedContent = lineBuffer(retained);
  atomicWritePrivate(filePath, retainedContent);
  if (typeof options.afterActiveReplaced === 'function') {
    options.afterActiveReplaced({ ...archive, archivedRecords: archived.length });
  }
  const active = scanActive(filePath);
  persistState(filePath, active, limits);
  return {
    compacted: true,
    activeRecords: active.activeRecords,
    activeBytes: active.activeBytes,
    archivedRecords: archived.length,
    archivedBytes: archive.bytes,
    archivePath: archive.archivePath,
    archiveExisted: archive.existed,
  };
}

function compactBoundedJsonl(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  return withJournalLock(resolved, () => compactUnlocked(resolved, options), options);
}

function appendBoundedJsonl(filePath, value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('compile manifest entry 必须是 object');
  }
  const resolved = path.resolve(filePath);
  const limits = normalizeLimits(options);
  return withJournalLock(resolved, () => {
    let state = activeState(resolved);
    if (state.activeBytes > 0) {
      const fd = fs.openSync(resolved, 'r');
      let lastByte;
      try {
        const buffer = Buffer.allocUnsafe(1);
        fs.readSync(fd, buffer, 0, 1, state.activeBytes - 1);
        lastByte = buffer[0];
      } finally {
        fs.closeSync(fd);
      }
      if (lastByte !== 0x0a) appendPrivate(resolved, '\n');
    }
    const serialized = `${JSON.stringify(value)}\n`;
    appendPrivate(resolved, serialized);
    const stat = fs.statSync(resolved);
    state = {
      schemaVersion: 1,
      activeBytes: stat.size,
      activeRecords: Number(state.activeRecords || 0) + 1,
      activeDevice: stat.dev,
      activeInode: stat.ino,
      tailSha256: sha256(Buffer.from(serialized.slice(0, -1), 'utf8')),
    };
    if (state.activeRecords > limits.maxRecords || state.activeBytes > limits.maxBytes) {
      return { appended: true, ...compactUnlocked(resolved, options) };
    }
    persistState(resolved, state, limits);
    return {
      appended: true,
      compacted: false,
      activeRecords: state.activeRecords,
      activeBytes: state.activeBytes,
      archivedRecords: 0,
      archivePath: null,
    };
  }, options);
}

function inspectBoundedJsonl(filePath) {
  const resolved = path.resolve(filePath);
  const active = scanActive(resolved);
  const archiveDirectory = archiveDirectoryFor(resolved);
  const archiveFiles = fs.existsSync(archiveDirectory)
    ? fs.readdirSync(archiveDirectory)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(archiveDirectory, name))
    : [];
  return {
    filePath: resolved,
    activeRecords: active.activeRecords,
    activeBytes: active.activeBytes,
    archiveDirectory,
    archiveFiles,
    archivedBytes: archiveFiles.reduce((sum, item) => sum + fs.statSync(item).size, 0),
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_RECORDS,
  appendBoundedJsonl,
  archiveDirectoryFor,
  compactBoundedJsonl,
  inspectBoundedJsonl,
  stateFileFor,
};
