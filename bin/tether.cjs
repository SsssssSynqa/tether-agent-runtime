#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { installLogTimestamps } = require('../runtime/bridge/log-stamp.js');
const { loadTetherConfig } = require('../runtime/config-loader.cjs');

if (require.main === module) installLogTimestamps();
const { LayeredMemory } = require('../runtime/memory/layered-memory.cjs');
const {
  createExternalRecallAdapter,
} = require('../runtime/memory/external-recall-adapter.cjs');
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
  createOwnerNotifier,
  createTelegramApi,
  createTelegramChannel,
  dropTelegramBacklog,
} = require('../runtime/channels/telegram.cjs');
const {
  createTelegramGroupCoordinator,
} = require('../runtime/channels/telegram-group.cjs');
const { createOpenAICompatibleProvider } = require('../runtime/providers/openai-compatible.cjs');
const { ProviderCircuitBreaker } = require('../runtime/providers/provider-circuit-breaker.cjs');
const { toRuntimeProviders } = require('../runtime/providers/runtime-provider-config.cjs');
const { createWorkspaceToolRuntime } = require('../runtime/tools/workspace-tools.cjs');
const { RuntimeHealthReporter } = require('../runtime/operations/health.cjs');
const { ensureRuntimeStorageSchema } = require('../runtime/operations/storage-schema.cjs');

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
let telegramGroupCoordinator = null;
let terminalInterface = null;
let healthReporter = null;
let resourcesReleased = false;
let providerCircuitNotifier = null;

function diagnosticCode(error) {
  switch (error?.code) {
    case 'TETHER_SESSION_CONTINUITY': return 'TETHER_SESSION_CONTINUITY';
    case 'TETHER_INSTANCE_LOCKED': return 'TETHER_INSTANCE_LOCKED';
    case 'TETHER_INSTANCE_LOCK_CORRUPT': return 'TETHER_INSTANCE_LOCK_CORRUPT';
    case 'TETHER_CAUSAL_CORRUPT': return 'TETHER_CAUSAL_CORRUPT';
    case 'TETHER_INFERENCE_AMBIGUOUS': return 'TETHER_INFERENCE_AMBIGUOUS';
    case 'TETHER_TOOL_INFERENCE_AMBIGUOUS': return 'TETHER_TOOL_INFERENCE_AMBIGUOUS';
    case 'TETHER_TOOL_APPROVAL_REQUIRED': return 'TETHER_TOOL_APPROVAL_REQUIRED';
    case 'TETHER_TOOL_EFFECT_AMBIGUOUS': return 'TETHER_TOOL_EFFECT_AMBIGUOUS';
    case 'TETHER_STORAGE_MIGRATION_REQUIRED': return 'TETHER_STORAGE_MIGRATION_REQUIRED';
    case 'TETHER_STORAGE_SCHEMA_CORRUPT': return 'TETHER_STORAGE_SCHEMA_CORRUPT';
    case 'TETHER_STORAGE_AGENT_MISMATCH': return 'TETHER_STORAGE_AGENT_MISMATCH';
    case 'TETHER_STORAGE_VERSION_NEWER': return 'TETHER_STORAGE_VERSION_NEWER';
    case 'TETHER_DELIVERY_AMBIGUOUS': return 'TETHER_DELIVERY_AMBIGUOUS';
    default: return 'TETHER_UNEXPECTED_FAILURE';
  }
}

function reportFailure(scope, error) {
  const label = scope === 'telegram' ? 'telegram channel' : 'startup';
  console.error(`[tether] ${label} failed (${diagnosticCode(error)})`);
  // 分类码只够分诊，不够确诊：TETHER_UNEXPECTED_FAILURE 是 default 兜底，
  // 2026-08-21 一天 5 次 fatal 没有一条留下原因，只能盲修。
  // message + stack 是病历本体，必须落日志。
  if (error) {
    console.error(`[tether] ${label} cause: ${error.message || error}`);
    if (error.stack) console.error(error.stack);
  }
}

