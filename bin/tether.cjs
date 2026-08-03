#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadTetherConfig } = require('../runtime/config-loader.cjs');
const { LayeredMemory } = require('../runtime/memory/layered-memory.cjs');
const {
  MemoryMaintenanceSupervisor,
} = require('../runtime/memory/maintenance-supervisor.cjs');
const { acquireInstanceLock } = require('../runtime/instance-lock.cjs');
const { SelfsameSession } = require('../runtime/selfsame-session.cjs');
const { TetherRuntime } = require('../runtime/tether-runtime.cjs');
const { createTerminalChannel } = require('../runtime/channels/terminal.cjs');
const {
  createFileOffsetStore,
  createDurableUpdateHandler,
  createTelegramApi,
  createTelegramChannel,
} = require('../runtime/channels/telegram.cjs');
const { createOpenAICompatibleProvider } = require('../runtime/providers/openai-compatible.cjs');

function durableModule(name) {
  const publicRuntimePath = path.join(__dirname, '..', 'runtime', 'durable', name);
  const canonicalSourcePath = path.join(__dirname, '..', name);
  return require(fs.existsSync(publicRuntimePath) ? publicRuntimePath : canonicalSourcePath);
}

const { DurableInbox } = durableModule('durable-inbox.js');
const { createDurableDispatcher } = durableModule('durable-dispatcher.js');

let instanceLock = null;
let memoryRuntime = null;
let maintenanceSupervisor = null;
let telegramChannel = null;
let telegramDispatcher = null;
let terminalInterface = null;
let resourcesReleased = false;

function diagnosticCode(error) {
  switch (error?.code) {
    case 'TETHER_SESSION_CONTINUITY': return 'TETHER_SESSION_CONTINUITY';
    case 'TETHER_INSTANCE_LOCKED': return 'TETHER_INSTANCE_LOCKED';
    case 'TETHER_INSTANCE_LOCK_CORRUPT': return 'TETHER_INSTANCE_LOCK_CORRUPT';
    case 'TETHER_CAUSAL_CORRUPT': return 'TETHER_CAUSAL_CORRUPT';
    case 'TETHER_INFERENCE_AMBIGUOUS': return 'TETHER_INFERENCE_AMBIGUOUS';
    case 'TETHER_DELIVERY_AMBIGUOUS': return 'TETHER_DELIVERY_AMBIGUOUS';
    default: return 'TETHER_UNEXPECTED_FAILURE';
  }
}

function reportFailure(scope, error) {
  const label = scope === 'telegram' ? 'telegram channel' : 'startup';
  console.error(`[tether] ${label} failed (${diagnosticCode(error)})`);
}

