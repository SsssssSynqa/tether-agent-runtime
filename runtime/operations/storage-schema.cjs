// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CURRENT_STORAGE_VERSION = 1;
const MARKER_NAME = 'storage-version.json';
const EPHEMERAL_NAMES = new Set([
  '.tether-instance.lock',
  '.tether-supervisor.lock',
  '.tether-tool-journal.lock',
  'runtime-health.json',
]);
const HASH_BUFFER_BYTES = 1024 * 1024;

function isEphemeralName(name) {
  const value = String(name || '');
  return EPHEMERAL_NAMES.has(value)
    || value.startsWith('.tether-restore-')
    || value.startsWith('runtime-health.json.tmp-');
}

function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const descriptor = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function nonEphemeralEntries(root) {
  try {
    return fs.readdirSync(root)
      .filter((name) => !isEphemeralName(name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function sha256RegularFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let size = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally { fs.closeSync(descriptor); }
  return { size, sha256: hash.digest('hex') };
}

function inspectStorageSchema(storageRoot) {
  const root = path.resolve(storageRoot);
  const markerPath = path.join(root, MARKER_NAME);
  let marker;
  try {
    const stat = fs.lstatSync(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw storageError('TETHER_STORAGE_SCHEMA_CORRUPT', 'Storage version marker is not a regular file');
    }
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      const entries = nonEphemeralEntries(root);
      return {
        status: entries.length ? 'migration-required' : 'uninitialized',
        version: entries.length ? 0 : null,
        currentVersion: CURRENT_STORAGE_VERSION,
        entries,
        markerPath,
      };
    }
    if (error.code?.startsWith('TETHER_')) throw error;
    throw storageError('TETHER_STORAGE_SCHEMA_CORRUPT', 'Storage version marker is unreadable');
  }
  if (
    marker?.format !== 'tether-storage'
    || !Number.isSafeInteger(Number(marker.schemaVersion))
    || Number(marker.schemaVersion) < 1
  ) {
    throw storageError('TETHER_STORAGE_SCHEMA_CORRUPT', 'Storage version marker has an invalid shape');
  }
  const version = Number(marker.schemaVersion);
  if (version > CURRENT_STORAGE_VERSION) {
    throw storageError(
      'TETHER_STORAGE_VERSION_NEWER',
      `Storage schema v${version} is newer than this runtime supports`,
    );
  }
  return {
    status: version === CURRENT_STORAGE_VERSION ? 'current' : 'migration-required',
    version,
    currentVersion: CURRENT_STORAGE_VERSION,
    marker: structuredClone(marker),
    markerPath,
  };
}

function treeFingerprint(storageRoot) {
  const root = path.resolve(storageRoot);
  const entries = [];
  function walk(directory, prefix = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!prefix && isEphemeralName(item.name)) continue;
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const target = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        throw storageError('TETHER_STORAGE_SYMLINK', 'Storage migration refuses symbolic links');
      }
      if (item.isDirectory()) {
        entries.push({ path: `${relative}/`, type: 'directory' });
        walk(target, relative);
      } else if (item.isFile()) {
        const digest = sha256RegularFile(target);
        entries.push({
          path: relative,
          type: 'file',
          ...digest,
        });
      } else {
        throw storageError('TETHER_STORAGE_SPECIAL_FILE', 'Storage migration refuses special files');
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return crypto.createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

function initializeStorageSchema(storageRoot, {
  agentId = null,
  clock = () => new Date().toISOString(),
} = {}) {
  const inspected = inspectStorageSchema(storageRoot);
  if (inspected.status === 'current') return inspected;
  if (inspected.status !== 'uninitialized') {
    throw storageError(
      'TETHER_STORAGE_MIGRATION_REQUIRED',
      'Existing unversioned storage requires an explicit offline migration',
    );
  }
  const marker = {
    format: 'tether-storage',
    schemaVersion: CURRENT_STORAGE_VERSION,
    initializedAt: clock(),
    agentId: agentId == null ? null : String(agentId),
    migratedFrom: null,
  };
  writeJsonAtomic(inspected.markerPath, marker);
  return inspectStorageSchema(storageRoot);
}

function assertStorageAgent(inspected, agentId) {
  const expected = agentId == null ? null : String(agentId);
  const stored = inspected?.marker?.agentId == null ? null : String(inspected.marker.agentId);
  if (expected && stored && expected !== stored) {
    throw storageError(
      'TETHER_STORAGE_AGENT_MISMATCH',
      'Configured agent does not match the storage identity marker',
    );
  }
  return inspected;
}

function migrateStorageSchema(storageRoot, {
  agentId = null,
  clock = () => new Date().toISOString(),
} = {}) {
  const inspected = inspectStorageSchema(storageRoot);
  if (inspected.status === 'current') {
    return { ...assertStorageAgent(inspected, agentId), migrated: false };
  }
  if (inspected.status === 'uninitialized') {
    return { ...initializeStorageSchema(storageRoot, { agentId, clock }), migrated: true };
  }
  if (inspected.version !== 0) {
    throw storageError(
      'TETHER_STORAGE_MIGRATION_UNSUPPORTED',
      `No migration is implemented from storage schema v${inspected.version}`,
    );
  }
  const preMigrationSha256 = treeFingerprint(storageRoot);
  const marker = {
    format: 'tether-storage',
    schemaVersion: CURRENT_STORAGE_VERSION,
    initializedAt: clock(),
    agentId: agentId == null ? null : String(agentId),
    migratedFrom: 0,
    preMigrationSha256,
    migration: 'adopt-unversioned-layout-v1',
  };
  writeJsonAtomic(inspected.markerPath, marker);
  return { ...inspectStorageSchema(storageRoot), migrated: true };
}

function ensureRuntimeStorageSchema(storageRoot, options = {}) {
  const inspected = inspectStorageSchema(storageRoot);
  if (inspected.status === 'current') return assertStorageAgent(inspected, options.agentId);
  if (inspected.status === 'uninitialized') return initializeStorageSchema(storageRoot, options);
  throw storageError(
    'TETHER_STORAGE_MIGRATION_REQUIRED',
    'Storage schema migration is required; stop Tether and run tether-ops migrate',
  );
}

module.exports = {
  CURRENT_STORAGE_VERSION,
  EPHEMERAL_NAMES,
  MARKER_NAME,
  assertStorageAgent,
  canonicalJson,
  ensureRuntimeStorageSchema,
  fsyncDirectory,
  initializeStorageSchema,
  inspectStorageSchema,
  isEphemeralName,
  migrateStorageSchema,
  nonEphemeralEntries,
  sha256RegularFile,
  treeFingerprint,
  writeJsonAtomic,
};
