// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { CausalJournal } = require('../causal-journal.cjs');
const { ToolJournal } = require('../tools/tool-journal.cjs');

function durableModule(name) {
  const exported = path.resolve(__dirname, '..', 'durable', name);
  const canonical = path.resolve(__dirname, '..', '..', name);
  return require(fs.existsSync(exported) ? exported : canonical);
}

const { DurableInbox } = durableModule('durable-inbox.js');
const {
  CURRENT_STORAGE_VERSION,
  canonicalJson,
  fsyncDirectory,
  inspectStorageSchema,
  isEphemeralName,
  writeJsonAtomic,
} = require('./storage-schema.cjs');

const COPY_BUFFER_BYTES = 1024 * 1024;

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function physicalPath(candidatePath) {
  let cursor = path.resolve(candidatePath);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw backupError('TETHER_PATH_UNRESOLVABLE', 'Path has no existing ancestor');
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const resolved = (fs.realpathSync.native || fs.realpathSync)(cursor);
  return path.resolve(resolved, ...suffix);
}

function assertSeparateTrees(firstPath, secondPath, code, message, { oneWay = false } = {}) {
  const first = physicalPath(firstPath);
  const second = physicalPath(secondPath);
  if (isInside(first, second) || (!oneWay && isInside(second, first))) {
    throw backupError(code, message);
  }
}

function safeManifestPath(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  if (!raw || path.posix.isAbsolute(raw) || raw.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup manifest contains an unsafe path');
  }
  return raw;
}

