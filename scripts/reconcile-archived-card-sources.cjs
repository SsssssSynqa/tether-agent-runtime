#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { sanitizeDerivedMemoryText } = require('../runtime/memory/control-plane-boundary.js');
const { MemoryCardStore } = require('../runtime/memory/memory-card-store.js');
const { normalizeMemoryPolicy } = require('../runtime/memory/memory-policy.js');
const { collectMemorySources } = require('../runtime/memory/memory-sources.js');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function usage() {
  return 'Usage: node scripts/reconcile-archived-card-sources.cjs '
    + '--config /absolute/config.json [--apply]';
}

function memoryPolicyFromConfig(config) {
  return normalizeMemoryPolicy({
    agent: {
      entityId: config.agent?.id,
      displayName: config.agent?.displayName,
    },
    owner: {
      entityId: config.owner?.entityId,
      displayName: config.owner?.displayName,
      disallowedDisplayNames: config.addressPolicy?.disallowedOwnerNames || [],
      semanticDisallowedDisplayNames: config.addressPolicy?.semanticDisallowedOwnerNames
        || config.addressPolicy?.disallowedOwnerNames
        || [],
      namingSubjects: config.memory?.namingSubjects || [],
    },
    sourceLabels: config.memory?.sourceLabels || {},
    time: config.memory?.time || {},
    files: config.memory?.files || {},
    records: config.memory?.records || {},
    actors: config.memory?.actors || {},
  });
}

function main() {
  const configArgument = argument('--config');
  if (!configArgument) throw new Error(usage());
  const configPath = path.resolve(configArgument);
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) throw new Error(usage());

  const apply = process.argv.includes('--apply');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const storageRoot = path.resolve(config.storage?.root || '');
  if (!config.storage?.root) throw new Error('config.storage.root is required');
  const memoryDirectory = path.join(storageRoot, 'memory');
  const cardsDirectory = path.join(memoryDirectory, 'cards');
  const policy = memoryPolicyFromConfig(config);
  const history = JSON.parse(fs.readFileSync(path.join(memoryDirectory, 'history.json'), 'utf8'));
  const sources = collectMemorySources({
    foldLogDir: path.join(memoryDirectory, policy.files.foldDirectory),
    summaryHistory: history.summaryHistory || [],
    rounds: history.rounds || [],
    memoryPolicy: policy,
    sanitizeSummary: sanitizeDerivedMemoryText,
  });
  const activeSourceIds = new Set(sources.map((source) => source.id));
  const store = new MemoryCardStore({
    directory: cardsDirectory,
    foldLogDir: path.join(memoryDirectory, policy.files.foldDirectory),
    memoryPolicy: policy,
    log: () => {},
  });
  const existing = new Set(store.archivedSourceIds());
  const evidence = new Map();
  for (const card of store.cards()) {
    for (const sourceId of card.sourceIds || []) {
      if (
        !String(sourceId).startsWith('memory-source:')
        || activeSourceIds.has(sourceId)
        || existing.has(sourceId)
      ) continue;
      if (!evidence.has(sourceId)) evidence.set(sourceId, []);
      evidence.get(sourceId).push(card.id);
    }
  }
  const actions = [...evidence.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, cardIds]) => ({
      sourceId,
      cardIds: [...new Set(cardIds)].sort(),
    }));

  if (apply) {
    for (const action of actions) {
      store.recordArchivedSourceEvidence({
        sourceId: action.sourceId,
        cardIds: action.cardIds,
        actor: 'system:source-archive-reconciliation',
        reason: 'append-only-card-proves-prior-source-existence',
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    storageRoot,
    activeSourceCount: activeSourceIds.size,
    existingArchivedEvidenceCount: existing.size,
    actionCount: actions.length,
    actions,
  }, null, 2)}\n`);
}

main();
