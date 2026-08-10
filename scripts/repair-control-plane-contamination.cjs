#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  containsControlPlaneArtifact,
  sanitizeDerivedMemoryText,
} = require('../runtime/memory/control-plane-boundary.js');
const {
  atomicWrite,
  readCardMarkdown,
  sha256,
  withMemorySyncLock,
  writeCardMarkdown,
} = require('../runtime/memory/memory-card-files.js');
const {
  MemoryCardStore,
  appendFsynced,
  readJsonl,
} = require('../runtime/memory/memory-card-store.js');
const { normalizeMemoryPolicy } = require('../runtime/memory/memory-policy.js');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function usage() {
  return 'Usage: node scripts/repair-control-plane-contamination.cjs '
    + '--config /absolute/config.json [--legacy-fold-dir /absolute/path] [--apply]';
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function archiveFile(filePath, revisionDirectory) {
  const before = fs.readFileSync(filePath);
  const beforeHash = sha256(before);
  privateDirectory(revisionDirectory);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const revisionPath = path.join(
    revisionDirectory,
    `${stamp}-${beforeHash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}${path.extname(filePath)}`,
  );
  fs.copyFileSync(filePath, revisionPath);
  fs.chmodSync(revisionPath, 0o600);
  return { beforeHash, revisionPath };
}

function markdownFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === '.revisions') return [];
        return markdownFiles(item);
      }
      return entry.isFile() && entry.name.endsWith('.md') ? [item] : [];
    })
    .sort();
}

function policyFromConfig(config) {
  return normalizeMemoryPolicy({
    agent: config.agent,
    owner: {
      ...config.owner,
      disallowedDisplayNames: config.addressPolicy?.disallowedOwnerNames || [],
    },
    sourceLabels: config.memory?.sourceLabels || {},
    time: config.memory?.time || {},
    files: config.memory?.files || {},
    records: config.memory?.records || {},
    actors: config.memory?.actors || {},
  });
}

function findAffectedCards(cardsDirectory, policy) {
  const result = [];
  for (const cardType of ['day', 'week']) {
    const layerDirectory = path.join(
      cardsDirectory,
      cardType === 'day' ? policy.files.dayDirectory : policy.files.weekDirectory,
    );
    for (const filePath of markdownFiles(layerDirectory)) {
      const periodKey = path.basename(filePath).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(periodKey)) continue;
      const card = readCardMarkdown(cardsDirectory, cardType, periodKey, policy);
      const clean = sanitizeDerivedMemoryText(card?.content || '');
      if (clean && clean !== String(card?.content || '').trim()) {
        result.push({ cardType, periodKey, filePath, before: card.content, after: clean });
      }
    }
  }
  return result;
}

function findJsonlCardReconciliations(cardsDirectory, policy) {
  const latest = new Map();
  for (const card of readJsonl(path.join(cardsDirectory, 'cards.jsonl'))) {
    if (card?.type !== 'memory-card' || !card?.period?.key) continue;
    const key = `${card.cardType}:${card.period.key}`;
    const prior = latest.get(key);
    if (!prior || Number(card.version) > Number(prior.version)) latest.set(key, card);
  }
  const result = [];
  for (const card of latest.values()) {
    if (!containsControlPlaneArtifact(card.content)) continue;
    const markdown = readCardMarkdown(
      cardsDirectory,
      card.cardType,
      card.period.key,
      policy,
    );
    const content = sanitizeDerivedMemoryText(markdown?.content || card.content);
    if (!content || containsControlPlaneArtifact(content)) continue;
    result.push({ card, content });
  }
  return result;
}

function findAffectedTextFiles(directory) {
  return markdownFiles(directory).flatMap((filePath) => {
    const before = fs.readFileSync(filePath, 'utf8');
    const normalizedBefore = before.replace(/\r\n?/gu, '\n').trim();
    const clean = sanitizeDerivedMemoryText(before);
    const after = `${clean}\n`;
    return clean !== normalizedBefore ? [{ filePath, before, after }] : [];
  });
}