// Resolves the image transcriber's credential from the environment, the same
// rule provider credentials follow: the key never sits in the config file.
function resolveTelegramVision(raw) {
  if (!raw || raw.enabled === false) return null;
  const apiKey = process.env[raw.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing Telegram vision credential env: ${raw.apiKeyEnv}`);
  return {
    model: raw.model,
    baseUrl: raw.baseUrl,
    apiKey,
    timeoutMs: raw.timeoutMs,
    maxImages: raw.maxImages,
    maxTokens: raw.maxTokens,
  };
}

function releaseResources() {
  if (resourcesReleased) return;
  resourcesReleased = true;
  try { maintenanceSupervisor?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { telegramChannel?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { telegramDispatcher?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { telegramGroupCoordinator?.stop(); } catch (_) { /* shutdown is best effort */ }
  try { terminalInterface?.close(); } catch (_) { /* shutdown is best effort */ }
  try { memoryRuntime?.close(); } catch (_) { /* shutdown is best effort */ }
  try { healthReporter?.stop(); } catch (_) { /* process shutdown is best effort */ }
  try { instanceLock?.release(); } catch (_) { /* process shutdown is best effort */ }
  maintenanceSupervisor = null;
  telegramChannel = null;
  telegramDispatcher = null;
  telegramGroupCoordinator = null;
  terminalInterface = null;
  memoryRuntime = null;
  healthReporter = null;
  instanceLock = null;
}

async function main() {
  const configPath = process.argv[2] || './config.json';
  const config = loadTetherConfig(configPath);
  instanceLock = acquireInstanceLock(path.join(config.storage.root, '.tether-instance.lock'));
  const storageSchema = ensureRuntimeStorageSchema(config.storage.root, {
    agentId: config.agent.id,
  });
  healthReporter = new RuntimeHealthReporter({
    filePath: path.join(config.storage.root, 'runtime-health.json'),
    intervalMs: config.supervision?.heartbeatIntervalMs,
    onWriteError(error) {
      console.error(`[tether] health heartbeat failed (${error.code || 'TETHER_HEALTH_WRITE_FAILED'})`);
      process.exitCode = 1;
      setImmediate(() => {
        releaseResources();
        process.exit(1);
      });
    },
  });
  healthReporter.start({
    agentId: config.agent.id,
    storageSchemaVersion: storageSchema.version,
  });
  process.once('exit', releaseResources);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      releaseResources();
      process.exit(0);
    });
  }
  const providers = toRuntimeProviders(config.providers);
  const toolRuntime = createWorkspaceToolRuntime({
    config,
    storageRoot: config.storage.root,
  });
  const providerCircuit = new ProviderCircuitBreaker({
    filePath: path.join(config.storage.root, 'provider-circuit.json'),
    threshold: config.runtime?.providerCircuitThreshold,
    onOpen: async (state) => providerCircuitNotifier?.(
      `[bridge-status] Provider circuit opened after ${state.threshold} distinct failed requests. `
      + 'New messages will still be received and preserved, but replies are manually paused. '
      + 'Stop runtime + supervisor, run `tether-ops circuit-clear <config>`, then explicitly resume selected updates; nothing replays automatically.',
    ),
  });
  const provider = providerCircuit.wrap(
    createOpenAICompatibleProvider({ providers, toolRuntime }),
  );
  const externalRecall = createExternalRecallAdapter({ config: config.externalRecall });
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
  const sessionState = await session.open({
    allowCreate: config.runtime?.allowInitialSessionCreate === true,
  });
  maintenanceSupervisor = new MemoryMaintenanceSupervisor({
    memory,
    idleIntervalMs: config.runtime?.maintenanceIntervalMs,
    activeDelayMs: config.runtime?.maintenanceActiveDelayMs,
    errorBaseDelayMs: config.runtime?.maintenanceErrorBaseDelayMs,
    errorMaxDelayMs: config.runtime?.maintenanceErrorMaxDelayMs,
    onState: (record) => healthReporter?.noteMaintenance(record),
  });
  maintenanceSupervisor.start();
  const terminal = createTerminalChannel();
  const runtime = new TetherRuntime({
    session,
    memory,
    provider,
    maintenanceSupervisor,
    healthReporter,
    externalRecall,
    personaPrompt: config.persona.prompt,
    rawTailMessages: config.runtime?.rawTailMessages,
    summaryLimit: config.runtime?.summaryLimit,
    cardLimit: config.runtime?.cardLimit,
  }).attach(terminal);
  if (config.telegram?.enabled === true) {
    const token = process.env[config.telegram.tokenEnv || 'TELEGRAM_BOT_TOKEN'];
    if (!token) throw new Error(`Missing Telegram token env: ${config.telegram.tokenEnv || 'TELEGRAM_BOT_TOKEN'}`);
    // Polling failures and polling stalls both end the process here so the
    // supervisor restarts a runtime that can no longer receive messages.
    const failTelegram = (error) => {
      healthReporter?.fatal(error);
      reportFailure('telegram', error);
      releaseResources();
      process.exit(1);
    };
    const telegramApi = createTelegramApi({ token, apiBase: config.telegram.apiBase });
    const telegramOffsetPath = path.join(config.storage.root, 'telegram-offset.txt');
    const telegramOffsetStore = createFileOffsetStore(telegramOffsetPath);
    const visionConfig = resolveTelegramVision(config.telegram.vision);
    const telegram = createTelegramChannel({
      api: telegramApi,
      ownerIds: config.owner.telegramUserIds || [],
      allowedGroups: config.telegram.allowedGroups || {},
      noReplyGroupIds: config.telegram.noReplyGroupIds || [],
      rateLimitedGroupIds: config.telegram.rateLimitedGroupIds || [],
      rateLimitStateDir: config.telegram.rateLimitStateDir || null,
      attachmentDirectory: config.telegram.attachmentDirectory
        || path.join(config.storage.root, 'telegram-attachments'),
      maxImageBytes: config.telegram.maxImageBytes,
      maxFileBytes: config.telegram.maxFileBytes,
      maxFilePreviewChars: config.telegram.maxFilePreviewChars,
      maxQuotedChars: config.telegram.maxQuotedChars,
      groupMaxReplies: config.telegram.groupMaxReplies,
      groupAllowedReactions: config.telegram.groupAllowedReactions,
      groupRepairAttempts: config.telegram.groupRepairAttempts,
      offsetStore: telegramOffsetStore,
      vision: visionConfig,
      outboundSecrets: [
        token,
        visionConfig?.apiKey,
        ...providers.map((provider) => provider.apiKey),
      ].filter(Boolean),
      pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
      pollRetryDelayMs: config.telegram.pollRetryDelayMs,
      pollMaxConsecutiveFailures: config.telegram.pollMaxConsecutiveFailures,
      pollFailureGiveUpMs: config.telegram.pollFailureGiveUpMs,
      pollStallTimeoutMs: config.telegram.pollStallTimeoutMs,
      onPollFatal: failTelegram,
      typingHeartbeatMs: config.telegram.typingHeartbeatMs,
      groupOwnerMessagesPerMinute: config.telegram.groupOwnerMessagesPerMinute,
      groupBotMessagesPerMinute: config.telegram.groupBotMessagesPerMinute,
      groupUserMessagesPerMinute: config.telegram.groupUserMessagesPerMinute,
    });
    telegramChannel = telegram;
    runtime.attach(telegram);
    await telegram.initialize();
    const notifyOwner = createOwnerNotifier({
      api: telegramApi,
      ownerIds: config.owner.telegramUserIds || [],
    });
    providerCircuitNotifier = notifyOwner;
    // Green-field only: an existing offset file means an established deployment,
    // whose downtime backlog must replay rather than vanish.
    if (config.telegram.dropBacklogOnFirstRun !== false && !fs.existsSync(telegramOffsetPath)) {
      const { dropped } = await dropTelegramBacklog({ api: telegramApi, offsetStore: telegramOffsetStore });
      if (dropped > 0) {
        await notifyOwner(
          `[bridge-status] First run: ${dropped} backlogged Telegram updates were discarded; `
          + 'messages from now on are handled normally.',
        );
      }
    }
    const durableInbox = new DurableInbox({
      filePath: path.join(config.storage.root, 'telegram-inbox.jsonl'),
      maxBytes: config.telegram.durableInboxMaxBytes,
      maxAttempts: config.telegram.maxAttempts,
      retryBaseMs: config.telegram.retryBaseMs,
      retryMaxMs: config.telegram.retryMaxMs,
    });
    let groupCoordinator = null;
    const dispatcher = createDurableDispatcher({
      inbox: durableInbox,
      dispatchUpdate: (update) => telegram.ingestUpdate(update),
      dispatchGroupBatch: (record) => groupCoordinator.dispatchExactBatch(record),
      dispatchGroupRun: (entries) => groupCoordinator.dispatchRun(entries),
      notifyDeadLetter: async (record) => {
        console.error(`[tether] Telegram update entered dead-letter: ${record.updateId}`);
        await notifyOwner(
          `[bridge-status] Telegram update ${record.updateId} entered dead-letter after `
          + `${record.attempts} attempts and will not retry on its own. Last error: ${record.error}`,
        );
      },
      retryIntervalMs: config.telegram.retryIntervalMs,
    });
    groupCoordinator = createTelegramGroupCoordinator({
      channel: telegram,
      inbox: durableInbox,
      timing: config.telegram.groupBatchTiming,
      maxPendingMessages: config.telegram.groupMaxPendingMessages,
      maxReplies: config.telegram.groupMaxReplies,
      allowedReactions: config.telegram.groupAllowedReactions,
      notifyFailure: async (chatId, error, batch) => {
        const title = batch?.at(-1)?.metadata?.chatTitle || chatId;
        await notifyOwner(
          `[bridge-status] A group reply batch in "${title}" failed and paused: ${error.message}`,
        );
      },
    });
    telegramGroupCoordinator = groupCoordinator;
    telegramDispatcher = dispatcher;
    telegram.onUpdate(createDurableUpdateHandler({
      channel: telegram,
      inbox: durableInbox,
      dispatcher,
      groupCoordinator,
      turnFailureNotice: config.telegram.turnFailureNotice === false
        ? null
        : (config.telegram.turnFailureNotice
          || '[bridge-status] That turn hit an error; it stays queued and retries automatically.'),
      api: telegramApi,
    }));
    await dispatcher.replayAll();
    dispatcher.start();
    telegram.start().catch(failTelegram);
    if (config.telegram.startupNotice === true) {
      await notifyOwner(`[bridge-status] ${config.agent.displayName} bridge runtime started.`);
    }
  }
  terminalInterface = terminal.start();
  healthReporter.ready({ sessionId: sessionState.sessionId });
  const groupCount = Object.keys(config.telegram?.allowedGroups || {}).length;
  console.log(
    `[tether] runtime ready | agent=${config.agent.id} | telegram=${config.telegram?.enabled === true ? `on (${groupCount} groups)` : 'off'}`
    + ` | providers=${providers.map((provider) => provider.id).join(',') || 'none'}`
    + ` | storage=${config.storage.root}`,
  );
}

main().catch((error) => {
  healthReporter?.fatal(error);
  releaseResources();
  reportFailure('startup', error);
  process.exitCode = 1;
});
