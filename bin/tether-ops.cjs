#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadTetherConfig } = require('../runtime/config-loader.cjs');
const { acquireInstanceLock } = require('../runtime/instance-lock.cjs');
const { createBackup, restoreBackup, verifyBackup } = require('../runtime/operations/backup.cjs');
const { evaluateRuntimeHealth, readRuntimeHealth } = require('../runtime/operations/health.cjs');
const {
  inspectStorageSchema,
  migrateStorageSchema,
} = require('../runtime/operations/storage-schema.cjs');

function durableModule(name) {
  const publicRuntimePath = path.join(__dirname, '..', 'runtime', 'durable', name);
  const canonicalSourcePath = path.join(__dirname, '..', name);
  return require(fs.existsSync(publicRuntimePath) ? publicRuntimePath : canonicalSourcePath);
}

const { DurableInbox } = durableModule('durable-inbox.js');

function usage() {
  return [
    'Usage:',
    '  tether-ops status [config.json]',
    '  tether-ops dead-letters [config.json]',
    '  tether-ops inspect <update-id> [config.json]',
    '  tether-ops requeue <update-id> [config.json]',
    '  tether-ops resume <update-id> [config.json]',
    '  tether-ops requeue-failed <update-id> [config.json]',
    '  tether-ops requeue-done <update-id> --confirm-redeliver [config.json]',
    '  tether-ops archive-orphan <update-id> --confirm-unrecoverable [config.json]',
    '  tether-ops migrate [config.json]',
    '  tether-ops backup <destination-directory> [config.json]',
    '  tether-ops verify-backup <backup-directory>',
    '  tether-ops restore <backup-directory> [config.json]',
    '',
    'Mutating commands acquire the runtime storage lock. Stop both the runtime',
    'and tether-supervisor first. Requeue records intent; the next runtime start',
    'performs replay through the ordinary durable and causal paths.',
  ].join('\n');
}

function configWithoutCredentials(configPath) {
  return loadTetherConfig(configPath, { resolveCredentials: false });
}

function inboxForConfig(config) {
  return new DurableInbox({
    filePath: path.join(config.storage.root, 'telegram-inbox.jsonl'),
    maxBytes: config.telegram?.durableInboxMaxBytes,
    maxAttempts: config.telegram?.maxAttempts,
    retryBaseMs: config.telegram?.retryBaseMs,
    retryMaxMs: config.telegram?.retryMaxMs,
    log: () => {},
  });
}

function withOfflineLock(config, operation) {
  const supervisorLock = acquireInstanceLock(
    path.join(config.storage.root, '.tether-supervisor.lock'),
  );
  let runtimeLock = null;
  try {
    runtimeLock = acquireInstanceLock(path.join(config.storage.root, '.tether-instance.lock'));
    return operation();
  } finally {
    try { runtimeLock?.release(); } finally { supervisorLock.release(); }
  }
}

function numericUpdateId(value) {
  const updateId = Number(value);
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('update-id must be a non-negative integer');
  return updateId;
}

function status(config) {
  let storage;
  try { storage = inspectStorageSchema(config.storage.root); } catch (error) {
    storage = { status: 'error', code: error.code || 'TETHER_STORAGE_INSPECTION_FAILED' };
  }
  const health = readRuntimeHealth(path.join(config.storage.root, 'runtime-health.json'));
  const healthDecision = evaluateRuntimeHealth(health, {
    now: Date.now(),
    spawnedAt: health.record?.startedAt
      ? new Date(health.record.startedAt).getTime()
      : Date.now(),
    readyTimeoutMs: config.supervision?.readyTimeoutMs,
    staleAfterMs: config.supervision?.heartbeatStaleMs,
  });
  let inbox;
  try { inbox = inboxForConfig(config).status(); } catch (error) {
    inbox = { status: 'unavailable', code: error.code || 'DURABLE_INBOX_UNREADABLE' };
  }
  return {
    storage: {
      status: storage.status,
      version: storage.version ?? null,
      currentVersion: storage.currentVersion ?? null,
      code: storage.code || null,
    },
    runtime: {
      status: health.status,
      decision: healthDecision,
      record: health.record || null,
    },
    telegramInbox: inbox,
  };
}