function sha256File(filePath, byteLimit = null) {
  const stat = fs.statSync(filePath);
  const limit = byteLimit == null ? stat.size : Number(byteLimit);
  if (!Number.isSafeInteger(limit) || limit < 0 || stat.size < limit) {
    throw backupError('TETHER_BACKUP_TRUNCATED', 'Backup file is shorter than its required proof prefix');
  }
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(1, limit)));
  let offset = 0;
  try {
    while (offset < limit) {
      const wanted = Math.min(buffer.length, limit - offset);
      const bytesRead = fs.readSync(descriptor, buffer, 0, wanted, offset);
      if (!bytesRead) throw backupError('TETHER_BACKUP_TRUNCATED', 'Backup file ended unexpectedly');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function copyFileVerified(source, destination) {
  const sourceDescriptor = fs.openSync(source, 'r');
  const destinationDescriptor = fs.openSync(destination, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let size = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      fs.writeSync(destinationDescriptor, buffer, 0, bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    fs.fsyncSync(destinationDescriptor);
  } finally {
    fs.closeSync(sourceDescriptor);
    fs.closeSync(destinationDescriptor);
  }
  fs.chmodSync(destination, 0o600);
  return { size, sha256: hash.digest('hex') };
}

function restoreCopyAtomic(source, destination, entry, workRoot) {
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    workRoot,
    `${crypto.createHash('sha256').update(entry.path, 'utf8').digest('hex')}.partial`,
  );
  if (fs.existsSync(temporary)) {
    const stat = fs.lstatSync(temporary);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw backupError('TETHER_RESTORE_COPY_MISMATCH', `Restore work file is unsafe: ${entry.path}`);
    }
    if (stat.size !== entry.size || sha256File(temporary) !== entry.sha256) {
      fs.unlinkSync(temporary);
    }
  }
  if (!fs.existsSync(temporary)) {
    const copied = copyFileVerified(source, temporary);
    if (copied.size !== entry.size || copied.sha256 !== entry.sha256) {
      throw backupError('TETHER_RESTORE_COPY_MISMATCH', `Restore copy mismatch: ${entry.path}`);
    }
  }
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
  try {
    const descriptor = fs.openSync(path.dirname(destination), 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error;
  }
  return { size: entry.size, sha256: entry.sha256 };
}

function walkTree(root, { excludeEphemeral = false } = {}) {
  const directories = [];
  const files = [];
  function walk(directory, prefix = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!prefix && excludeEphemeral && isEphemeralName(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw backupError('TETHER_BACKUP_SYMLINK', `Backup refuses symbolic link: ${relative}`);
      }
      if (stat.isDirectory()) {
        directories.push(relative);
        walk(target, relative);
      } else if (stat.isFile()) {
        files.push({ path: relative, sourcePath: target, size: stat.size });
      } else {
        throw backupError('TETHER_BACKUP_SPECIAL_FILE', `Backup refuses special file: ${relative}`);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return { directories, files };
}

function manifestDigestPayload(manifest) {
  return {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    storageSchemaVersion: manifest.storageSchemaVersion,
    agentId: manifest.agentId,
    sessionAnchorSha256: manifest.sessionAnchorSha256,
    directories: manifest.directories,
    files: manifest.files,
  };
}

function validateJsonl(filePath, label) {
  const descriptor = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let pending = '';
  let lineNumber = 0;
  const validateLine = (line) => {
    lineNumber += 1;
    if (!line.trim()) return;
    try { JSON.parse(line); } catch (_) {
      throw backupError('TETHER_BACKUP_JSONL_INVALID', `${label} has invalid JSONL at line ${lineNumber}`);
    }
  };
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const parts = `${pending}${decoder.write(buffer.subarray(0, bytesRead))}`.split('\n');
      pending = parts.pop();
      for (const line of parts) validateLine(line);
    }
    pending += decoder.end();
    if (pending) validateLine(pending);
  } finally {
    fs.closeSync(descriptor);
  }
}

function shouldValidateAsState(relativePath) {
  if (relativePath.startsWith('memory/transcript-assets/')) return false;
  if (relativePath.startsWith('telegram-attachments/')) return false;
  return relativePath === 'session.json'
    || relativePath === 'storage-version.json'
    || relativePath === 'telegram-inbox.jsonl'
    || (relativePath.startsWith('memory/') && /\.jsonl?$/.test(relativePath))
    || (relativePath.startsWith('tools/') && /\.jsonl?$/.test(relativePath));
}

function verifySessionProof(dataRoot, { expectedAgentId = null } = {}) {
  const sessionPath = path.join(dataRoot, 'session.json');
  if (!fs.existsSync(sessionPath)) {
    const authority = walkTree(dataRoot).files.some((entry) => (
      entry.path !== 'storage-version.json' && entry.size > 0
    ));
    if (authority) {
      throw backupError('TETHER_BACKUP_SESSION_MISSING', 'Backup contains authority but no session anchor');
    }
    return null;
  }
  const sessionBytes = fs.readFileSync(sessionPath);
  const session = JSON.parse(sessionBytes.toString('utf8'));
  if (!session.sessionId || !session.agentId || session.schemaVersion !== 1) {
    throw backupError('TETHER_BACKUP_SESSION_INVALID', 'Backup session anchor has an invalid shape');
  }
  if (expectedAgentId != null && String(session.agentId) !== String(expectedAgentId)) {
    throw backupError('TETHER_BACKUP_AGENT_MISMATCH', 'Backup session belongs to a different agent');
  }
  const proof = session.memoryProof;
  if (proof) {
    const transcriptPath = path.join(dataRoot, 'memory', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) {
      throw backupError('TETHER_BACKUP_PROOF_MISSING', 'Backup session proof has no transcript');
    }
    if (
      proof.schemaVersion !== 1
      || !Number.isSafeInteger(Number(proof.transcriptBytes))
      || Number(proof.transcriptBytes) < 0
      || !/^[a-f0-9]{64}$/.test(String(proof.transcriptSha256 || ''))
    ) {
      throw backupError('TETHER_BACKUP_PROOF_INVALID', 'Backup session proof has an invalid shape');
    }
    if (sha256File(transcriptPath, Number(proof.transcriptBytes)) !== proof.transcriptSha256) {
      throw backupError('TETHER_BACKUP_PROOF_MISMATCH', 'Backup transcript does not match the session proof');
    }
  }
  return crypto.createHash('sha256').update(sessionBytes).digest('hex');
}

function verifyBackup(backupPath, { expectedAgentId = null } = {}) {
  const root = path.resolve(backupPath);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw backupError('TETHER_BACKUP_INVALID', 'Backup path must be a real directory');
  }
  const manifestPath = path.join(root, 'backup-manifest.json');
  let manifest;
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('manifest is not a file');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup manifest is missing or invalid');
  }
  if (
    manifest.format !== 'tether-backup'
    || manifest.formatVersion !== 1
    || typeof manifest.createdAt !== 'string'
    || !Number.isFinite(new Date(manifest.createdAt).getTime())
    || manifest.storageSchemaVersion !== CURRENT_STORAGE_VERSION
    || (manifest.agentId != null && (typeof manifest.agentId !== 'string' || !manifest.agentId))
    || (manifest.sessionAnchorSha256 != null
      && !/^[a-f0-9]{64}$/.test(String(manifest.sessionAnchorSha256)))
    || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.directories)
    || !/^[a-f0-9]{64}$/.test(String(manifest.rootSha256 || ''))
  ) {
    throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup manifest has an unsupported shape');
  }
  const dataRoot = path.join(root, 'data');
  let rootEntries;
  try { rootEntries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {
    throw backupError('TETHER_BACKUP_INVALID', 'Backup root is unreadable');
  }
  if (
    rootEntries.length !== 2
    || !rootEntries.some((entry) => entry.name === 'backup-manifest.json' && entry.isFile())
    || !rootEntries.some((entry) => entry.name === 'data' && entry.isDirectory())
  ) {
    throw backupError('TETHER_BACKUP_EXTRA_FILE', 'Backup root must contain only its manifest and data directory');
  }
  const expectedFiles = new Set();
  for (const entry of manifest.files) {
    const relative = safeManifestPath(entry.path);
    if (expectedFiles.has(relative)) throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup manifest repeats a file');
    if (
      !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))
    ) throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup manifest has an invalid file record');
    expectedFiles.add(relative);
    const filePath = path.resolve(dataRoot, relative);
    if (!isInside(dataRoot, filePath)) throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup path escapes data root');
    const fileStat = fs.lstatSync(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw backupError('TETHER_BACKUP_FILE_INVALID', `Backup entry is not a regular file: ${relative}`);
    }
    if (fileStat.size !== entry.size || sha256File(filePath) !== entry.sha256) {
      throw backupError('TETHER_BACKUP_HASH_MISMATCH', `Backup hash mismatch: ${relative}`);
    }
    if (shouldValidateAsState(relative)) {
      if (relative.endsWith('.jsonl')) validateJsonl(filePath, relative);
      else {
        try { JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {
          throw backupError('TETHER_BACKUP_JSON_INVALID', `Backup state JSON is invalid: ${relative}`);
        }
      }
    }
  }
  const actual = walkTree(dataRoot);
  const actualFiles = new Set(actual.files.map((entry) => entry.path));
  if (
    actualFiles.size !== expectedFiles.size
    || [...actualFiles].some((relative) => !expectedFiles.has(relative))
  ) {
    throw backupError('TETHER_BACKUP_EXTRA_FILE', 'Backup data contains files absent from its manifest');
  }
  const directoryList = manifest.directories.map(safeManifestPath);
  if (new Set(directoryList).size !== directoryList.length) {
    throw backupError('TETHER_BACKUP_MANIFEST_INVALID', 'Backup manifest repeats a directory');
  }
  const expectedDirectories = [...directoryList].sort();
  if (canonicalJson([...actual.directories].sort()) !== canonicalJson(expectedDirectories)) {
    throw backupError('TETHER_BACKUP_EXTRA_DIRECTORY', 'Backup data directories do not match its manifest');
  }
  const calculatedRoot = crypto.createHash('sha256')
    .update(canonicalJson(manifestDigestPayload(manifest)))
    .digest('hex');
  if (calculatedRoot !== manifest.rootSha256) {
    throw backupError('TETHER_BACKUP_ROOT_MISMATCH', 'Backup root digest does not match its manifest');
  }
  const schema = inspectStorageSchema(dataRoot);
  if (schema.status !== 'current') {
    throw backupError('TETHER_BACKUP_SCHEMA_INVALID', 'Backup storage schema is not current');
  }
  if (
    expectedAgentId != null
    && String(expectedAgentId) !== String(manifest.agentId || schema.marker?.agentId || '')
  ) {
    throw backupError('TETHER_BACKUP_AGENT_MISMATCH', 'Backup belongs to a different configured agent');
  }
  if (
    schema.marker?.agentId != null
    && manifest.agentId != null
    && String(schema.marker.agentId) !== String(manifest.agentId)
  ) {
    throw backupError('TETHER_BACKUP_AGENT_MISMATCH', 'Backup manifest and storage identity disagree');
  }
  const sessionAnchorSha256 = verifySessionProof(dataRoot, {
    expectedAgentId: manifest.agentId || schema.marker?.agentId || null,
  });
  if ((sessionAnchorSha256 || null) !== (manifest.sessionAnchorSha256 || null)) {
    throw backupError('TETHER_BACKUP_SESSION_MISMATCH', 'Backup session anchor digest is inconsistent');
  }
  if (fs.existsSync(path.join(dataRoot, 'memory', 'causal-journal.jsonl'))) {
    new CausalJournal({ directory: path.join(dataRoot, 'memory') });
  }
  if (fs.existsSync(path.join(dataRoot, 'tools', 'tool-journal.jsonl'))) {
    new ToolJournal({ directory: path.join(dataRoot, 'tools') });
  }
  if (fs.existsSync(path.join(dataRoot, 'telegram-inbox.jsonl'))) {
    new DurableInbox({
      filePath: path.join(dataRoot, 'telegram-inbox.jsonl'),
      corruptionPolicy: 'fail-closed',
      log: () => {},
    });
  }
  return { passed: true, backupPath: root, dataRoot, manifest: structuredClone(manifest) };
}