function releaseResources() {
  if (resourcesReleased) return;
  resourcesReleased = true;
  try { maintenanceSupervisor?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { telegramChannel?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { telegramDispatcher?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { terminalInterface?.close(); } catch (_) { /* shutdown is best effort */ }
  try { memoryRuntime?.close(); } catch (_) { /* shutdown is best effort */ }
  try { instanceLock?.release(); } catch (_) { /* process shutdown is best effort */ }
  maintenanceSupervisor = null;
  telegramChannel = null;
  telegramDispatcher = null;
  terminalInterface = null;
  memoryRuntime = null;
  instanceLock = null;
}

async function main() {
  const configPath = process.argv[2] || './config.json';
  const config = loadTetherConfig(configPath);
  instanceLock = acquireInstanceLock(path.join(config.storage.root, '.tether-instance.lock'));
  process.once('exit', releaseResources);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      releaseResources();
      process.exit(0);
    });
  }
  const providers = config.providers
    .filter((provider) => provider.adapter === 'openai-compatible')
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      foldModel: provider.foldModel,
      memoryModel: provider.memoryModel,
      semanticExtractorModel: provider.semanticExtractorModel,
      semanticVerifierModel: provider.semanticVerifierModel,
      semanticHighRiskModel: provider.semanticHighRiskModel,
      embeddingsUrl: provider.embeddingsUrl,
      embeddingModel: provider.embeddingModel,
      embeddingDimensions: provider.embeddingDimensions,
      embeddingTimeoutMs: provider.embeddingTimeoutMs,
      maxTokens: provider.maxTokens,
      foldMaxTokens: provider.foldMaxTokens,
      memoryMaxTokens: provider.memoryMaxTokens,
      semanticExtractorMaxTokens: provider.semanticExtractorMaxTokens,
      semanticVerifierMaxTokens: provider.semanticVerifierMaxTokens,
      semanticHighRiskMaxTokens: provider.semanticHighRiskMaxTokens,
      headers: provider.headers,
      timeoutMs: provider.timeoutMs,
    }));
  const provider = createOpenAICompatibleProvider({ providers });
  const memory = new LayeredMemory({
    directory: path.join(config.storage.root, 'memory'),
    provider,
    agent: config.agent,
    owner: config.owner,
    entities: config.entities,
    addressPolicy: config.addressPolicy,
    memory: config.memory,
  });
  memoryRuntime = memory;
  const session = new SelfsameSession({
    stateFile: path.join(config.storage.root, 'session.json'),
    agentId: config.agent.id,
    createSession: async () => crypto.randomUUID(),
    resumeSession: async (sessionId, stored) => memory.verifySession(sessionId, {
      expectedProof: stored.memoryProof || null,
    }).passed,
    canCreateSession: async () => !memory.hasExistingAuthority(),
  });
  // Bootstrap once at the process boundary.  Channels never race to decide
  // whether they are allowed to create the primary session.
  await session.open({ allowCreate: config.runtime?.allowInitialSessionCreate === true });
  maintenanceSupervisor = new MemoryMaintenanceSupervisor({
    memory,
    idleIntervalMs: config.runtime?.maintenanceIntervalMs,
    activeDelayMs: config.runtime?.maintenanceActiveDelayMs,
    errorBaseDelayMs: config.runtime?.maintenanceErrorBaseDelayMs,
    errorMaxDelayMs: config.runtime?.maintenanceErrorMaxDelayMs,
  });
  maintenanceSupervisor.start();
  const terminal = createTerminalChannel();
  const runtime = new TetherRuntime({
    session,
    memory,
    provider,
    maintenanceSupervisor,
    personaPrompt: config.persona.prompt,
    rawTailMessages: config.runtime?.rawTailMessages,
    summaryLimit: config.runtime?.summaryLimit,
    cardLimit: config.runtime?.cardLimit,
  }).attach(terminal);
  if (config.telegram?.enabled === true) {
    const token = process.env[config.telegram.tokenEnv || 'TELEGRAM_BOT_TOKEN'];
    if (!token) throw new Error(`Missing Telegram token env: ${config.telegram.tokenEnv || 'TELEGRAM_BOT_TOKEN'}`);
    const telegram = createTelegramChannel({
      api: createTelegramApi({ token }),
      ownerIds: config.owner.telegramUserIds || [],
      allowedGroupIds: Object.keys(config.telegram.allowedGroups || {}),
      noReplyGroupIds: config.telegram.noReplyGroupIds || [],
      rateLimitedGroupIds: config.telegram.rateLimitedGroupIds || [],
      rateLimitStateDir: config.telegram.rateLimitStateDir || null,
      offsetStore: createFileOffsetStore(path.join(config.storage.root, 'telegram-offset.txt')),
      pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
      pollRetryDelayMs: config.telegram.pollRetryDelayMs,
    });
    telegramChannel = telegram;
    runtime.attach(telegram);
    const durableInbox = new DurableInbox({
      filePath: path.join(config.storage.root, 'telegram-inbox.jsonl'),
      maxBytes: config.telegram.durableInboxMaxBytes,
      maxAttempts: config.telegram.maxAttempts,
      retryBaseMs: config.telegram.retryBaseMs,
      retryMaxMs: config.telegram.retryMaxMs,
    });
    const dispatcher = createDurableDispatcher({
      inbox: durableInbox,
      dispatchUpdate: (update) => telegram.ingestUpdate(update),
      dispatchGroupBatch: async (record) => {
        for (const updateId of record.updateIds || []) {
          const update = durableInbox.getState(updateId)?.update;
          if (update) await telegram.ingestUpdate(update);
        }
      },
      notifyDeadLetter: async (record) => {
        console.error(`[tether] Telegram update entered dead-letter: ${record.updateId}`);
      },
      retryIntervalMs: config.telegram.retryIntervalMs,
    });
    telegramDispatcher = dispatcher;
    telegram.onUpdate(createDurableUpdateHandler({
      channel: telegram,
      inbox: durableInbox,
      dispatcher,
    }));
    await dispatcher.replayAll();
    dispatcher.start();
    telegram.start().catch((error) => {
      reportFailure('telegram', error);
      process.exitCode = 1;
    });
  }
  terminalInterface = terminal.start();
}

main().catch((error) => {
  releaseResources();
  reportFailure('startup', error);
  process.exitCode = 1;
});