function runOpsCommand(argv = process.argv.slice(2)) {
  const command = String(argv[0] || '');
  const commands = new Set([
    'status',
    'dead-letters',
    'inspect',
    'requeue',
    'resume',
    'requeue-failed',
    'requeue-done',
    'archive-orphan',
    'migrate',
    'backup',
    'verify-backup',
    'restore',
  ]);
  if (!commands.has(command)) throw new Error(usage());
  if (command === 'verify-backup') {
    if (!argv[1]) throw new Error(usage());
    const verified = verifyBackup(argv[1]);
    return {
      passed: verified.passed,
      rootSha256: verified.manifest.rootSha256,
      files: verified.manifest.files.length,
      createdAt: verified.manifest.createdAt,
    };
  }
  const idCommand = [
    'inspect', 'requeue', 'resume', 'requeue-failed', 'requeue-done', 'archive-orphan',
  ].includes(command);
  if (idCommand && argv[1] == null) throw new Error(usage());
  if (command === 'archive-orphan' && argv[2] !== '--confirm-unrecoverable') throw new Error(usage());
  if (command === 'requeue-done' && argv[2] !== '--confirm-redeliver') throw new Error(usage());
  if (['backup', 'restore'].includes(command) && !argv[1]) throw new Error(usage());
  let configPath = './config.json';
  if (['status', 'dead-letters', 'migrate'].includes(command)) configPath = argv[1] || configPath;
  else if (['archive-orphan', 'requeue-done'].includes(command)) configPath = argv[3] || configPath;
  else if (idCommand || ['backup', 'restore'].includes(command)) configPath = argv[2] || configPath;
  const config = configWithoutCredentials(configPath);

  if (command === 'status') return status(config);
  if (command === 'dead-letters') {
    return inboxForConfig(config).inventory({ states: ['dead-letter', 'operator-paused'] });
  }
  if (command === 'inspect') {
    const entry = inboxForConfig(config).inspect(numericUpdateId(argv[1]));
    if (!entry) throw new Error(`Unknown Telegram update: ${argv[1]}`);
    return entry;
  }
  if (command === 'migrate') {
    return withOfflineLock(config, () => migrateStorageSchema(config.storage.root, {
      agentId: config.agent.id,
    }));
  }
  if (command === 'backup') {
    return withOfflineLock(config, () => {
      const result = createBackup({
        storageRoot: config.storage.root,
        destinationRoot: argv[1],
        agentId: config.agent.id,
      });
      return {
        backupPath: result.backupPath,
        rootSha256: result.manifest.rootSha256,
        files: result.manifest.files.length,
        createdAt: result.manifest.createdAt,
      };
    });
  }
  if (command === 'restore') {
    return withOfflineLock(config, () => restoreBackup({
      backupPath: argv[1],
      storageRoot: config.storage.root,
      agentId: config.agent.id,
    }));
  }
  const updateId = numericUpdateId(argv[1]);
  return withOfflineLock(config, () => {
    const inbox = inboxForConfig(config);
    if (command === 'requeue') return inbox.requeueDeadLetter(updateId, 'operator-cli-requeue');
    if (command === 'resume') return inbox.requeueOperatorPaused(updateId, 'operator-cli-resume');
    if (command === 'requeue-failed') return inbox.requeueFailed(updateId, 'operator-cli-requeue-failed');
    if (command === 'requeue-done') return inbox.requeueDone(updateId, 'operator-confirmed-redelivery');
    return inbox.archiveUnrecoverableOrphan(updateId, 'operator-confirmed-original-unrecoverable');
  });
}

function main() {
  const result = runOpsCommand();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.code || 'TETHER_OPS_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  configWithoutCredentials,
  inboxForConfig,
  runOpsCommand,
  status,
  usage,
  withOfflineLock,
};