function createBackup({
  storageRoot,
  destinationRoot,
  agentId = null,
  clock = () => new Date().toISOString(),
} = {}) {
  const sourceRoot = path.resolve(storageRoot);
  const destination = path.resolve(destinationRoot);
  if (isInside(sourceRoot, destination)) {
    throw backupError('TETHER_BACKUP_DESTINATION_INVALID', 'Backup destination must be outside storage.root');
  }
  assertSeparateTrees(
    sourceRoot,
    destination,
    'TETHER_BACKUP_DESTINATION_INVALID',
    'Backup destination must be outside storage.root',
    { oneWay: true },
  );
  const schema = inspectStorageSchema(sourceRoot);
  if (schema.status !== 'current') {
    throw backupError('TETHER_BACKUP_SCHEMA_INVALID', 'Migrate storage before creating a backup');
  }
  if (
    schema.marker?.agentId != null
    && agentId != null
    && String(schema.marker.agentId) !== String(agentId)
  ) {
    throw backupError('TETHER_BACKUP_AGENT_MISMATCH', 'Configured agent does not match storage identity');
  }
  const destinationExists = fs.existsSync(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const destinationStat = fs.lstatSync(destination);
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
    throw backupError('TETHER_BACKUP_DESTINATION_INVALID', 'Backup destination must be a real directory');
  }
  if (!destinationExists) fs.chmodSync(destination, 0o700);
  const staging = path.join(destination, `.tether-backup-${crypto.randomUUID()}.partial`);
  const dataRoot = path.join(staging, 'data');
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  try {
    const sourceTree = walkTree(sourceRoot, { excludeEphemeral: true });
    for (const relative of sourceTree.directories) {
      fs.mkdirSync(path.join(dataRoot, relative), { recursive: true, mode: 0o700 });
    }
    const files = [];
    for (const entry of sourceTree.files) {
      const target = path.join(dataRoot, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const copied = copyFileVerified(entry.sourcePath, target);
      files.push({ path: entry.path, ...copied });
    }
    const effectiveAgentId = agentId == null ? schema.marker?.agentId : String(agentId);
    const sessionAnchorSha256 = verifySessionProof(dataRoot, {
      expectedAgentId: effectiveAgentId || null,
    });
    const manifest = {
      format: 'tether-backup',
      formatVersion: 1,
      createdAt: clock(),
      storageSchemaVersion: schema.version,
      agentId: effectiveAgentId == null ? null : String(effectiveAgentId),
      sessionAnchorSha256,
      directories: [...sourceTree.directories].sort(),
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
    manifest.rootSha256 = crypto.createHash('sha256')
      .update(canonicalJson(manifestDigestPayload(manifest)))
      .digest('hex');
    writeJsonAtomic(path.join(staging, 'backup-manifest.json'), manifest);
    verifyBackup(staging);
    const stamp = String(manifest.createdAt).replace(/[-:.]/g, '').replace(/[^0-9TZ]/g, '');
    const finalPath = path.join(destination, `tether-backup-${stamp}-${manifest.rootSha256.slice(0, 12)}`);
    if (fs.existsSync(finalPath)) {
      throw backupError('TETHER_BACKUP_EXISTS', 'An identical backup directory name already exists');
    }
    fs.renameSync(staging, finalPath);
    fsyncDirectory(destination);
    return { backupPath: finalPath, manifest };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    throw error;
  }
}

function restoreBackup({
  backupPath,
  storageRoot,
  agentId = null,
  clock = () => new Date().toISOString(),
} = {}) {
  const verified = verifyBackup(backupPath, { expectedAgentId: agentId });
  const targetRoot = path.resolve(storageRoot);
  if (isInside(verified.backupPath, targetRoot) || isInside(targetRoot, verified.backupPath)) {
    throw backupError('TETHER_RESTORE_TARGET_INVALID', 'Restore target and backup must not contain one another');
  }
  assertSeparateTrees(
    verified.backupPath,
    targetRoot,
    'TETHER_RESTORE_TARGET_INVALID',
    'Restore target and backup must not contain one another',
  );
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const targetStat = fs.lstatSync(targetRoot);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw backupError('TETHER_RESTORE_TARGET_INVALID', 'Restore target must be a real directory');
  }
  const receiptPath = path.join(targetRoot, '.tether-restore-receipt.json');
  let receipt = null;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') {
      throw backupError('TETHER_RESTORE_RECEIPT_INVALID', 'Restore receipt is unreadable');
    }
  }
  if (receipt && (
    receipt.schemaVersion !== 1
    || !['prepared', 'completed'].includes(receipt.state)
    || receipt.backupRootSha256 !== verified.manifest.rootSha256
  )) {
    throw backupError('TETHER_RESTORE_RECEIPT_MISMATCH', 'Restore receipt belongs to another or invalid backup');
  }
  const allowedFiles = new Set(verified.manifest.files.map((entry) => entry.path));
  if (receipt) {
    const targetTree = walkTree(targetRoot);
    const extras = targetTree.files
      .map((entry) => entry.path)
      .filter((relative) => !allowedFiles.has(relative))
      .filter((relative) => ![
        '.tether-instance.lock',
        '.tether-supervisor.lock',
        '.tether-restore-receipt.json',
      ].includes(relative));
    const unexpected = extras.filter((relative) => !relative.startsWith('.tether-restore-work/'));
    if (unexpected.length) {
      throw backupError('TETHER_RESTORE_TARGET_NOT_EMPTY', 'Restore target contains files outside the recorded backup');
    }
    const allowedDirectories = new Set(verified.manifest.directories);
    const unexpectedDirectories = targetTree.directories.filter((relative) => (
      !allowedDirectories.has(relative)
      && relative !== '.tether-restore-work'
      && !relative.startsWith('.tether-restore-work/')
    ));
    if (unexpectedDirectories.length) {
      throw backupError(
        'TETHER_RESTORE_TARGET_NOT_EMPTY',
        'Restore target contains directories outside the recorded backup',
      );
    }
  } else {
    const existing = fs.readdirSync(targetRoot).filter((name) => ![
      '.tether-instance.lock',
      '.tether-supervisor.lock',
    ].includes(name));
    if (existing.length) {
      throw backupError('TETHER_RESTORE_TARGET_NOT_EMPTY', 'Restore target must be empty');
    }
    writeJsonAtomic(receiptPath, {
      schemaVersion: 1,
      state: 'prepared',
      backupRootSha256: verified.manifest.rootSha256,
      preparedAt: clock(),
    });
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  }
  for (const relative of verified.manifest.directories) {
    fs.mkdirSync(path.join(targetRoot, relative), { recursive: true, mode: 0o700 });
  }
  const orderedFiles = [...verified.manifest.files].sort((left, right) => {
    if (left.path === 'session.json') return 1;
    if (right.path === 'session.json') return -1;
    return left.path.localeCompare(right.path);
  });
  const restoreWorkRoot = path.join(targetRoot, '.tether-restore-work');
  for (const entry of orderedFiles) {
    const source = path.join(verified.dataRoot, entry.path);
    const target = path.join(targetRoot, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
      const existingStat = fs.lstatSync(target);
      if (
        existingStat.isSymbolicLink()
        || !existingStat.isFile()
        || existingStat.size !== entry.size
        || sha256File(target) !== entry.sha256
      ) {
        throw backupError('TETHER_RESTORE_COPY_MISMATCH', `Existing restore file is ambiguous: ${entry.path}`);
      }
      continue;
    }
    const copied = restoreCopyAtomic(source, target, entry, restoreWorkRoot);
    if (copied.size !== entry.size || copied.sha256 !== entry.sha256) {
      throw backupError('TETHER_RESTORE_COPY_MISMATCH', `Restore copy mismatch: ${entry.path}`);
    }
  }
  try { fs.rmSync(restoreWorkRoot, { recursive: true, force: true }); } catch (_) { /* receipt remains authoritative */ }
  writeJsonAtomic(receiptPath, {
    schemaVersion: 1,
    state: 'completed',
    backupRootSha256: verified.manifest.rootSha256,
    restoredAt: clock(),
  });
  return {
    restored: true,
    replayed: receipt.state === 'completed',
    storageRoot: targetRoot,
    backupRootSha256: verified.manifest.rootSha256,
    files: verified.manifest.files.length,
  };
}

module.exports = {
  backupError,
  assertSeparateTrees,
  copyFileVerified,
  createBackup,
  physicalPath,
  restoreCopyAtomic,
  restoreBackup,
  safeManifestPath,
  sha256File,
  verifyBackup,
  verifySessionProof,
  walkTree,
};