function applyDerivedFileRepairs({
  files,
  managedDirectory,
  revisionRoot,
  revisionJournal,
  layer,
  policy,
}) {
  if (!files.length) return;
  withMemorySyncLock(managedDirectory, () => {
    for (const repair of files) {
      const periodKey = path.basename(repair.filePath).slice(0, 10) || 'unknown';
      const archived = archiveFile(
        repair.filePath,
        path.join(revisionRoot, layer, periodKey),
      );
      atomicWrite(repair.filePath, repair.after);
      appendFsynced(revisionJournal, {
        type: policy.records.fileRevisionType,
        schema: 1,
        layer,
        periodKey,
        filePath: repair.filePath,
        actor: 'system:control-plane-repair',
        reason: 'control-plane-contamination-repair',
        beforeHash: archived.beforeHash,
        afterHash: sha256(repair.after),
        revisionPath: archived.revisionPath,
        at: new Date().toISOString(),
      });
    }
  }, { memoryPolicy: policy });
}

function main() {
  const configArgument = argument('--config');
  if (!configArgument) throw new Error(usage());
  const configPath = path.resolve(configArgument);
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) throw new Error(usage());
  const apply = process.argv.includes('--apply');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const policy = policyFromConfig(config);
  const storageRoot = path.resolve(config.storage?.root || '');
  if (!storageRoot) throw new Error('config.storage.root is required');
  const memoryDirectory = path.join(storageRoot, 'memory');
  const cardsDirectory = path.join(memoryDirectory, 'cards');
  const foldsDirectory = path.join(memoryDirectory, policy.files.foldDirectory);
  const revisionJournal = path.join(cardsDirectory, 'file-revisions.jsonl');
  const revisionRoot = path.join(cardsDirectory, '.revisions');
  const cards = findAffectedCards(cardsDirectory, policy);
  const jsonlCards = findJsonlCardReconciliations(cardsDirectory, policy);
  const folds = findAffectedTextFiles(foldsDirectory);
  const legacyFoldDirectory = argument('--legacy-fold-dir');
  const legacyFolds = legacyFoldDirectory
    ? findAffectedTextFiles(path.resolve(legacyFoldDirectory))
    : [];

  const report = {
    apply,
    storageRoot,
    cards: cards.map(({ cardType, periodKey, filePath, before, after }) => ({
      cardType,
      periodKey,
      filePath,
      removedChars: before.length - after.length,
    })),
    jsonlCards: jsonlCards.map(({ card }) => ({
      cardType: card.cardType,
      periodKey: card.period.key,
      baseCardId: card.id,
      nextVersion: Number(card.version) + 1,
    })),
    folds: folds.map(({ filePath, before, after }) => ({
      filePath,
      removedChars: before.length - after.length,
    })),
    legacyFolds: legacyFolds.map(({ filePath, before, after }) => ({
      filePath,
      removedChars: before.length - after.length,
    })),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!apply) return;

  applyDerivedFileRepairs({
    files: folds,
    managedDirectory: foldsDirectory,
    revisionRoot,
    revisionJournal,
    layer: 'fold',
    policy,
  });
  if (legacyFolds.length) {
    const legacyRoot = path.resolve(legacyFoldDirectory);
    applyDerivedFileRepairs({
      files: legacyFolds,
      managedDirectory: legacyRoot,
      revisionRoot: path.join(legacyRoot, '.revisions'),
      revisionJournal: path.join(legacyRoot, '.revisions', 'file-revisions.jsonl'),
      layer: 'legacy-fold',
      policy,
    });
  }
  for (const card of cards) {
    writeCardMarkdown({
      directory: cardsDirectory,
      memoryPolicy: policy,
      card: {
        cardType: card.cardType,
        period: { key: card.periodKey },
        content: card.after,
      },
      actor: 'system:control-plane-repair',
      reason: 'control-plane-contamination-repair',
    });
  }
  const store = new MemoryCardStore({
    directory: cardsDirectory,
    foldLogDir: foldsDirectory,
    memoryPolicy: policy,
    log: () => {},
  });
  for (const { card, content } of jsonlCards) {
    store.recordCoverage({
      cardType: card.cardType,
      period: card.period,
      sourceIds: card.sourceIds,
      status: 'invalidated',
      cardId: card.id,
      reason: 'control-plane-contamination-repair',
    });
    const appended = store.appendCard({
      cardType: card.cardType,
      period: card.period,
      sourceIds: card.sourceIds,
      content,
      provenance: card.provenance,
      carryover: card.carryover,
      policy: card.policy,
    });
    if (!appended.duplicate) store.appendHubCandidate(appended.card);
  }
}

try { main(); } catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
