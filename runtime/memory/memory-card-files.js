// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeMemoryPolicy } = require('./memory-policy.js');
const { addDays } = require('./memory-time.js');

const CARD_TYPES = new Set(['day', 'week']);
const PERIOD_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_STALE_MS = 2 * 60 * 1000;
const STALE_MTIME_TOLERANCE_MS = 1000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateCardIdentity(cardType, periodKey) {
  if (!CARD_TYPES.has(cardType)) throw new Error(`Unknown cardType: ${cardType}`);
  if (!PERIOD_KEY_RE.test(String(periodKey || ''))) throw new Error(`Invalid periodKey: ${periodKey}`);
}

function cardMarkdownPath(directory, cardType, periodKey, memoryPolicy = {}) {
  validateCardIdentity(cardType, periodKey);
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const root = path.resolve(directory);
  const year = periodKey.slice(0, 4);
  const name = cardType === 'day'
    ? `${periodKey}.md`
    : `${periodKey}--${addDays(periodKey, 6)}.md`;
  return path.join(
    root,
    cardType === 'day' ? policy.files.dayDirectory : policy.files.weekDirectory,
    year,
    name,
  );
}

function cardHeading(cardType, periodKey, memoryPolicy = {}) {
  validateCardIdentity(cardType, periodKey);
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const template = cardType === 'day'
    ? policy.files.dayHeadingTemplate
    : policy.files.weekHeadingTemplate;
  return template
    .replaceAll('{agent}', policy.agent.displayName)
    .replaceAll('{period}', periodKey)
    .replaceAll('{end}', addDays(periodKey, 6));
}

function renderCardMarkdown(card, memoryPolicy = {}) {
  return `${cardHeading(card.cardType, card.period.key, memoryPolicy)}\n\n${String(card.content || '').trim()}\n`;
}

function parseCardMarkdown(raw, cardType, periodKey, memoryPolicy = {}) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const expected = cardHeading(cardType, periodKey, memoryPolicy);
  if (text.startsWith(`${expected}\n`)) {
    return text.slice(expected.length).replace(/^\n+/, '').trim();
  }
  return text.trim();
}

function fsyncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (_) { /* some filesystems do not allow directory fsync */ }
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

function releaseStaleLock(lockPath) {
  let stat;
  try { stat = fs.statSync(lockPath); } catch (_) { return; }
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch (_) {}
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < LOCK_STALE_MS || pidAlive(Number(owner?.pid))) return;
  try { fs.unlinkSync(path.join(lockPath, 'owner.json')); } catch (_) {}
  try { fs.rmdirSync(lockPath); } catch (_) {}
}

function waitSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function withMemorySyncLock(
  managedDirectory,
  fn,
  { timeoutMs = 3000, memoryPolicy = {} } = {},
) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const root = path.dirname(path.resolve(managedDirectory));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, policy.files.lockName);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      releaseStaleLock(lockPath);
      if (Date.now() >= deadline) {
        const failure = new Error(`Memory file synchronization lock timed out: ${lockPath}`);
        failure.code = 'TETHER_MEMORY_LOCK_TIMEOUT';
        throw failure;
      }
      waitSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(path.join(lockPath, 'owner.json')); } catch (_) {}
    try { fs.rmdirSync(lockPath); } catch (_) {}
  }
}

function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  const descriptor = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(directory);
}

function appendRevisionEvent(directory, event) {
  const filePath = path.join(path.resolve(directory), 'file-revisions.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(event)}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function archiveExistingFile(directory, cardType, periodKey, filePath, beforeHash) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const revisionDir = path.join(
    path.resolve(directory),
    '.revisions',
    cardType,
    periodKey,
  );
  fs.mkdirSync(revisionDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(revisionDir, 0o700);
  const revisionPath = path.join(revisionDir, `${stamp}-${beforeHash.slice(0, 12)}.md`);
  fs.copyFileSync(filePath, revisionPath);
  fs.chmodSync(revisionPath, 0o600);
  fsyncDirectory(revisionDir);
  return revisionPath;
}

function writeCardMarkdown({
  directory,
  card,
  memoryPolicy = {},
  actor = null,
  reason = 'card-generated',
  onlyIfMissing = false,
} = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const filePath = cardMarkdownPath(directory, card.cardType, card.period.key, policy);
  const rendered = renderCardMarkdown(card, policy);
  return withMemorySyncLock(directory, () => {
    if (onlyIfMissing && fs.existsSync(filePath)) {
      return readCardMarkdown(directory, card.cardType, card.period.key, policy);
    }
    const before = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    const beforeHash = before ? sha256(before) : null;
    const afterHash = sha256(rendered);
    if (beforeHash === afterHash) {
      return {
        filePath,
        content: parseCardMarkdown(rendered, card.cardType, card.period.key, policy),
        revision: afterHash,
        mtime: fs.statSync(filePath).mtime.toISOString(),
        unchanged: true,
      };
    }
    const revisionPath = before
      ? archiveExistingFile(directory, card.cardType, card.period.key, filePath, beforeHash)
      : null;
    atomicWrite(filePath, rendered);
    appendRevisionEvent(directory, {
      type: policy.records.fileRevisionType,
      schema: 1,
      layer: card.cardType,
      periodKey: card.period.key,
      filePath,
      actor: actor || policy.actors.automatic,
      reason,
      beforeHash,
      afterHash,
      revisionPath,
      at: new Date().toISOString(),
    });
    return {
      filePath,
      content: String(card.content || '').trim(),
      revision: afterHash,
      mtime: fs.statSync(filePath).mtime.toISOString(),
      unchanged: false,
    };
  }, { memoryPolicy: policy });
}

function readCardMarkdown(directory, cardType, periodKey, memoryPolicy = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const filePath = cardMarkdownPath(directory, cardType, periodKey, policy);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath);
  return {
    filePath,
    content: parseCardMarkdown(raw.toString('utf8'), cardType, periodKey, policy),
    revision: sha256(raw),
    mtime: fs.statSync(filePath).mtime.toISOString(),
  };
}

function fileMtimeMs(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch (_) { return 0; }
}

function isCardStaleFromFiles({
  directory,
  foldLogDir = null,
  card,
  memoryPolicy = {},
} = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const createdAt = new Date(card?.createdAt || 0).getTime();
  if (!Number.isFinite(createdAt) || !card?.period?.key) return false;
  const changedAfterCard = (filePath) => (
    fileMtimeMs(filePath) > createdAt + STALE_MTIME_TOLERANCE_MS
  );
  const periodKey = card.period.key;
  if (card.cardType === 'day') {
    return foldLogDir
      ? changedAfterCard(path.join(path.resolve(foldLogDir), `${periodKey}.md`))
      : false;
  }
  if (card.cardType !== 'week') return false;
  for (let offset = 0; offset < 7; offset += 1) {
    const dayKey = addDays(periodKey, offset);
    if (
      (foldLogDir && changedAfterCard(path.join(path.resolve(foldLogDir), `${dayKey}.md`)))
      || changedAfterCard(cardMarkdownPath(directory, 'day', dayKey, policy))
    ) return true;
  }
  return false;
}

module.exports = {
  CARD_TYPES,
  PERIOD_KEY_RE,
  atomicWrite,
  cardHeading,
  cardMarkdownPath,
  isCardStaleFromFiles,
  parseCardMarkdown,
  readCardMarkdown,
  renderCardMarkdown,
  sha256,
  withMemorySyncLock,
  writeCardMarkdown,
};
