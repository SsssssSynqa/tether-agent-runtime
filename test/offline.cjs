// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadSharedMemoryModule(filename) {
  const sourcePath = path.join(__dirname, '..', filename);
  return require(fs.existsSync(sourcePath)
    ? sourcePath
    : path.join(__dirname, '..', 'runtime', 'memory', filename));
}

function loadSourceOrExportModule(sourceFile, exportFile) {
  const sourcePath = path.join(__dirname, '..', sourceFile);
  return require(fs.existsSync(sourcePath)
    ? sourcePath
    : path.join(__dirname, '..', exportFile));
}

const { AppendOnlyMemory } = require('../runtime/memory/append-only-memory.cjs');
const {
  MemoryMaintenanceSupervisor,
  resultDidWork,
} = require('../runtime/memory/maintenance-supervisor.cjs');
const {
  SelfsameContinuityError,
  SelfsameSession,
  atomicWriteJson,
} = require('../runtime/selfsame-session.cjs');
const { TetherRuntime } = require('../runtime/tether-runtime.cjs');
const { createMemoryChannel } = require('../runtime/channels/memory-channel.cjs');
const { createOpenAICompatibleProvider } = require('../runtime/providers/openai-compatible.cjs');
const { ToolJournal, sha256: toolSha256 } = require('../runtime/tools/tool-journal.cjs');
const {
  canonicalJson,
  createWorkspaceToolRuntime,
} = require('../runtime/tools/workspace-tools.cjs');
const {
  createBackup,
  restoreBackup,
  verifyBackup,
} = require('../runtime/operations/backup.cjs');
const {
  RuntimeHealthReporter,
  evaluateRuntimeHealth,
  readRuntimeHealth,
} = require('../runtime/operations/health.cjs');
const {
  CURRENT_STORAGE_VERSION,
  ensureRuntimeStorageSchema,
  inspectStorageSchema,
  migrateStorageSchema,
} = require('../runtime/operations/storage-schema.cjs');
const {
  RestartBudget,
  TetherSupervisor,
  restartDelay,
} = require('../runtime/operations/supervisor.cjs');
const { validateMemoryBundle } = loadSharedMemoryModule('semantic-memory-validators.js');
const { SemanticMemoryStore } = loadSharedMemoryModule('semantic-memory-store.js');
const {
  VectorMemoryIndex,
  cosineSimilarity,
} = require('../runtime/memory/vector-memory.cjs');
const { LayeredMemory } = require('../runtime/memory/layered-memory.cjs');
const { DurableInbox } = loadSourceOrExportModule(
  'durable-inbox.js',
  'runtime/durable/durable-inbox.js',
);
const { createDurableDispatcher } = loadSourceOrExportModule(
  'durable-dispatcher.js',
  'runtime/durable/durable-dispatcher.js',
);
const { classifyDurableError } = loadSourceOrExportModule(
  'durable-error-policy.js',
  'runtime/durable/durable-error-policy.js',
);
const { sendWithGroupRateLimit } = require('../lib/telegram/group-rate-limit.cjs');
const {
  createFileOffsetStore,
  createDurableUpdateHandler,
  createTelegramApi,
  createTelegramChannel,
  normalizeTelegramUpdate,
  splitTelegramText,
  telegramRequestTimeoutMs,
} = require('../runtime/channels/telegram.cjs');
const {
  buildTelegramGroupBatch,
  createTelegramGroupCoordinator,
  parseTelegramGroupReplyEnvelope,
} = require('../runtime/channels/telegram-group.cjs');
const { loadTetherConfig, validateConfig } = require('../runtime/config-loader.cjs');
const {
  assertAttribution,
  entityForTelegramSender,
  normalizeIdentityPolicy,
  normalizeOwnerAddress,
} = require('../runtime/identity-policy.cjs');
const { CausalJournal } = require('../runtime/causal-journal.cjs');
const { acquireInstanceLock } = require('../runtime/instance-lock.cjs');
const { findStaleManagedPaths } = require('../scripts/export-public-snapshot.cjs');
const { verifyFileLock } = require('../scripts/verify-export-lock.cjs');
const {
  runMemoryCommand,
  usage: memoryCommandUsage,
} = require('../bin/tether-memory.cjs');
const { usage: toolsCommandUsage } = require('../bin/tether-tools.cjs');
const { runOpsCommand, usage: opsCommandUsage } = require('../bin/tether-ops.cjs');

const { normalizeCardUserAddress } = loadSharedMemoryModule('memory-card-address.js');
const { cardMarkdownPath } = loadSharedMemoryModule('memory-card-files.js');
const { MemoryCardManager } = loadSharedMemoryModule('memory-card-manager.js');
const { normalizeMemoryPolicy } = loadSharedMemoryModule('memory-policy.js');
const { roundSource } = loadSharedMemoryModule('memory-sources.js');
const { operationalDayKey } = loadSharedMemoryModule('memory-time.js');

function makeFlakyChannel(id) {
  let handler = null;
  let failuresRemaining = 1;
  const attempts = [];
  return {
    id,
    attempts,
    onMessage(next) { handler = next; },
    async send(message) {
      attempts.push(structuredClone(message));
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('synthetic delivery failure');
      }
    },
    receive(message) { return handler(structuredClone(message)); },
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-offline-'));
  try {
    const genericPolicy = normalizeMemoryPolicy({
      agent: { entityId: 'anchor', displayName: 'Anchor' },
      owner: {
        entityId: 'keeper',
        displayName: 'Keeper',
        disallowedDisplayNames: ['LegacyName'],
        namingSubjects: ['Keeper'],
      },
      sourceLabels: { input: 'Human', assistant: 'Anchor' },
      time: {
        timezoneOffsetMinutes: -5 * 60,
        cutoffHour: 4,
        forceHour: 10,
        quietMinutes: 30,
        displayLabel: 'UTC-05:00',
      },
      files: {
        dayDirectory: 'daily',
        weekDirectory: 'weekly',
        dayHeadingTemplate: '# {agent} daily · {period}',
        weekHeadingTemplate: '# {agent} weekly · {period} through {end}',
      },
    });
    assert.equal(
      operationalDayKey('2030-04-12T09:00:00.000Z', genericPolicy.time),
      '2030-04-12',
    );
    const genericSource = roundSource({
      ts: '2030-04-11T12:00:00.000Z',
      user: 'LegacyName requested durable memory.',
      assistant: 'I will preserve it.',
      causalIds: ['generic-memory-turn'],
      provenance: { trustZones: ['dm'], chatIds: ['test'], senderIds: ['keeper'] },
    }, 0, { memoryPolicy: genericPolicy });
    assert.match(genericSource.text, /Human：LegacyName requested/);
    assert.match(genericSource.text, /Anchor：I will preserve/);
    const genericAddress = normalizeCardUserAddress(
      'LegacyName requested durable memory.',
      { sources: [genericSource], memoryPolicy: genericPolicy },
    );
    assert.equal(genericAddress.text, 'Keeper requested durable memory.');
    const genericHistory = {
      getData: () => ({
        summaryHistory: [],
        rounds: [{
          ts: '2030-04-11T12:00:00.000Z',
          user: 'LegacyName requested durable memory.',
          assistant: 'I will preserve it.',
          causalIds: ['generic-memory-turn'],
          provenance: { trustZones: ['dm'], chatIds: ['test'], senderIds: ['keeper'] },
        }],
      }),
      knownMemorySourceIds: () => [],
    };
    const genericCards = new MemoryCardManager({
      history: genericHistory,
      directory: path.join(root, 'generic-cards'),
      memoryPolicy: genericPolicy,
      policy: 'lossless',
      now: () => '2030-04-12T16:00:00.000Z',
      generateCard: async () => 'Keeper requested durable memory.',
      log: () => {},
    });
    const genericMaintenance = await genericCards.maintainOne();
    assert.equal(genericMaintenance.status, 'generated');
    assert(fs.readFileSync(cardMarkdownPath(
      genericCards.store.directory,
      'day',
      '2030-04-11',
      genericPolicy,
    ), 'utf8').startsWith('# Anchor daily · 2030-04-11'));

    const publicRoot = path.join(__dirname, '..');
    const exampleConfigPath = fs.existsSync(path.join(publicRoot, 'config.example.json'))
      ? path.join(publicRoot, 'config.example.json')
      : path.join(publicRoot, 'public', 'config.example.json');
    const exampleConfig = loadTetherConfig(exampleConfigPath, {
      privateOverlayPath: path.join(root, 'missing-private-overlay.json'),
      env: { PRIMARY_API_KEY: 'synthetic-test-value' },
    });
    assert.equal(exampleConfig.agent.id, 'agent');
    assert.match(exampleConfig.persona.prompt, /same continuous agent/);
    assert.equal(exampleConfig.memory.semantic.mode, 'cards');
    assert.equal(exampleConfig.tools.enabled, true);
    assert.equal(exampleConfig.tools.workspaceRoots[0].id, 'workspace');
    assert.equal(path.isAbsolute(exampleConfig.tools.workspaceRoots[0].path), true);
    assert.match(toolsCommandUsage(), /tether-tools approve/);
    assert.match(opsCommandUsage(), /tether-ops backup/);
    assert.equal(exampleConfig.supervision.heartbeatStaleMs, 30000);
    assert.throws(
      () => validateConfig({
        ...exampleConfig,
        providers: [{
          id: 'bad', label: 'Bad', adapter: 'openai-compatible', model: 'm',
          baseUrl: 'file:///tmp/socket', apiKey: 'inline-forbidden',
        }],
      }),
      /apiKey is forbidden|http or https/,
    );
    assert.throws(
      () => loadTetherConfig(exampleConfigPath, {
        privateOverlayPath: path.join(root, 'missing-private-overlay.json'),
        env: {},
      }),
      /Missing required provider credential env/,
    );
    assert.doesNotThrow(() => loadTetherConfig(exampleConfigPath, {
      privateOverlayPath: path.join(root, 'missing-private-overlay.json'),
      env: {},
      resolveCredentials: false,
    }));
    const configEnvelope = {
      agent: { id: 'agent', displayName: 'Agent' },
      owner: { entityId: 'owner', displayName: 'Owner' },
      storage: { root: './data' },
    };
    const providerConfig = (overrides = {}) => ({
      id: 'provider',
      label: 'Provider',
      adapter: 'openai-compatible',
      model: 'model',
      baseUrl: 'https://example.invalid/v1/chat/completions',
      authentication: 'none',
      ...overrides,
    });
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        providers: [providerConfig({ headers: { Authorization: 'Bearer inline-secret' } })],
      }),
      /may contain credentials; use headerEnv/,
    );
    for (const headers of [
      { 'X-Goog-Api-Key': 'inline-secret' },
      { Cookie: 'session=inline-secret' },
    ]) {
      assert.throws(
        () => validateConfig({ ...configEnvelope, providers: [providerConfig({ headers })] }),
        /may contain credentials; use headerEnv/,
      );
    }
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        providers: [providerConfig({ baseUrl: 'https://user:password@example.invalid/v1' })],
      }),
      /must not contain username or password credentials/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        providers: [providerConfig({ baseUrl: 'https://example.invalid/v1?api_key=inline-secret' })],
      }),
      /credential query parameters/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        providers: [providerConfig({ baseUrl: 'https://example.invalid/v1?client_secret=inline-secret' })],
      }),
      /credential query parameters/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        providers: [providerConfig({ baseUrl: 'http://example.invalid/v1' })],
      }),
      /must use https unless the host is loopback/,
    );
    assert.doesNotThrow(() => validateConfig({
      ...configEnvelope,
      providers: [providerConfig({ baseUrl: 'http://127.0.0.1:11434/v1' })],
    }));
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        memory: { semantic: { mode: 'invented' } },
        providers: [providerConfig()],
      }),
      /memory.semantic.mode/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        telegram: { retryBaseMs: 2000, retryMaxMs: 1000 },
        providers: [providerConfig()],
      }),
      /telegram.retryMaxMs/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        telegram: { tokenEnv: 'not-an-env-name' },
        providers: [providerConfig()],
      }),
      /telegram.tokenEnv/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        telegram: { allowedGroups: { room: { mode: 'invented' } } },
        providers: [providerConfig()],
      }),
      /allowedGroups\.room\.mode/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        providers: [providerConfig({ imageInput: 'local-path' })],
      }),
      /imageInput/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        memory: { semantic: { embeddings: { enabled: true } } },
        providers: [providerConfig()],
      }),
      /requires an embedding provider/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        tools: { enabled: true, workspaceRoots: [] },
        providers: [providerConfig()],
      }),
      /requires at least one workspace root/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        tools: {
          enabled: true,
          workspaceRoots: [{ id: 'Bad Root', path: './workspace' }],
          policies: { telegramGroup: { write: 'always' } },
        },
        providers: [providerConfig()],
      }),
      /stable lowercase identifier|must be allow, approval, or deny/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        supervision: { heartbeatIntervalMs: 5000, heartbeatStaleMs: 5000 },
        providers: [providerConfig()],
      }),
      /heartbeatStaleMs must be at least/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        supervision: { heartbeatIntervalMs: 40_000 },
        providers: [providerConfig()],
      }),
      /heartbeatStaleMs must be at least/,
    );
    assert.throws(
      () => validateConfig({
        ...configEnvelope,
        supervision: { restartBaseMs: 2000, restartMaxMs: 1000 },
        providers: [providerConfig()],
      }),
      /restartMaxMs must not be smaller/,
    );
    const headerEnvConfigPath = path.join(root, 'header-env-config.json');
    fs.writeFileSync(headerEnvConfigPath, JSON.stringify({
      ...configEnvelope,
      persona: { inlinePolicy: 'Synthetic policy.' },
      providers: [providerConfig({ headerEnv: { 'X-Custom-Token': 'CUSTOM_PROVIDER_TOKEN' } })],
    }));
    const headerEnvConfig = loadTetherConfig(headerEnvConfigPath, {
      privateOverlayPath: path.join(root, 'missing-header-overlay.json'),
      env: { CUSTOM_PROVIDER_TOKEN: 'synthetic-header-value' },
    });
    assert.equal(headerEnvConfig.providers[0].headers['X-Custom-Token'], 'synthetic-header-value');

    const telegramFirstRoot = path.join(root, 'telegram-first');
    const telegramFirstMemory = new AppendOnlyMemory({ directory: path.join(telegramFirstRoot, 'memory') });
    let telegramFirstCreates = 0;
    const telegramFirstSession = new SelfsameSession({
      stateFile: path.join(telegramFirstRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => { telegramFirstCreates += 1; return 'telegram-first-session'; },
      resumeSession: async (sessionId, stored) => telegramFirstMemory.verifySession(sessionId, {
        expectedProof: stored.memoryProof || null,
      }).passed,
      canCreateSession: async () => !telegramFirstMemory.hasExistingAuthority(),
    });
    await telegramFirstSession.open({ allowCreate: true });
    const telegramFirst = createTelegramChannel({
      api: {
        async call() { return { ok: true, result: [] }; },
        async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
      },
      ownerIds: ['11'],
      offsetStore: createFileOffsetStore(path.join(telegramFirstRoot, 'offset.txt')),
      log: () => {},
    });
    new TetherRuntime({
      session: telegramFirstSession,
      memory: telegramFirstMemory,
      provider: { async respond() { return { text: 'telegram-first-ok', providerId: 'offline' }; } },
      log: () => {},
    }).attach(telegramFirst);
    const telegramFirstTurn = await telegramFirst.ingestUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        text: 'first input',
        from: { id: 11 },
        chat: { id: 12, type: 'private' },
      },
    });
    assert.equal(telegramFirstTurn.sessionId, 'telegram-first-session');
    assert.equal(telegramFirstCreates, 1, 'process bootstrap must create exactly once before Telegram input');

    const cacheMemory = new AppendOnlyMemory({ directory: path.join(root, 'cache-proof', 'memory') });
    const originalReadFileSync = fs.readFileSync;
    let postLoadReads = 0;
    fs.readFileSync = (...args) => {
      postLoadReads += 1;
      return originalReadFileSync(...args);
    };
    try {
      for (let index = 0; index < 64; index += 1) {
        cacheMemory.appendMessage({
          messageId: `cache:${index}`,
          sessionId: 'cache-session',
          channelId: 'cache-test',
          role: 'user',
          text: `message ${index}`,
        });
      }
      assert.equal(cacheMemory.sessionProof('cache-session').passed, true);
      assert.equal(cacheMemory.compileContext({ rawTailMessages: 5 }).rawTail.length, 5);
      assert.equal(cacheMemory.messages().length, 64);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.equal(postLoadReads, 0, 'append/checkpoint/compile must use the constructor cache, not reread JSONL');

    let creates = 0;
    let resumes = 0;
    let providerCalls = 0;
    let lastProviderMessages = [];
    const stateFile = path.join(root, 'session.json');
    const memory = new AppendOnlyMemory({ directory: path.join(root, 'memory') });
    const provider = {
      async respond({ messages }) {
        providerCalls += 1;
        lastProviderMessages = structuredClone(messages);
        const last = messages.filter((item) => item.role === 'user').at(-1);
        return { text: `echo:${last.content}`, providerId: 'offline' };
      },
    };
    const firstSession = new SelfsameSession({
      stateFile,
      agentId: 'agent',
      createSession: async () => { creates += 1; return 'session-one'; },
      resumeSession: async (sessionId) => {
        resumes += 1;
        return memory.verifySession(sessionId).passed;
      },
      canCreateSession: async () => !memory.hasExistingAuthority(),
    });
    await firstSession.open({ allowCreate: true });
    const terminal = createMemoryChannel('terminal');
    const runtime = new TetherRuntime({ session: firstSession, memory, provider, log: () => {} }).attach(terminal);
    const terminalInput = {
      messageId: 'terminal:synthetic-1',
      text: 'hello',
      metadata: { source: 'synthetic-terminal' },
    };
    const first = await terminal.receive(terminalInput);
    assert.equal(first.sessionId, 'session-one');
    assert.equal(creates, 1);
    assert.equal(providerCalls, 1);
    const checkpointAfterFirstTurn = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(checkpointAfterFirstTurn.memoryProof.schemaVersion, 1);
    assert.ok(checkpointAfterFirstTurn.memoryProof.transcriptBytes > 0);
    assert.equal(checkpointAfterFirstTurn.memoryProof.messageCount, 2);
    const firstOutputId = first.outputId;

    const exactDuplicate = await terminal.receive(terminalInput);
    assert.equal(exactDuplicate.outputId, firstOutputId);
    assert.equal(exactDuplicate.replayed, true);
    assert.equal(exactDuplicate.alreadyDelivered, true);
    assert.equal(providerCalls, 1, 'committed duplicate must not run inference');
    assert.equal(terminal.sent.length, 1, 'already-delivered duplicate must not send twice');
    await assert.rejects(
      terminal.receive({ ...terminalInput, metadata: { source: 'different-envelope' } }),
      (error) => error.code === 'TETHER_CAUSAL_MISMATCH',
    );

    const telegramDeliveries = [];
    const telegramChannel = createTelegramChannel({
      api: {
        async call() { return { ok: true, result: [] }; },
        async sendMessage(params) {
          telegramDeliveries.push(structuredClone(params));
          return { ok: true, result: { message_id: 100 } };
        },
      },
      ownerIds: ['11'],
      allowedGroupIds: [],
      noReplyGroupIds: [],
      rateLimitedGroupIds: [],
      offsetStore: createFileOffsetStore(path.join(root, 'telegram-offset.txt')),
      log: () => {},
    });
    runtime.attach(telegramChannel);
    const telegramTurn = await telegramChannel.ingestUpdate({
      update_id: 8,
      message: {
        message_id: 9,
        text: 'same process',
        from: { id: 11 },
        chat: { id: 12, type: 'private' },
      },
    });
    assert.equal(telegramTurn.sessionId, 'session-one');
    assert.equal(providerCalls, 2);
    assert.equal(telegramDeliveries.length, 1);
    assert.equal(memory.messages().at(-1).channelId, 'telegram');

    const editedUpdate = {
      update_id: 9,
      edited_message: {
        message_id: 9,
        text: 'same process, edited',
        from: { id: 11 },
        chat: { id: 12, type: 'private' },
      },
    };
    const editedTurn = await telegramChannel.ingestUpdate(editedUpdate);
    assert.equal(editedTurn.sessionId, 'session-one');
    assert.equal(providerCalls, 3, 'an edit is a distinct Telegram causal event');
    assert.equal(telegramDeliveries.length, 2);
    const exactEditReplay = await telegramChannel.ingestUpdate(editedUpdate);
    assert.equal(exactEditReplay.replayed, true);
    assert.equal(exactEditReplay.alreadyDelivered, true);
    assert.equal(providerCalls, 3, 'replaying the exact update_id must not infer twice');
    assert.equal(telegramDeliveries.length, 2, 'replaying the exact update_id must not deliver twice');
    const telegramInputs = memory.messages().filter((record) => (
      record.channelId === 'telegram' && record.role === 'user'
    ));
    assert.deepEqual(telegramInputs.map((record) => record.messageId), [
      'telegram:update:8',
      'telegram:update:9',
    ]);
    assert.deepEqual(telegramInputs.map((record) => record.metadata.updateKind), [
      'message',
      'edited_message',
    ]);

    const flaky = makeFlakyChannel('flaky');
    runtime.attach(flaky);
    const flakyInput = {
      messageId: 'flaky:synthetic-1',
      text: 'deliver exactly once after retry',
      metadata: { source: 'synthetic-flaky' },
    };
    await assert.rejects(flaky.receive(flakyInput), /synthetic delivery failure/);
    assert.equal(providerCalls, 4);
    const retry = await flaky.receive(flakyInput);
    assert.equal(retry.replayed, true);
    assert.equal(providerCalls, 4, 'delivery retry must replay committed output');
    assert.equal(flaky.attempts.length, 2);
    assert.equal(flaky.attempts[0].text, flaky.attempts[1].text);
    assert.equal(flaky.attempts[0].outputId, flaky.attempts[1].outputId);
    const deliveredDuplicate = await flaky.receive(flakyInput);
    assert.equal(deliveredDuplicate.alreadyDelivered, true);
    assert.equal(flaky.attempts.length, 2);

    const ambiguous = createMemoryChannel('ambiguous');
    runtime.attach(ambiguous);
    const ambiguousInput = {
      messageId: 'ambiguous:synthetic-1',
      text: 'do not infer twice',
      metadata: { source: 'synthetic-crash' },
    };
    const prepared = runtime.causal.prepareInput({
      sessionId: 'session-one',
      channelId: 'ambiguous',
      messageId: ambiguousInput.messageId,
      role: 'user',
      text: ambiguousInput.text,
      metadata: ambiguousInput.metadata,
    });
    runtime.causal.markInferenceStarted(prepared.causalId);
    await assert.rejects(
      ambiguous.receive(ambiguousInput),
      (error) => error.code === 'TETHER_INFERENCE_AMBIGUOUS',
    );
    assert.equal(providerCalls, 4);

    let contractHandler = null;
    let contractAttempts = 0;
    const contractDeliveries = [];
    const contractChannel = {
      id: 'contract-retry',
      onMessage(next) { contractHandler = next; },
      async send(message) { contractDeliveries.push(structuredClone(message)); },
      async prepareOutput({ result }) {
        contractAttempts += 1;
        if (contractAttempts === 1) {
          const error = new Error('synthetic response contract rejection');
          error.code = 'TETHER_RESPONSE_CONTRACT_INVALID';
          error.rejectedOutput = 'not-json';
          error.rejectedProviderId = result.providerId;
          throw error;
        }
        return result;
      },
      receive(message) { return contractHandler(structuredClone(message)); },
    };
    runtime.attach(contractChannel);
    const contractInput = {
      messageId: 'contract:synthetic-1',
      text: 'safe contract retry',
      metadata: { source: 'synthetic-contract' },
    };
    await assert.rejects(contractChannel.receive(contractInput), /response contract rejection/);
    const rejectedCausal = [...runtime.causal.latest.values()].find(
      (record) => record.input?.messageId === contractInput.messageId,
    );
    assert.equal(rejectedCausal.state, 'inference-rejected');
    assert.equal(rejectedCausal.rejectedOutput.text, 'not-json');
    const recoveredContract = await contractChannel.receive(contractInput);
    assert.equal(recoveredContract.replayed, false);
    assert.equal(contractDeliveries.length, 1);
    assert.equal(providerCalls, 6, 'known-invalid output may be regenerated without ambiguous delivery');

    const secondSession = new SelfsameSession({
      stateFile,
      agentId: 'agent',
      createSession: async () => { creates += 1; return 'forbidden-replacement'; },
      resumeSession: async (id, stored) => {
        resumes += 1;
        return memory.verifySession(id, { expectedProof: stored.memoryProof || null }).passed;
      },
    });
    const restartChannel = createMemoryChannel('terminal-restart');
    new TetherRuntime({ session: secondSession, memory, provider, log: () => {} }).attach(restartChannel);
    const restarted = await restartChannel.receive({
      messageId: 'terminal:synthetic-after-restart',
      text: 'still here',
      metadata: { source: 'synthetic-terminal-restart' },
    });
    assert.equal(restarted.sessionId, 'session-one');
    assert.equal(creates, 1, 'a restarted channel must not create a replacement session');
    assert.equal(resumes, 1);

    let replacementAttempts = 0;
    const rejectedSession = new SelfsameSession({
      stateFile,
      agentId: 'agent',
      createSession: async () => { replacementAttempts += 1; return 'replacement'; },
      resumeSession: async () => false,
    });
    await assert.rejects(
      rejectedSession.open({ allowCreate: true }),
      (error) => error instanceof SelfsameContinuityError,
    );
    assert.equal(replacementAttempts, 0, 'resume failure must fail closed');

    const malformedAnchorRoot = path.join(root, 'malformed-anchor');
    atomicWriteJson(path.join(malformedAnchorRoot, 'session.json'), { agentId: 'agent' });
    let malformedCreates = 0;
    let malformedResumes = 0;
    const malformedAnchor = new SelfsameSession({
      stateFile: path.join(malformedAnchorRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => { malformedCreates += 1; return 'must-not-create'; },
      resumeSession: async () => { malformedResumes += 1; return true; },
      canCreateSession: async () => true,
    });
    await assert.rejects(
      malformedAnchor.open({ allowCreate: true }),
      (error) => error instanceof SelfsameContinuityError,
    );
    assert.equal(malformedCreates, 0);
    assert.equal(malformedResumes, 0, 'a malformed anchor must fail before resume');

    const lostAnchorRoot = path.join(root, 'lost-anchor');
    const lostAnchorMemory = new AppendOnlyMemory({ directory: path.join(lostAnchorRoot, 'memory') });
    lostAnchorMemory.appendMessage({
      messageId: 'lost-anchor:1', sessionId: 'original-session', channelId: 'test', role: 'user', text: 'history remains',
    });
    let lostAnchorCreates = 0;
    const lostAnchorSession = new SelfsameSession({
      stateFile: path.join(lostAnchorRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => { lostAnchorCreates += 1; return 'silent-replacement'; },
      resumeSession: async () => false,
      canCreateSession: async () => !lostAnchorMemory.hasExistingAuthority(),
    });
    await assert.rejects(
      lostAnchorSession.open({ allowCreate: true }),
      (error) => error instanceof SelfsameContinuityError,
    );
    assert.equal(lostAnchorCreates, 0, 'raw authority without an anchor must block replacement creation');

    const proofRoot = path.join(root, 'proof-resume');
    const proofMemory = new AppendOnlyMemory({ directory: path.join(proofRoot, 'memory') });
    proofMemory.appendMessage({
      messageId: 'proof:1', sessionId: 'proof-session', channelId: 'test', role: 'user', text: 'checkpointed history',
    });
    const proof = proofMemory.sessionProof('proof-session');
    assert.equal(proof.passed, true);
    atomicWriteJson(path.join(proofRoot, 'session.json'), {
      schemaVersion: 1,
      agentId: 'agent',
      sessionId: 'proof-session',
      memoryProof: proof.proof,
      createdAt: new Date().toISOString(),
    });
    fs.truncateSync(proofMemory.transcriptFile, 0);
    const truncatedProofMemory = new AppendOnlyMemory({ directory: path.join(proofRoot, 'memory') });
    const proofResume = new SelfsameSession({
      stateFile: path.join(proofRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => 'must-not-create',
      resumeSession: async (id, stored) => truncatedProofMemory.verifySession(id, {
        expectedProof: stored.memoryProof,
      }).passed,
    });
    await assert.rejects(proofResume.open(), SelfsameContinuityError);

    const corruptRoot = path.join(root, 'corrupt-resume');
    const corruptMemory = new AppendOnlyMemory({ directory: path.join(corruptRoot, 'memory') });
    corruptMemory.appendMessage({
      messageId: 'corrupt:1', sessionId: 'session-corrupt', channelId: 'test', role: 'user', text: 'intact',
    });
    atomicWriteJson(path.join(corruptRoot, 'session.json'), {
      schemaVersion: 1, agentId: 'agent', sessionId: 'session-corrupt', createdAt: new Date().toISOString(),
    });
    fs.appendFileSync(corruptMemory.transcriptFile, '{"torn":', 'utf8');
    const corruptResume = new SelfsameSession({
      stateFile: path.join(corruptRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => 'must-not-create',
      resumeSession: async (id) => {
        corruptMemory.refresh();
        return corruptMemory.verifySession(id).passed;
      },
    });
    await assert.rejects(corruptResume.open(), SelfsameContinuityError);

    const mismatchRoot = path.join(root, 'mismatch-resume');
    const mismatchMemory = new AppendOnlyMemory({ directory: path.join(mismatchRoot, 'memory') });
    mismatchMemory.appendMessage({
      messageId: 'mismatch:1', sessionId: 'another-session', channelId: 'test', role: 'user', text: 'valid',
    });
    atomicWriteJson(path.join(mismatchRoot, 'session.json'), {
      schemaVersion: 1, agentId: 'agent', sessionId: 'expected-session', createdAt: new Date().toISOString(),
    });
    const mismatchResume = new SelfsameSession({
      stateFile: path.join(mismatchRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => 'must-not-create',
      resumeSession: async (id) => mismatchMemory.verifySession(id).passed,
    });
    await assert.rejects(mismatchResume.open(), SelfsameContinuityError);

    const sourceIds = memory.messages().slice(0, 2).map((item) => item.messageId);
    const rawCount = memory.messages().length;
    memory.appendSummary({ sourceMessageIds: sourceIds, text: 'A synthetic greeting occurred.' });
    const latestSummary = memory.appendSummary({
      sourceMessageIds: sourceIds,
      text: 'The continuity check remained current.',
    });
    const card = memory.appendCard({
      cardType: 'day',
      period: {
        key: '2030-01-01',
        startAt: '2030-01-01T00:00:00.000Z',
        endAt: '2030-01-02T00:00:00.000Z',
      },
      sourceMessageIds: sourceIds,
      content: 'The first cross-channel continuity check passed.',
    });
    assert.equal(memory.messages().length, rawCount, 'derived memory must not delete raw transcript');
    assert.equal(memory.cardsFile, path.join(memory.directory, 'cards', 'cards.jsonl'));
    assert.equal(card.type, 'memory-card');
    assert.equal(card.cardType, 'day');
    assert.equal(card.period.key, '2030-01-01');
    assert.equal(card.content, 'The first cross-channel continuity check passed.');
    assert.equal(card.version, 1);
    assert.ok(card.id);
    const updatedCard = memory.appendCard({
      cardType: 'day',
      version: 2,
      period: {
        key: '2030-01-01',
        startAt: '2030-01-01T00:00:00.000Z',
        endAt: '2030-01-02T00:00:00.000Z',
      },
      sourceMessageIds: sourceIds,
      content: 'The updated cross-channel continuity check passed.',
    });
    memory.appendCard({
      cardType: 'day',
      period: { key: '2030-01-02' },
      sourceMessageIds: sourceIds,
      content: 'A later bounded card.',
    });
    const boundedContext = memory.compileContext({ summaryLimit: 1, cardLimit: 2, rawTailMessages: 3 });
    assert.equal(boundedContext.summaries.length, 1);
    assert.equal(boundedContext.summaries[0].summaryId, latestSummary.summaryId);
    assert.equal(boundedContext.cards.length, 2);
    assert.equal(boundedContext.cards.find((entry) => entry.period.key === '2030-01-01').id, updatedCard.id);
    assert.equal(boundedContext.cards.some((entry) => entry.id === card.id), false, 'superseded card versions must not enter context');
    assert.equal(boundedContext.rawTail.length, 3);
    assert.deepEqual(memory.verifySession('session-one'), { passed: true, errors: [] });
    assert.throws(
      () => memory.appendSummary({ sourceMessageIds: ['missing'], text: 'fabricated' }),
      /existing transcript/,
    );
    assert.throws(
      () => memory.appendSummary({ summaryId: ' ', sourceMessageIds: sourceIds, text: 'invalid id' }),
      /non-empty summaryId/,
    );
    assert.throws(
      () => memory.appendSummary({ sourceMessageIds: [sourceIds[0], sourceIds[0]], text: 'duplicate lineage' }),
      /existing transcript/,
    );
    assert.throws(
      () => memory.appendCard({
        cardType: 'day', period: { key: '2030-01-03' },
        sourceMessageIds: [sourceIds[0], sourceIds[0]], content: 'duplicate lineage',
      }),
      /existing transcript/,
    );
    assert.throws(
      () => memory.appendMessage({
        messageId: 'terminal:synthetic-1', sessionId: 'session-one', channelId: 'wrong-channel',
        role: 'user', text: 'hello', metadata: { source: 'synthetic-terminal' },
      }),
      /different causal envelope/,
    );
    const recallChannel = createMemoryChannel('memory-recall');
    runtime.attach(recallChannel);
    await recallChannel.receive({
      messageId: 'memory-recall:1',
      text: 'What stayed?',
      metadata: { source: 'synthetic-memory-recall' },
    });
    assert.ok(lastProviderMessages.some((message) => (
      message.role === 'system'
      && message.content.includes('[Tether memory card: day:2030-01-01]')
      && message.content.includes('updated cross-channel continuity check passed')
    )), 'verified cards must be injected into provider context with an explicit marker');
    assert.equal(lastProviderMessages.some((message) => (
      message.role === 'system'
      && message.content.includes('The first cross-channel continuity check passed.')
    )), false, 'superseded card content must not be injected');

    const lineageMemory = new AppendOnlyMemory({ directory: path.join(root, 'tampered-lineage', 'memory') });
    lineageMemory.appendMessage({
      messageId: 'lineage:source',
      sessionId: 'lineage-session',
      channelId: 'test',
      role: 'user',
      text: 'authoritative source',
    });
    const lineageSummary = lineageMemory.appendSummary({
      summaryId: 'summary:lineage',
      sourceMessageIds: ['lineage:source'],
      text: 'Valid before tampering.',
    });
    const lineageCard = lineageMemory.appendCard({
      cardId: 'card:lineage',
      cardType: 'day',
      period: { key: '2030-02-01' },
      sourceMessageIds: ['lineage:source'],
      content: 'Valid before tampering.',
    });
    assert.throws(
      () => lineageMemory.appendSummary({
        summaryId: lineageSummary.summaryId,
        sourceMessageIds: ['lineage:source'],
        text: 'Duplicate id.',
      }),
      /already exists/,
    );
    assert.throws(
      () => lineageMemory.appendCard({
        cardId: lineageCard.id,
        cardType: 'day',
        period: { key: '2030-02-01' },
        sourceMessageIds: ['lineage:source'],
        content: 'Duplicate id.',
      }),
      /already exists/,
    );
    fs.appendFileSync(lineageMemory.summariesFile, `${JSON.stringify({
      ...lineageSummary,
      sourceMessageIds: ['missing-source'],
    })}\n`);
    fs.appendFileSync(lineageMemory.cardsFile, `${JSON.stringify({
      ...lineageCard,
      sourceIds: ['missing-source'],
    })}\n`);
    const tamperedLineage = new AppendOnlyMemory({ directory: path.join(root, 'tampered-lineage', 'memory') });
    const lineageVerification = tamperedLineage.verifySession('lineage-session');
    assert.equal(lineageVerification.passed, false);
    assert.ok(lineageVerification.errors.includes('summary-id:summary:lineage'));
    assert.ok(lineageVerification.errors.includes('summary-lineage:summary:lineage'));
    assert.ok(lineageVerification.errors.includes('card-id:card:lineage'));
    assert.ok(lineageVerification.errors.includes('card-lineage:card:lineage'));

    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/semantic-memory.json'), 'utf8'));
    const validation = validateMemoryBundle(fixture);
    assert.equal(validation.passed, true, JSON.stringify(validation.errors));
    const tampered = structuredClone(fixture);
    tampered.claims[0].evidence[0].quote = 'not an exact quote';
    assert.equal(validateMemoryBundle(tampered).passed, false, 'evidence mismatch must fail closed');

    const semantic = new SemanticMemoryStore({ directory: path.join(root, 'semantic'), mode: 'shadow', log: () => {} });
    semantic.initialize({ entities: fixture.entities });
    assert.equal(semantic.manifest().storeType, 'tether-semantic-memory');
    const commit = semantic.commitPacket({
      transactionId: 'tx:synthetic:1',
      packetId: 'packet:synthetic:1',
      source: 'synthetic-fixture',
      ingestionCursor: 1,
      claims: fixture.claims,
      events: [],
      packetManifest: { packetId: 'packet:synthetic:1', status: 'committed' },
    });
    assert.equal(commit.replayed, false);
    assert.equal(semantic.claims().length, 1);
    assert.equal(semantic.commitPacket({
      transactionId: 'tx:synthetic:1', packetId: 'packet:synthetic:1',
      source: 'synthetic-fixture', ingestionCursor: 1,
    }).replayed, true, 'semantic commits must be idempotent');

    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.match(memoryCommandUsage(), /backfill-vectors/);
    const vectorDirectory = path.join(root, 'vector-memory');
    const vectorCalls = [];
    const vectorIndex = new VectorMemoryIndex({
      directory: vectorDirectory,
      enabled: true,
      batchSize: 2,
      minScore: -1,
      embed: async ({ texts, purpose }) => {
        vectorCalls.push({ texts: [...texts], purpose });
        return {
          vectors: texts.map((text) => (
            String(text).toLowerCase().includes('amber') ? [1, 0] : [0, 1]
          )),
          providerId: 'offline-embedding',
          model: 'offline-vector-v1',
        };
      },
      log: () => {},
    });
    const vectorDocuments = [
      { recordId: 'claim:amber', kind: 'claim', title: 'Amber', text: 'The signal remains amber.' },
      { recordId: 'claim:blue', kind: 'claim', title: 'Blue', text: 'The archive is blue.' },
    ];
    assert.equal(vectorIndex.status(vectorDocuments).missingDocuments, 2);
    assert.equal((await vectorIndex.maintainOne(vectorDocuments)).generated, 2);
    assert.equal(vectorIndex.status(vectorDocuments).missingDocuments, 0);
    const embeddingState = JSON.parse(fs.readFileSync(
      path.join(vectorDirectory, 'embedding-state.json'),
      'utf8',
    ));
    assert.deepEqual(
      {
        enabled: embeddingState.enabled,
        totalDocuments: embeddingState.totalDocuments,
        indexedDocuments: embeddingState.indexedDocuments,
        missingDocuments: embeddingState.missingDocuments,
        storedVectors: embeddingState.storedVectors,
      },
      {
        enabled: true,
        totalDocuments: 2,
        indexedDocuments: 2,
        missingDocuments: 0,
        storedVectors: 2,
      },
    );
    assert.equal(fs.statSync(path.join(vectorDirectory, 'embedding-state.json')).mode & 0o777, 0o600);
    const vectorMatches = await vectorIndex.search('amber continuity', vectorDocuments);
    assert.equal(vectorMatches[0].recordId, 'claim:amber');
    assert.equal(vectorCalls.at(-1).purpose, 'memory-query');
    const changedVectorDocuments = [
      { ...vectorDocuments[0], text: 'The signal remains amber forever.' },
      vectorDocuments[1],
    ];
    assert.equal(vectorIndex.status(changedVectorDocuments).missingDocuments, 1);
    assert.equal((await vectorIndex.backfillAll(changedVectorDocuments)).final.missingDocuments, 0);
    const corruptVectorDirectory = path.join(root, 'corrupt-vector-memory');
    fs.mkdirSync(corruptVectorDirectory);
    fs.writeFileSync(path.join(corruptVectorDirectory, 'embeddings.jsonl'), '{bad\n');
    assert.throws(
      () => new VectorMemoryIndex({ directory: corruptVectorDirectory }),
      (error) => error.code === 'TETHER_VECTOR_CORRUPT' && error.line === 1,
    );

    const inboxPath = path.join(root, 'nested-durable', 'durable.jsonl');
    const inbox = new DurableInbox({ filePath: inboxPath, log: () => {} });
    assert.equal(inbox.receive({ update_id: 1, message: { chat: { id: 7, type: 'private' }, text: 'hello' } }), true);
    inbox.markProcessing(1);
    inbox.markDone(1);
    assert.equal(inbox.isDone(1), true);
    assert.equal(fs.statSync(path.dirname(inboxPath)).mode & 0o777, 0o700);
    const editedInbox = new DurableInbox({
      filePath: path.join(root, 'edited-durable.jsonl'),
      log: () => {},
    });
    const editedRawUpdate = {
      update_id: 2,
      edited_message: { chat: { id: 7, type: 'private' }, text: 'edited' },
    };
    assert.equal(editedInbox.chatIdForUpdate(editedRawUpdate), '7');
    assert.equal(editedInbox.receive(editedRawUpdate), true);
    assert.equal(editedInbox.chatIdForEntry(editedInbox.getState(2)), '7');

    assert.deepEqual(splitTelegramText('x'.repeat(4097)).map((chunk) => chunk.length), [4096, 1]);
    assert.deepEqual(splitTelegramText('😀'.repeat(4097)).map((chunk) => Array.from(chunk).length), [4096, 1]);
    assert.equal(telegramRequestTimeoutMs('sendMessage'), 40_000);
    assert.equal(telegramRequestTimeoutMs('getUpdates', { timeout: 30 }), 45_000);

    const durableTelegramRoot = path.join(root, 'durable-telegram');
    const durableTelegramInbox = new DurableInbox({
      filePath: path.join(durableTelegramRoot, 'inbox.jsonl'),
      log: () => {},
    });
    const durableDispatches = [];
    const durableTelegram = createTelegramChannel({
      api: {
        calls: 0,
        async call() {
          this.calls += 1;
          return this.calls === 1
            ? {
                ok: true,
                result: [{
                  update_id: 25,
                  message: {
                    message_id: 5,
                    text: 'persist before offset',
                    from: { id: 11 },
                    chat: { id: 12, type: 'private' },
                  },
                }],
              }
            : { ok: true, result: [] };
        },
        async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
      },
      ownerIds: ['11'],
      offsetStore: createFileOffsetStore(path.join(durableTelegramRoot, 'offset.txt')),
      pollTimeoutSeconds: 0,
      log: () => {},
    });
    durableTelegram.onMessage(async () => ({ ignored: true }));
    const durableDispatcher = createDurableDispatcher({
      inbox: durableTelegramInbox,
      dispatchUpdate: async (update) => { durableDispatches.push(update.update_id); },
      dispatchGroupBatch: async () => {},
      log: () => {},
    });
    const durableUpdateHandler = createDurableUpdateHandler({
      channel: durableTelegram,
      inbox: durableTelegramInbox,
      dispatcher: durableDispatcher,
      log: () => {},
    });
    durableTelegram.onUpdate(async (update) => {
      const result = await durableUpdateHandler(update);
      durableTelegram.stop();
      return result;
    });
    await durableTelegram.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.readFileSync(path.join(durableTelegramRoot, 'offset.txt'), 'utf8').trim(), '26');
    assert.equal(durableTelegramInbox.getState(25).state, 'done');
    assert.deepEqual(durableDispatches, [25]);
    const durableJournal = fs.readFileSync(path.join(durableTelegramRoot, 'inbox.jsonl'), 'utf8');
    assert(durableJournal.includes('persist before offset'));

    const ignoredResult = await durableUpdateHandler({
      update_id: 26,
      message: {
        message_id: 6,
        text: 'unauthorized',
        from: { id: 99 },
        chat: { id: 12, type: 'private' },
      },
    });
    assert.deepEqual(ignoredResult, { ignored: true });
    assert.equal(durableTelegramInbox.getState(26), null);
    assert.deepEqual(
      classifyDurableError({ code: 'TETHER_DELIVERY_AMBIGUOUS' }),
      { action: 'operator-pause', category: 'causal_ambiguity' },
    );

    for (const [name, content, line] of [
      ['middle', '{"state":"done","updateId":1}\nnot-json\n{"state":"done","updateId":2}\n', 2],
      ['tail', '{"state":"done","updateId":1}\n{"state":', 2],
    ]) {
      const corruptPath = path.join(root, `durable-${name}.jsonl`);
      fs.writeFileSync(corruptPath, content, { mode: 0o600 });
      assert.throws(
        () => new DurableInbox({ filePath: corruptPath, log: () => {} }),
        (error) => error.code === 'DURABLE_INBOX_CORRUPT' && error.line === line,
      );
    }

    let sends = 0;
    await sendWithGroupRateLimit('room-a', async () => { sends += 1; return { ok: true }; }, {
      rateLimitedGroupIds: ['room-a'], intervalMs: 1, stateDir: path.join(root, 'rate-limit'),
    });
    assert.equal(sends, 1);

    const normalized = normalizeTelegramUpdate({
      update_id: 8,
      message: { message_id: 9, text: 'hello', from: { id: 11 }, chat: { id: 12, type: 'private' } },
    }, { ownerIds: [11] });
    assert.equal(normalized.metadata.owner, true);
    assert.equal(normalized.metadata.senderDisplayName, '11');
    assert.equal(normalized.metadata.senderIsBot, false);
    assert.equal(normalized.messageId, 'telegram:update:8');
    assert.equal(normalized.metadata.updateKind, 'message');
    assert.equal(normalizeTelegramUpdate({
      update_id: 9,
      message: { message_id: 10, text: 'blocked', from: { id: 99 }, chat: { id: 12, type: 'private' } },
    }, { ownerIds: [11] }), null);

    const attachmentRoot = path.join(root, 'telegram-attachments');
    const attachmentChannel = createTelegramChannel({
      api: {
        async call(method, params) {
          if (method === 'getMe') return { ok: true, result: { id: 900, username: 'anchor_bot' } };
          if (method === 'getFile') {
            return {
              ok: true,
              result: {
                file_path: params.file_id === 'image-ref' ? 'photos/sample.jpg' : 'documents/notes.md',
                file_size: params.file_id === 'image-ref' ? 4 : 18,
              },
            };
          }
          return { ok: true, result: [] };
        },
        async downloadFile(filePath) {
          return filePath.endsWith('.jpg')
            ? { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' }
            : { buffer: Buffer.from('Synthetic note text'), mimeType: 'text/plain' };
        },
        async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
      },
      ownerIds: ['11'],
      allowedGroups: {
        '-77': { mode: 'mention', mentionPatterns: ['Anchor'], ownerAlways: true },
      },
      attachmentDirectory: attachmentRoot,
      offsetStore: createFileOffsetStore(path.join(root, 'attachment-offset.txt')),
      log: () => {},
    });
    await attachmentChannel.initialize();
    const attachmentUpdate = {
      update_id: 41,
      message: {
        message_id: 14,
        text: 'Anchor, inspect these.',
        from: { id: 22, first_name: 'Rin' },
        chat: { id: -77, type: 'supergroup', title: 'Archive room' },
        photo: [{
          file_id: 'image-ref', file_unique_id: 'image-unique', width: 2, height: 2, file_size: 4,
        }],
        document: {
          file_id: 'file-ref', file_unique_id: 'file-unique', file_name: '../notes.md',
          mime_type: 'text/plain', file_size: 18,
        },
      },
    };
    const preparedAttachment = await attachmentChannel.prepareUpdate(attachmentUpdate);
    assert.equal(preparedAttachment.respond, true);
    assert.equal(preparedAttachment.sourceParts.length, 1);
    assert.equal(preparedAttachment.metadata.attachments.length, 2);
    assert.match(preparedAttachment.text, /Synthetic note text/);
    assert.doesNotMatch(preparedAttachment.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(preparedAttachment.metadata.attachments[1].fileName, 'notes.md');
    const durableAttachment = attachmentChannel.durablePreparedMessage(preparedAttachment);
    assert.equal(Object.hasOwn(durableAttachment, 'sourceParts'), false);
    const restoredAttachment = attachmentChannel.restoreDurablePreparedMessage(durableAttachment);
    assert.equal(restoredAttachment.sourceParts[0].data, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'));
    assert.throws(
      () => attachmentChannel.restoreDurablePreparedMessage({
        ...durableAttachment,
        attachmentFiles: [{ type: 'image', path: '/tmp/outside.jpg', mimeType: 'image/jpeg' }],
      }),
      (error) => error.code === 'TETHER_ATTACHMENT_CACHE_INVALID',
    );
    const failedAttachmentChannel = createTelegramChannel({
      api: {
        async call(method) {
          if (method === 'getFile') {
            return { ok: true, result: { file_path: 'photos/missing.jpg', file_size: 4 } };
          }
          return { ok: true, result: { id: 901, username: 'failure_bot' } };
        },
        async downloadFile() { throw new Error('synthetic attachment transport failure'); },
        async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
      },
      ownerIds: ['11'],
      allowedGroups: { '-77': { mode: 'all' } },
      attachmentDirectory: path.join(root, 'failed-telegram-attachments'),
      offsetStore: createFileOffsetStore(path.join(root, 'failed-attachment-offset.txt')),
      log: () => {},
    });
    await assert.rejects(
      failedAttachmentChannel.prepareUpdate(attachmentUpdate),
      (error) => error.code === 'TETHER_ATTACHMENT_DOWNLOAD_FAILED',
    );
    const passiveGroupUpdate = structuredClone(attachmentUpdate);
    passiveGroupUpdate.update_id = 42;
    passiveGroupUpdate.message.message_id = 15;
    passiveGroupUpdate.message.text = 'ordinary background line';
    delete passiveGroupUpdate.message.photo;
    delete passiveGroupUpdate.message.document;
    assert.equal((await attachmentChannel.prepareUpdate(passiveGroupUpdate)).respond, false);
    const bridgeStatusUpdate = structuredClone(passiveGroupUpdate);
    bridgeStatusUpdate.update_id = 47;
    bridgeStatusUpdate.message.message_id = 20;
    bridgeStatusUpdate.message.from = { id: 900, is_bot: true, first_name: 'Relay' };
    bridgeStatusUpdate.message.text = '[bridge-status] Anchor runtime unavailable';
    assert.equal((await attachmentChannel.prepareUpdate(bridgeStatusUpdate)).respond, false);

    const groupBatch = buildTelegramGroupBatch([
      { ...preparedAttachment, updateId: 41, chatId: '-77' },
      {
        ...(await attachmentChannel.prepareUpdate({
          update_id: 43,
          message: {
            message_id: 16,
            text: 'Anchor, second line.',
            from: { id: 23, first_name: 'Archivist' },
            chat: { id: -77, type: 'supergroup', title: 'Archive room' },
          },
        })),
        updateId: 43,
        chatId: '-77',
      },
    ]);
    assert.deepEqual(groupBatch.targetMessageIds, [14, 16]);
    assert.match(groupBatch.providerText, /TARGET_JSONL/);
    const validGroupEnvelope = parseTelegramGroupReplyEnvelope(
      '{"replies":[{"text":"Acknowledged.","replyToMessageId":16}]}',
      groupBatch.targetMessageIds,
    );
    assert.equal(validGroupEnvelope.valid, true);
    assert.equal(parseTelegramGroupReplyEnvelope(
      '{"replies":[{"text":"wrong target","replyToMessageId":999}]}',
      groupBatch.targetMessageIds,
    ).valid, false);

    const groupedInbox = new DurableInbox({
      filePath: path.join(root, 'grouped-inbox.jsonl'),
      log: () => {},
    });
    const groupedMessages = [];
    attachmentChannel.onMessage(async (message) => {
      groupedMessages.push(message);
      return { delivered: true };
    });
    const groupCoordinator = createTelegramGroupCoordinator({
      channel: attachmentChannel,
      inbox: groupedInbox,
      timing: {
        singleMessageMs: 20,
        sameSenderIdleMs: 20,
        sameSenderMaxMs: 20,
        multiSenderIdleMs: 20,
        multiSenderMaxMs: 20,
      },
      log: () => {},
    });
    const groupedUpdates = [attachmentUpdate, {
      update_id: 44,
      message: {
        message_id: 17,
        text: 'Anchor, third line.',
        from: { id: 24, first_name: 'Keeper' },
        chat: { id: -77, type: 'supergroup', title: 'Archive room' },
      },
    }];
    for (const update of groupedUpdates) groupedInbox.receive(update);
    await Promise.all(groupedUpdates.map((update) => groupCoordinator.ingestUpdate(update)));
    assert.equal(groupedMessages.length, 1);
    assert.equal(groupedMessages[0].metadata.groupBatch, true);
    assert.deepEqual(groupedMessages[0].metadata.updateIds, [41, 44]);
    assert.equal(groupedInbox.getState(41).state, 'done');
    assert.equal(groupedInbox.getState(44).state, 'done');
    const durableGroupRecord = groupedInbox.groupBatchForUpdate(41);
    assert.deepEqual(durableGroupRecord.updateIds, [41, 44]);
    assert.equal(JSON.stringify(durableGroupRecord).includes('sourceParts'), false);
    groupCoordinator.stop();

    const barrierInbox = new DurableInbox({
      filePath: path.join(root, 'group-barrier-inbox.jsonl'),
      log: () => {},
    });
    const blockedEarlierUpdate = {
      update_id: 48,
      message: {
        message_id: 21,
        text: 'Anchor, earlier failed line.',
        from: { id: 24, first_name: 'Keeper' },
        chat: { id: -77, type: 'supergroup', title: 'Archive room' },
      },
    };
    const blockedLaterUpdate = {
      update_id: 49,
      message: {
        message_id: 22,
        text: 'Anchor, later line must wait.',
        from: { id: 24, first_name: 'Keeper' },
        chat: { id: -77, type: 'supergroup', title: 'Archive room' },
      },
    };
    barrierInbox.receive(blockedEarlierUpdate);
    barrierInbox.markProcessing(48);
    barrierInbox.markFailed(48, new Error('synthetic earlier failure'));
    barrierInbox.receive(blockedLaterUpdate);
    const barrierCoordinator = createTelegramGroupCoordinator({
      channel: attachmentChannel,
      inbox: barrierInbox,
      timing: { singleMessageMs: 10 },
      log: () => {},
    });
    const barrierResult = await barrierCoordinator.ingestUpdate(blockedLaterUpdate);
    assert.deepEqual(barrierResult, { deferred: true, reason: 'earlier-update-blocked' });
    assert.equal(barrierInbox.getState(49).state, 'received');
    barrierCoordinator.stop();

    const observationRoot = path.join(root, 'layered-observation');
    let observationProviderCalls = 0;
    let observationProviderMessages = [];
    const observationProviderRequests = [];
    const observationProvider = {
      async respond({ messages, purpose = 'chat' }) {
        observationProviderCalls += 1;
        observationProviderMessages = structuredClone(messages);
        observationProviderRequests.push({ purpose, messages: structuredClone(messages) });
        if (purpose === 'group-response-repair') {
          return {
            text: '{"replies":[{"text":"repaired reply","replyToMessageId":19}]}',
            providerId: 'offline-observation-repair',
          };
        }
        if (messages.some((message) => String(message.content || '').includes('TG_GROUP_BATCH_V1'))) {
          return { text: 'malformed group output', providerId: 'offline-observation' };
        }
        return { text: 'continuous reply', providerId: 'offline-observation' };
      },
    };
    const observationMemory = new LayeredMemory({
      directory: path.join(observationRoot, 'memory'),
      provider: observationProvider,
      agent: { id: 'agent', displayName: 'Anchor' },
      owner: { entityId: 'owner', displayName: 'Keeper' },
      memory: {
        semantic: { mode: 'off' },
        cards: { enabled: false },
        activeSoftTokenWatermark: 100_000,
      },
      log: () => {},
    });
    const observationSession = new SelfsameSession({
      stateFile: path.join(observationRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => 'observation-session',
      resumeSession: async (sessionId, stored) => observationMemory.verifySession(sessionId, {
        expectedProof: stored.memoryProof || null,
      }).passed,
      canCreateSession: async () => !observationMemory.hasExistingAuthority(),
    });
    await observationSession.open({ allowCreate: true });
    const observationChannel = createMemoryChannel('telegram-observation');
    const observationRuntime = new TetherRuntime({
      session: observationSession,
      memory: observationMemory,
      provider: observationProvider,
      log: () => {},
    });
    observationRuntime.attach(observationChannel);
    const observed = await observationChannel.receive({
      messageId: 'telegram:update:passive-1',
      text: 'background context',
      respond: false,
      metadata: {
        source: 'telegram',
        trustZone: 'group',
        isGroup: true,
        chatId: '-77',
        chatTitle: 'Archive room',
        senderId: '22',
        senderDisplayName: 'Rin',
        semanticRawMessages: [{
          messageId: 'telegram:-77:18',
          channel: 'telegram',
          chatId: '-77',
          senderId: '22',
          senderDisplayName: 'Rin',
          text: 'background context',
          archiveRef: 'telegram-inbox.jsonl#45',
          ingestionCursor: 'telegram:update:45',
        }],
      },
    });
    assert.equal(observed.observed, true);
    assert.equal(observationProviderCalls, 0, 'passive group ingress must not invoke the model');
    const observationData = observationMemory.getData();
    assert.equal(observationData.rounds[0].ingressOnly, true);
    const observationContext = observationMemory.buildMessages({ userText: 'current turn' }).messages;
    assert.deepEqual(observationContext.map((message) => message.role), ['user', 'user']);
    assert.equal(observationContext.some((message) => (
      message.role === 'assistant' && message.content === ''
    )), false);
    await observationChannel.receive({
      messageId: 'terminal:after-observation',
      text: 'current turn',
      metadata: { source: 'terminal', trustZone: 'trusted_local' },
    });
    assert.equal(observationProviderCalls, 1);
    assert.deepEqual(observationProviderMessages.map((message) => message.role), ['user', 'user']);
    const observationTurns = fs.readFileSync(
      path.join(observationRoot, 'memory', 'transcript.jsonl'),
      'utf8',
    ).trim().split('\n').map(JSON.parse).filter((entry) => entry.type === 'turn');
    assert.equal(observationTurns[0].ingressOnly, true);
    assert.equal(observationTurns[0].groupIngress, true);
    assert.equal(observationTurns[0].semanticRawMessages[0].senderDisplayName, 'Rin');

    const runtimeGroupDeliveries = [];
    const runtimeGroupChannel = createTelegramChannel({
      id: 'telegram-runtime-group',
      api: {
        async call(method) {
          if (method === 'getMe') {
            return { ok: true, result: { id: 900, username: 'anchor_bot' } };
          }
          return { ok: true, result: true };
        },
        async sendMessage(params) {
          runtimeGroupDeliveries.push(structuredClone(params));
          return { ok: true, result: { message_id: 500 + runtimeGroupDeliveries.length } };
        },
      },
      ownerIds: ['11'],
      allowedGroups: {
        '-77': { mode: 'mention', mentionPatterns: ['Anchor'], ownerAlways: true },
      },
      attachmentDirectory: path.join(observationRoot, 'telegram-attachments'),
      offsetStore: createFileOffsetStore(path.join(observationRoot, 'telegram-offset.txt')),
      groupRepairAttempts: 1,
      log: () => {},
    });
    observationRuntime.attach(runtimeGroupChannel);
    await runtimeGroupChannel.initialize();
    const runtimeGroupInbox = new DurableInbox({
      filePath: path.join(observationRoot, 'telegram-inbox.jsonl'),
      log: () => {},
    });
    const runtimeGroupCoordinator = createTelegramGroupCoordinator({
      channel: runtimeGroupChannel,
      inbox: runtimeGroupInbox,
      timing: {
        singleMessageMs: 10,
        sameSenderIdleMs: 10,
        sameSenderMaxMs: 10,
        multiSenderIdleMs: 10,
        multiSenderMaxMs: 10,
      },
      log: () => {},
    });
    const runtimeGroupUpdate = {
      update_id: 46,
      message: {
        message_id: 19,
        text: 'Anchor, answer with the strict contract.',
        date: 1_900_000_000,
        from: { id: 23, first_name: 'Archivist' },
        chat: { id: -77, type: 'supergroup', title: 'Archive room' },
      },
    };
    runtimeGroupInbox.receive(runtimeGroupUpdate);
    await runtimeGroupCoordinator.ingestUpdate(runtimeGroupUpdate);
    assert.equal(observationProviderCalls, 3, 'group output must run one bounded repair');
    assert.equal(observationProviderRequests[1].purpose, 'chat');
    assert.equal(observationProviderRequests[2].purpose, 'group-response-repair');
    assert.match(
      observationProviderRequests[1].messages.find((message) => message.role === 'system').content,
      /Telegram group response contract/,
    );
    assert.match(observationProviderRequests[1].messages.at(-1).content, /TARGET_JSONL/);
    assert.equal(runtimeGroupDeliveries.length, 1);
    assert.equal(runtimeGroupDeliveries[0].reply_parameters.message_id, 19);
    assert.equal(runtimeGroupDeliveries[0].text, 'repaired reply');
    const committedGroupRound = observationMemory.getData().rounds.at(-1);
    assert.equal(committedGroupRound.groupIngress, true);
    assert.match(committedGroupRound.user, /quoted JSONL/);
    assert.equal(committedGroupRound.assistant, 'Reply to message 19: repaired reply');
    assert.equal(runtimeGroupInbox.getState(46).state, 'done');
    const committedGroupCausal = [...observationRuntime.causal.latest.values()].find(
      (record) => record.input?.messageId === 'telegram:group-batch:-77:46',
    );
    assert.equal(
      committedGroupCausal.output.text,
      '{"replies":[{"text":"repaired reply","replyToMessageId":19}]}',
    );
    runtimeGroupCoordinator.stop();

    const identityPolicy = normalizeIdentityPolicy({
      agent: { id: 'agent' },
      owner: { entityId: 'owner', displayName: 'Owner', telegramUserIds: ['11'] },
      entities: [
        { entityId: 'owner', canonicalDisplayName: 'Owner', type: 'person' },
        { entityId: 'agent', canonicalDisplayName: 'Agent', type: 'ai' },
      ],
      addressPolicy: {
        canonicalOwnerName: 'Owner', disallowedOwnerNames: ['old-name'], preservedEntityNames: ['another-person'],
      },
    });
    assert.equal(entityForTelegramSender(11, identityPolicy), 'owner');
    assert.equal(
      normalizeOwnerAddress('old-name said “old-name is a historical quote”', identityPolicy),
      'Owner said “old-name is a historical quote”',
    );
    assert.throws(
      () => assertAttribution({ sourceSenderEntityId: 'agent', claimedSpeakerEntityId: 'owner' }),
      /differs from the source sender/,
    );

    let telegramSendBody = null;
    const telegramApi = createTelegramApi({
      token: 'synthetic-token',
      fetchImpl: async (_url, options) => {
        telegramSendBody = JSON.parse(options.body);
        return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 1 } }; } };
      },
    });
    await telegramApi.sendMessage({
      chat_id: 'no-reply-room', text: 'hello', reply_parameters: { message_id: 99 },
    }, { noReplyGroupIds: ['no-reply-room'] });
    assert.equal(telegramSendBody.reply_parameters, undefined);
    await assert.rejects(
      createTelegramApi({
        token: 'synthetic-token',
        fetchImpl: async () => { throw new Error('connection vanished'); },
      }).sendMessage({ chat_id: 1, text: 'ambiguous' }),
      (error) => error.deliveryAmbiguous === true && error.manualRetryOnly === true,
    );
    await assert.rejects(
      createTelegramApi({
        token: 'synthetic-token',
        fetchImpl: async () => { throw new Error('poll connection vanished'); },
      }).call('getUpdates', { timeout: 0 }),
      (error) => error.deliveryAmbiguous !== true,
    );
    await assert.rejects(
      createTelegramApi({
        token: 'synthetic-token',
        fetchImpl: async () => { throw new Error('file lookup connection vanished'); },
      }).call('getFile', { file_id: 'synthetic' }),
      (error) => error.deliveryAmbiguous !== true,
    );

    const splitDeliveries = [];
    const splitChannel = createTelegramChannel({
      api: {
        async call() { return { ok: true, result: [] }; },
        async sendMessage(params) {
          splitDeliveries.push(structuredClone(params));
          return { ok: true, result: { message_id: splitDeliveries.length } };
        },
      },
      ownerIds: ['11'],
      offsetStore: createFileOffsetStore(path.join(root, 'split-offset.txt')),
      log: () => {},
    });
    await splitChannel.send({
      text: 'z'.repeat(4097),
      sourceMessage: { metadata: { chatId: '12', telegramMessageId: 9 } },
    });
    assert.deepEqual(splitDeliveries.map((item) => item.text.length), [4096, 1]);
    assert.equal(splitDeliveries[0].reply_parameters.message_id, 9);
    assert.equal(splitDeliveries[1].reply_parameters, undefined);

    let partialCalls = 0;
    const partialChannel = createTelegramChannel({
      api: {
        async call() { return { ok: true, result: [] }; },
        async sendMessage() {
          partialCalls += 1;
          if (partialCalls === 2) throw new Error('safe second-chunk rejection');
          return { ok: true, result: { message_id: partialCalls } };
        },
      },
      ownerIds: ['11'],
      offsetStore: createFileOffsetStore(path.join(root, 'partial-offset.txt')),
      log: () => {},
    });
    await assert.rejects(
      partialChannel.send({
        text: 'q'.repeat(4097),
        sourceMessage: { metadata: { chatId: '12', telegramMessageId: 9 } },
      }),
      (error) => error.deliveryAmbiguous === true
        && error.manualRetryOnly === true
        && error.partialDeliveryCount === 1,
    );
    const reactionAfterReplyChannel = createTelegramChannel({
      api: {
        async call(method) {
          if (method === 'setMessageReaction') throw new Error('definite reaction rejection');
          return { ok: true, result: [] };
        },
        async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
      },
      ownerIds: ['11'],
      groupAllowedReactions: ['👍'],
      offsetStore: createFileOffsetStore(path.join(root, 'reaction-offset.txt')),
      log: () => {},
    });
    await assert.rejects(
      reactionAfterReplyChannel.send({
        text: '{"replies":[{"text":"sent first","replyToMessageId":9}],"react":"👍"}',
        sourceMessage: {
          metadata: {
            chatId: '-77',
            groupBatch: true,
            groupReplyTargetIds: [9],
            groupAllowedReactions: ['👍'],
          },
        },
      }),
      (error) => error.deliveryAmbiguous === true
        && error.manualRetryOnly === true
        && error.partialDeliveryCount === 1,
    );
    assert.throws(
      () => createTelegramApi({ token: 'synthetic-token', apiBase: 'http://example.invalid' }),
      /https unless the host is loopback/,
    );
    assert.doesNotThrow(() => createTelegramApi({
      token: 'synthetic-token',
      apiBase: 'http://127.0.0.1:8081/',
      fetchImpl: async () => { throw new Error('not called'); },
    }));

    const toolStateRoot = path.join(root, 'workspace-tools');
    const toolStorageRoot = path.join(toolStateRoot, 'state');
    const workspaceRoot = path.join(toolStateRoot, 'workspace');
    const toolConfig = {
      storage: { root: toolStorageRoot },
      tools: {
        enabled: true,
        maxIterations: 3,
        maxReadBytes: 128,
        maxWriteBytes: 256,
        maxDirectoryEntries: 10,
        workspaceRoots: [{ id: 'workspace', path: workspaceRoot }],
        policies: {
          terminal: { read: 'allow', write: 'allow' },
          telegramPrivate: { read: 'allow', write: 'approval' },
          telegramGroup: { read: 'deny', write: 'deny' },
          default: { read: 'deny', write: 'deny' },
        },
      },
    };
    const workspaceTools = createWorkspaceToolRuntime({
      config: toolConfig,
      storageRoot: toolStorageRoot,
    });
    assert.throws(
      () => createWorkspaceToolRuntime({
        config: {
          storage: { root: toolStorageRoot },
          tools: {
            ...toolConfig.tools,
            workspaceRoots: [{ id: 'unsafe', path: toolStateRoot }],
          },
        },
        storageRoot: toolStorageRoot,
      }),
      (error) => error.code === 'TETHER_TOOL_ROOT_OVERLAPS_STORAGE',
    );
    assert.equal(workspaceTools.definitions({ channelId: 'terminal' }).length, 3);
    assert.equal(workspaceTools.definitions({ channelId: 'telegram', isGroup: true }).length, 0);
    const terminalToolContext = { causalId: 'tools:terminal:1', channelId: 'terminal' };
    const toolWrite = await workspaceTools.execute({
      id: 'write-1',
      name: 'write_workspace_file',
      arguments: { root: 'workspace', path: 'notes/one.txt', content: 'durable text' },
    }, terminalToolContext);
    assert.equal(toolWrite.ok, true);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'notes', 'one.txt'), 'utf8'), 'durable text');
    const toolRead = await workspaceTools.execute({
      id: 'read-1',
      name: 'read_workspace_file',
      arguments: { root: 'workspace', path: 'notes/one.txt' },
    }, terminalToolContext);
    assert.equal(toolRead.content, 'durable text');
    const toolList = await workspaceTools.execute({
      id: 'list-1',
      name: 'list_workspace_directory',
      arguments: { root: 'workspace', path: 'notes' },
    }, terminalToolContext);
    assert.deepEqual(toolList.entries, [{ name: 'one.txt', type: 'file' }]);
    const replayedToolWrite = await workspaceTools.execute({
      id: 'write-1',
      name: 'write_workspace_file',
      arguments: { root: 'workspace', path: 'notes/one.txt', content: 'durable text' },
    }, terminalToolContext);
    assert.equal(replayedToolWrite.replayed, true);
    const reusedCallId = await workspaceTools.execute({
      id: 'write-1',
      name: 'write_workspace_file',
      arguments: { root: 'workspace', path: 'notes/one.txt', content: 'different' },
    }, terminalToolContext);
    assert.equal(reusedCallId.error.code, 'TETHER_TOOL_OPERATION_MISMATCH');
    const traversalResult = await workspaceTools.execute({
      id: 'read-traversal',
      name: 'read_workspace_file',
      arguments: { root: 'workspace', path: '../outside.txt' },
    }, terminalToolContext);
    assert.equal(traversalResult.error.code, 'TETHER_TOOL_PATH_INVALID');
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'SECRET=synthetic');
    const hiddenResult = await workspaceTools.execute({
      id: 'read-hidden',
      name: 'read_workspace_file',
      arguments: { root: 'workspace', path: '.env' },
    }, terminalToolContext);
    assert.equal(hiddenResult.error.code, 'TETHER_TOOL_PATH_SENSITIVE');
    const outsideToolFile = path.join(toolStateRoot, 'outside.txt');
    fs.writeFileSync(outsideToolFile, 'outside');
    fs.symlinkSync(outsideToolFile, path.join(workspaceRoot, 'linked.txt'));
    const symlinkResult = await workspaceTools.execute({
      id: 'read-link',
      name: 'read_workspace_file',
      arguments: { root: 'workspace', path: 'linked.txt' },
    }, terminalToolContext);
    assert.equal(symlinkResult.error.code, 'TETHER_TOOL_PATH_SYMLINK');
    fs.writeFileSync(path.join(workspaceRoot, 'binary.bin'), Buffer.from([0xc3, 0x28]));
    const binaryResult = await workspaceTools.execute({
      id: 'read-binary',
      name: 'read_workspace_file',
      arguments: { root: 'workspace', path: 'binary.bin' },
    }, terminalToolContext);
    assert.equal(binaryResult.error.code, 'TETHER_TOOL_NOT_UTF8');
    const groupDenied = await workspaceTools.execute({
      id: 'group-read',
      name: 'read_workspace_file',
      arguments: { root: 'workspace', path: 'notes/one.txt' },
    }, { causalId: 'tools:group:1', channelId: 'telegram', isGroup: true });
    assert.equal(groupDenied.error.code, 'TETHER_TOOL_DENIED');

    const approvalCall = {
      id: 'private-write-1',
      name: 'write_workspace_file',
      arguments: { root: 'workspace', path: 'approved.txt', content: 'approved content' },
    };
    let approvalError;
    try {
      await workspaceTools.execute(
        approvalCall,
        { causalId: 'tools:private:1', channelId: 'telegram', owner: true },
      );
    } catch (error) { approvalError = error; }
    assert.equal(approvalError.code, 'TETHER_TOOL_APPROVAL_REQUIRED');
    assert.equal(approvalError.pauseRetry, true);
    assert.match(approvalError.message, /approval:/);
    assert.equal(classifyDurableError(approvalError).action, 'pause');
    assert.equal(workspaceTools.journal.listApprovals({ state: 'pending' }).length, 1);
    let secondApprovalError;
    try {
      await workspaceTools.execute(
        { ...approvalCall, id: 'private-write-2' },
        { causalId: 'tools:private:2', channelId: 'telegram', owner: true },
      );
    } catch (error) { secondApprovalError = error; }
    assert.notEqual(secondApprovalError.approvalId, approvalError.approvalId);
    const externalApprovalJournal = new ToolJournal({
      directory: path.join(toolStorageRoot, 'tools'),
    });
    externalApprovalJournal.resolveApproval(approvalError.approvalId, 'approved');
    const approvedWrite = await workspaceTools.execute(
      approvalCall,
      { causalId: 'tools:private:1', channelId: 'telegram', owner: true },
    );
    assert.equal(approvedWrite.ok, true);
    externalApprovalJournal.refresh();
    externalApprovalJournal.resolveApproval(secondApprovalError.approvalId, 'denied');
    const deniedWrite = await workspaceTools.execute(
      { ...approvalCall, id: 'private-write-2' },
      { causalId: 'tools:private:2', channelId: 'telegram', owner: true },
    );
    assert.equal(deniedWrite.status, 'denied');

    function preparedWriteIdentity(causalId, toolCallId, args) {
      const fingerprint = toolSha256(canonicalJson({
        schemaVersion: 1,
        scope: 'terminal',
        toolName: 'write_workspace_file',
        args,
      }));
      const operationKey = `operation:${toolSha256(canonicalJson({ causalId, toolCallId })).slice(0, 32)}`;
      return { fingerprint, operationKey };
    }
    const preparedSafeArgs = { root: 'workspace', path: 'prepared-safe.txt', content: 'safe' };
    const preparedSafe = preparedWriteIdentity('tools:prepared:1', 'prepared-safe', preparedSafeArgs);
    workspaceTools.journal.prepareOperation({
      ...preparedSafe,
      causalId: 'tools:prepared:1',
      toolCallId: 'prepared-safe',
      toolName: 'write_workspace_file',
      details: {
        prior: { exists: false, sha256: null, size: 0 },
        desired: { exists: true, sha256: toolSha256('safe'), size: 4 },
      },
    });
    assert.equal((await workspaceTools.execute({
      id: 'prepared-safe', name: 'write_workspace_file', arguments: preparedSafeArgs,
    }, { causalId: 'tools:prepared:1', channelId: 'terminal' })).ok, true);
    const preparedRecoveredArgs = { root: 'workspace', path: 'prepared-recovered.txt', content: 'desired' };
    const preparedRecovered = preparedWriteIdentity(
      'tools:prepared:2',
      'prepared-recovered',
      preparedRecoveredArgs,
    );
    workspaceTools.journal.prepareOperation({
      ...preparedRecovered,
      causalId: 'tools:prepared:2',
      toolCallId: 'prepared-recovered',
      toolName: 'write_workspace_file',
      details: {
        prior: { exists: false, sha256: null, size: 0 },
        desired: { exists: true, sha256: toolSha256('desired'), size: 7 },
      },
    });
    fs.writeFileSync(path.join(workspaceRoot, 'prepared-recovered.txt'), 'desired');
    assert.equal((await workspaceTools.execute({
      id: 'prepared-recovered', name: 'write_workspace_file', arguments: preparedRecoveredArgs,
    }, { causalId: 'tools:prepared:2', channelId: 'terminal' })).replayed, true);
    const preparedConflictArgs = { root: 'workspace', path: 'prepared-conflict.txt', content: 'desired' };
    const preparedConflict = preparedWriteIdentity(
      'tools:prepared:3',
      'prepared-conflict',
      preparedConflictArgs,
    );
    workspaceTools.journal.prepareOperation({
      ...preparedConflict,
      causalId: 'tools:prepared:3',
      toolCallId: 'prepared-conflict',
      toolName: 'write_workspace_file',
      details: {
        prior: { exists: false, sha256: null, size: 0 },
        desired: { exists: true, sha256: toolSha256('desired'), size: 7 },
      },
    });
    fs.writeFileSync(path.join(workspaceRoot, 'prepared-conflict.txt'), 'external change');
    await assert.rejects(
      workspaceTools.execute({
        id: 'prepared-conflict', name: 'write_workspace_file', arguments: preparedConflictArgs,
      }, { causalId: 'tools:prepared:3', channelId: 'terminal' }),
      (error) => error.code === 'TETHER_TOOL_EFFECT_AMBIGUOUS' && error.manualRetryOnly === true,
    );
    const reservedJournal = new ToolJournal({ directory: path.join(toolStateRoot, 'reserved-journal') });
    reservedJournal.beginTransaction('reserved-causal', 'request-hash');
    reservedJournal.recordTransaction('reserved-causal', 'request-started', {
      iteration: 0,
      providerIndex: 0,
      providerId: 'provider',
    });
    reservedJournal.recordTransaction('reserved-causal', 'provider-step', {
      causalId: 'overridden',
      event: 'overridden',
      iteration: 0,
      providerIndex: 0,
      providerId: 'provider',
      message: { role: 'assistant', content: 'done' },
      result: { text: 'done' },
    });
    assert.equal(reservedJournal.transactionEvents('reserved-causal').at(-1).event, 'provider-step');
    assert.throws(
      () => new ToolJournal({ directory: (() => {
        const directory = path.join(toolStateRoot, 'corrupt-journal');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'tool-journal.jsonl'), '{"torn":');
        return directory;
      })() }),
      (error) => error.code === 'TETHER_TOOL_JOURNAL_CORRUPT',
    );

    let requestedBody = null;
    let requestedUrl = null;
    const openAi = createOpenAICompatibleProvider({
      providers: [{
        id: 'mock',
        label: 'Mock Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'mock-model',
        foldModel: 'mock-fold-model',
        memoryModel: 'mock-memory-model',
        semanticExtractorModel: 'mock-semantic-extractor',
        semanticVerifierModel: 'mock-semantic-verifier',
        semanticHighRiskModel: 'mock-semantic-high-risk',
        embeddingsUrl: 'https://example.invalid/v1/embeddings',
        embeddingModel: 'mock-embedding',
        imageInput: 'data-url',
        maxImageParts: 2,
      }],
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        requestedBody = JSON.parse(options.body);
        if (url.endsWith('/embeddings')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                data: requestedBody.input.map((_text, index) => ({ index, embedding: [index + 1, 1] })),
              };
            },
          };
        }
        return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'ok' } }] }; } };
      },
    });
    assert.equal((await openAi.respond({ messages: [{ role: 'user', content: 'offline' }] })).text, 'ok');
    assert.equal(requestedBody.model, 'mock-model');
    await openAi.respond({
      messages: [{ role: 'user', content: 'inspect image' }],
      sourceParts: [{
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('synthetic-image').toString('base64'),
      }],
    });
    assert.equal(requestedBody.messages[0].content[0].text, 'inspect image');
    assert.match(requestedBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(JSON.stringify(requestedBody).includes(attachmentRoot), false);
    await openAi.respond({ purpose: 'fold', messages: [{ role: 'user', content: 'fold' }] });
    assert.equal(requestedBody.model, 'mock-fold-model');
    await openAi.respond({ purpose: 'memory-card', messages: [{ role: 'user', content: 'card' }] });
    assert.equal(requestedBody.model, 'mock-memory-model');
    await openAi.respond({ purpose: 'semantic-extract', messages: [{ role: 'user', content: '{}' }] });
    assert.equal(requestedBody.model, 'mock-semantic-extractor');
    await openAi.respond({ purpose: 'semantic-verify', messages: [{ role: 'user', content: '{}' }] });
    assert.equal(requestedBody.model, 'mock-semantic-verifier');
    await openAi.respond({ purpose: 'semantic-high-risk', messages: [{ role: 'user', content: '{}' }] });
    assert.equal(requestedBody.model, 'mock-semantic-high-risk');
    const embedded = await openAi.embed({ texts: ['one', 'two'] });
    assert.equal(requestedUrl, 'https://example.invalid/v1/embeddings');
    assert.equal(requestedBody.model, 'mock-embedding');
    assert.deepEqual(embedded.vectors, [[1, 1], [2, 1]]);
    await assert.rejects(
      createOpenAICompatibleProvider({
        providers: [{ id: 'remote-http', baseUrl: 'http://example.invalid/v1', model: 'x' }],
        fetchImpl: async () => { throw new Error('must not fetch'); },
      }).respond({ messages: [] }),
      (error) => error.message === 'Every configured provider failed'
        && error.failures[0].message.includes('https unless the host is loopback'),
    );
    const localHttp = createOpenAICompatibleProvider({
      providers: [{ id: 'local-http', baseUrl: 'http://localhost:11434/v1', model: 'local-model' }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content: 'local-ok' } }] }; },
      }),
    });
    assert.equal((await localHttp.respond({ messages: [] })).text, 'local-ok');
    await assert.rejects(
      createOpenAICompatibleProvider({
        providers: [{ id: 'bad', baseUrl: 'file:///tmp/model', model: 'x' }],
      }).respond({ messages: [] }),
      /Every configured provider failed/,
    );

    const providerToolRoot = path.join(root, 'provider-tool-loop');
    const providerToolStorageRoot = path.join(providerToolRoot, 'state');
    const providerToolConfig = {
      storage: { root: providerToolStorageRoot },
      tools: {
        enabled: true,
        maxIterations: 3,
        workspaceRoots: [{ id: 'workspace', path: path.join(providerToolRoot, 'workspace') }],
        policies: {
          terminal: { read: 'allow', write: 'allow' },
          telegramPrivate: { read: 'allow', write: 'approval' },
          telegramGroup: { read: 'deny', write: 'deny' },
          default: { read: 'deny', write: 'deny' },
        },
      },
    };
    const providerToolBodies = [];
    let providerToolFetches = 0;
    const providerToolRuntime = createWorkspaceToolRuntime({
      config: providerToolConfig,
      storageRoot: providerToolStorageRoot,
    });
    const providerWithTools = createOpenAICompatibleProvider({
      providers: [{
        id: 'tool-provider',
        label: 'Tool Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'tool-model',
      }],
      toolRuntime: providerToolRuntime,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        providerToolBodies.push(body);
        providerToolFetches += 1;
        if (providerToolFetches === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                choices: [{
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    tool_calls: [{
                      id: 'provider-write-1',
                      type: 'function',
                      function: {
                        name: 'write_workspace_file',
                        arguments: JSON.stringify({
                          root: 'workspace',
                          path: 'provider.txt',
                          content: 'written by provider loop',
                        }),
                      },
                    }],
                  },
                }],
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ finish_reason: 'stop', message: { content: 'tool loop complete' } }] };
          },
        };
      },
    });
    const providerToolRequest = {
      messages: [{ role: 'user', content: 'Write the provider test file.' }],
      causalId: 'provider-tool-causal',
      toolContext: { channelId: 'terminal' },
    };
    const providerToolResult = await providerWithTools.respond(providerToolRequest);
    assert.equal(providerToolResult.text, 'tool loop complete');
    assert.equal(providerToolBodies[0].tools.length, 3);
    assert.equal(providerToolBodies[0].parallel_tool_calls, false);
    assert.equal(providerToolBodies[1].messages.at(-1).role, 'tool');
    assert.equal(
      fs.readFileSync(path.join(providerToolRoot, 'workspace', 'provider.txt'), 'utf8'),
      'written by provider loop',
    );
    const providerReplayRuntime = createWorkspaceToolRuntime({
      config: providerToolConfig,
      storageRoot: providerToolStorageRoot,
    });
    const replayProvider = createOpenAICompatibleProvider({
      providers: [{
        id: 'tool-provider',
        label: 'Tool Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'tool-model',
      }],
      toolRuntime: providerReplayRuntime,
      fetchImpl: async () => { throw new Error('durable final must not refetch'); },
    });
    const replayedProviderResult = await replayProvider.respond(providerToolRequest);
    assert.equal(replayedProviderResult.text, 'tool loop complete');
    assert.equal(replayedProviderResult.replayed, true);
    const changedRootConfig = {
      ...providerToolConfig,
      tools: {
        ...providerToolConfig.tools,
        workspaceRoots: [{ id: 'workspace', path: path.join(providerToolRoot, 'different-workspace') }],
      },
    };
    const changedContractProvider = createOpenAICompatibleProvider({
      providers: [{
        id: 'tool-provider',
        label: 'Tool Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'tool-model',
      }],
      toolRuntime: createWorkspaceToolRuntime({
        config: changedRootConfig,
        storageRoot: providerToolStorageRoot,
      }),
      fetchImpl: async () => { throw new Error('contract mismatch must not fetch'); },
    });
    await assert.rejects(
      changedContractProvider.respond(providerToolRequest),
      (error) => error.code === 'TETHER_TOOL_TRANSACTION_MISMATCH',
    );

    const ambiguousToolRoot = path.join(root, 'provider-tool-ambiguous');
    const ambiguousToolStorageRoot = path.join(ambiguousToolRoot, 'state');
    const ambiguousToolConfig = {
      ...providerToolConfig,
      storage: { root: ambiguousToolStorageRoot },
      tools: {
        ...providerToolConfig.tools,
        workspaceRoots: [{ id: 'workspace', path: path.join(ambiguousToolRoot, 'workspace') }],
      },
    };
    const ambiguousToolRuntime = createWorkspaceToolRuntime({
      config: ambiguousToolConfig,
      storageRoot: ambiguousToolStorageRoot,
    });
    const ambiguousToolProvider = createOpenAICompatibleProvider({
      providers: [{
        id: 'tool-provider',
        label: 'Tool Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'tool-model',
      }],
      toolRuntime: ambiguousToolRuntime,
      fetchImpl: async () => { throw new Error('synthetic connection loss'); },
    });
    const ambiguousToolRequest = {
      messages: [{ role: 'user', content: 'ambiguous request' }],
      causalId: 'provider-tool-ambiguous',
      toolContext: { channelId: 'terminal' },
    };
    await assert.rejects(
      ambiguousToolProvider.respond(ambiguousToolRequest),
      (error) => error.code === 'TETHER_TOOL_INFERENCE_AMBIGUOUS'
        && error.manualRetryOnly === true,
    );
    assert.equal(ambiguousToolProvider.canResume('provider-tool-ambiguous'), false);
    let forbiddenAmbiguousRefetches = 0;
    const ambiguousRestartProvider = createOpenAICompatibleProvider({
      providers: [{
        id: 'tool-provider',
        label: 'Tool Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'tool-model',
      }],
      toolRuntime: createWorkspaceToolRuntime({
        config: ambiguousToolConfig,
        storageRoot: ambiguousToolStorageRoot,
      }),
      fetchImpl: async () => { forbiddenAmbiguousRefetches += 1; throw new Error('must not refetch'); },
    });
    await assert.rejects(
      ambiguousRestartProvider.respond(ambiguousToolRequest),
      (error) => error.code === 'TETHER_TOOL_INFERENCE_AMBIGUOUS',
    );
    assert.equal(forbiddenAmbiguousRefetches, 0);

    const approvalRuntimeRoot = path.join(root, 'approval-runtime');
    const approvalRuntimeStorageRoot = path.join(approvalRuntimeRoot, 'state');
    const approvalRuntimeConfig = {
      storage: { root: approvalRuntimeStorageRoot },
      tools: {
        ...providerToolConfig.tools,
        workspaceRoots: [{ id: 'workspace', path: path.join(approvalRuntimeRoot, 'workspace') }],
      },
    };
    const approvalRuntimeTools = createWorkspaceToolRuntime({
      config: approvalRuntimeConfig,
      storageRoot: approvalRuntimeStorageRoot,
    });
    let approvalRuntimeFetches = 0;
    const approvalRuntimeProvider = createOpenAICompatibleProvider({
      providers: [{
        id: 'approval-provider',
        label: 'Approval Provider',
        baseUrl: 'https://example.invalid/v1/chat/completions',
        model: 'approval-model',
      }],
      toolRuntime: approvalRuntimeTools,
      fetchImpl: async (_url, options) => {
        approvalRuntimeFetches += 1;
        const body = JSON.parse(options.body);
        if (approvalRuntimeFetches === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { choices: [{ message: {
                content: null,
                tool_calls: [{
                  id: 'approval-write-call',
                  type: 'function',
                  function: {
                    name: 'write_workspace_file',
                    arguments: JSON.stringify({
                      root: 'workspace', path: 'approved-runtime.txt', content: 'approved at runtime',
                    }),
                  },
                }],
              } }] };
            },
          };
        }
        assert.equal(body.messages.at(-1).role, 'tool');
        return {
          ok: true,
          status: 200,
          async json() { return { choices: [{ message: { content: 'approved runtime complete' } }] }; },
        };
      },
    });
    const approvalMemory = new AppendOnlyMemory({
      directory: path.join(approvalRuntimeRoot, 'memory'),
    });
    const approvalSession = new SelfsameSession({
      stateFile: path.join(approvalRuntimeRoot, 'session.json'),
      agentId: 'agent',
      createSession: async () => 'approval-session',
      resumeSession: async (sessionId) => approvalMemory.verifySession(sessionId).passed,
      canCreateSession: async () => !approvalMemory.hasExistingAuthority(),
    });
    await approvalSession.open({ allowCreate: true });
    const approvalChannel = createMemoryChannel('telegram');
    const approvalRuntime = new TetherRuntime({
      session: approvalSession,
      memory: approvalMemory,
      provider: approvalRuntimeProvider,
      log: () => {},
    }).attach(approvalChannel);
    const approvalInput = {
      messageId: 'telegram:approval-runtime',
      text: 'write after exact approval',
      metadata: { owner: true, senderId: 'owner', isGroup: false },
    };
    let runtimeApprovalError;
    try { await approvalChannel.receive(approvalInput); } catch (error) { runtimeApprovalError = error; }
    assert.equal(runtimeApprovalError.code, 'TETHER_TOOL_APPROVAL_REQUIRED');
    const approvalCausal = approvalRuntime.causal.prepareInput({
      sessionId: 'approval-session',
      channelId: 'telegram',
      messageId: approvalInput.messageId,
      role: 'user',
      text: approvalInput.text,
      metadata: approvalInput.metadata,
    });
    assert.equal(approvalRuntime.causal.state(approvalCausal.causalId).state, 'inference-started');
    approvalRuntimeTools.journal.resolveApproval(runtimeApprovalError.approvalId, 'approved');
    const approvalCompleted = await approvalChannel.receive(approvalInput);
    assert.equal(approvalCompleted.assistant.text, 'approved runtime complete');
    assert.equal(approvalRuntimeFetches, 2, 'resume must continue after the durable provider tool step');
    assert.equal(
      fs.readFileSync(path.join(approvalRuntimeRoot, 'workspace', 'approved-runtime.txt'), 'utf8'),
      'approved at runtime',
    );
    const approvalDuplicate = await approvalChannel.receive(approvalInput);
    assert.equal(approvalDuplicate.alreadyDelivered, true);
    assert.equal(approvalRuntimeFetches, 2);

    const schemaRoot = path.join(root, 'storage-schema');
    const initializedSchema = ensureRuntimeStorageSchema(schemaRoot, { agentId: 'agent' });
    assert.equal(initializedSchema.status, 'current');
    assert.equal(initializedSchema.version, CURRENT_STORAGE_VERSION);
    assert.equal(ensureRuntimeStorageSchema(schemaRoot, { agentId: 'agent' }).status, 'current');
    assert.throws(
      () => ensureRuntimeStorageSchema(schemaRoot, { agentId: 'different-agent' }),
      (error) => error.code === 'TETHER_STORAGE_AGENT_MISMATCH',
    );
    const legacySchemaRoot = path.join(root, 'storage-schema-legacy');
    fs.mkdirSync(legacySchemaRoot, { recursive: true });
    fs.writeFileSync(path.join(legacySchemaRoot, 'legacy-authority.jsonl'), '{"legacy":true}\n');
    assert.equal(inspectStorageSchema(legacySchemaRoot).status, 'migration-required');
    assert.throws(
      () => ensureRuntimeStorageSchema(legacySchemaRoot, { agentId: 'agent' }),
      (error) => error.code === 'TETHER_STORAGE_MIGRATION_REQUIRED',
    );
    const legacyBytes = fs.readFileSync(path.join(legacySchemaRoot, 'legacy-authority.jsonl'));
    const migratedSchema = migrateStorageSchema(legacySchemaRoot, { agentId: 'agent' });
    assert.equal(migratedSchema.status, 'current');
    assert.equal(migratedSchema.marker.migratedFrom, 0);
    assert.deepEqual(
      fs.readFileSync(path.join(legacySchemaRoot, 'legacy-authority.jsonl')),
      legacyBytes,
      'v0 adoption must not rewrite existing authority',
    );
    const futureSchemaRoot = path.join(root, 'storage-schema-future');
    fs.mkdirSync(futureSchemaRoot, { recursive: true });
    fs.writeFileSync(path.join(futureSchemaRoot, 'storage-version.json'), JSON.stringify({
      format: 'tether-storage', schemaVersion: CURRENT_STORAGE_VERSION + 1,
    }));
    assert.throws(
      () => inspectStorageSchema(futureSchemaRoot),
      (error) => error.code === 'TETHER_STORAGE_VERSION_NEWER',
    );

    const backupStorageRoot = path.join(root, 'backup-source');
    ensureRuntimeStorageSchema(backupStorageRoot, { agentId: 'agent' });
    const backupMemoryRoot = path.join(backupStorageRoot, 'memory');
    fs.mkdirSync(backupMemoryRoot, { recursive: true });
    const backupTranscript = Buffer.from(`${JSON.stringify({
      type: 'bootstrap',
      summaryHistory: [],
      rounds: [],
    })}\n`);
    fs.writeFileSync(path.join(backupMemoryRoot, 'transcript.jsonl'), backupTranscript);
    fs.writeFileSync(path.join(backupMemoryRoot, 'history.json'), JSON.stringify({
      summaryHistory: [], rounds: [],
    }));
    const backupSession = {
      schemaVersion: 1,
      agentId: 'agent',
      sessionId: 'backup-session',
      createdAt: '2030-01-01T00:00:00.000Z',
      memoryProof: {
        schemaVersion: 1,
        transcriptBytes: backupTranscript.length,
        transcriptSha256: crypto.createHash('sha256').update(backupTranscript).digest('hex'),
        memorySourceCount: 0,
      },
    };
    fs.writeFileSync(path.join(backupStorageRoot, 'session.json'), JSON.stringify(backupSession));
    const backupCausal = new CausalJournal({ directory: backupMemoryRoot });
    const backupInput = backupCausal.prepareInput({
      sessionId: 'backup-session',
      channelId: 'terminal',
      messageId: 'backup-message',
      text: 'backup causal record',
    });
    backupCausal.markInferenceStarted(backupInput.causalId);
    backupCausal.commitOutput(backupInput.causalId, { text: 'backed up', providerId: 'offline' });
    const backupToolJournal = new ToolJournal({ directory: path.join(backupStorageRoot, 'tools') });
    backupToolJournal.beginTransaction('backup-tool-causal', 'backup-tool-request');
    backupToolJournal.recordTransaction('backup-tool-causal', 'request-started', {
      iteration: 0, providerIndex: 0, providerId: 'offline',
    });
    backupToolJournal.recordTransaction('backup-tool-causal', 'provider-step', {
      iteration: 0,
      providerIndex: 0,
      providerId: 'offline',
      message: { role: 'assistant', content: 'backup tool final' },
      result: { text: 'backup tool final', providerId: 'offline' },
    });
    backupToolJournal.recordTransaction('backup-tool-causal', 'final', {
      result: { text: 'backup tool final', providerId: 'offline' },
    });
    const backupInbox = new DurableInbox({
      filePath: path.join(backupStorageRoot, 'telegram-inbox.jsonl'),
      maxAttempts: 1,
      log: () => {},
    });
    const deadLetterUpdate = {
      update_id: 501,
      message: {
        message_id: 51,
        text: 'dead letter payload',
        chat: { id: 5, type: 'private' },
      },
    };
    backupInbox.receive(deadLetterUpdate);
    backupInbox.markProcessing(501);
    backupInbox.markFailed(501, new Error('synthetic permanent failure'));
    assert.equal(backupInbox.status().deadLetters, 1);
    assert.equal(backupInbox.inventory({ states: 'dead-letter' })[0].textPreview, 'dead letter payload');
    assert.equal(backupInbox.inspect(501).update.message.text, 'dead letter payload');
    backupInbox.requeueDeadLetter(501, 'synthetic review approved');
    backupInbox.markProcessing(501, true);
    backupInbox.markOperatorPaused(501, new Error('synthetic ambiguous delivery'));
    assert.equal(backupInbox.status().operatorPaused, 1);
    backupInbox.append({ state: 'failed', updateId: 999, attempts: 1 });
    assert.equal(backupInbox.status().unrecoverableOrphans, 1);
    backupInbox.archiveUnrecoverableOrphan(999, 'synthetic original unavailable');
    assert.equal(backupInbox.status().unrecoverableOrphans, 0);
    backupInbox.append({ state: 'dead-letter', updateId: 1000, attempts: 6 });
    assert.equal(backupInbox.status().unrecoverableOrphans, 1);
    backupInbox.archiveUnrecoverableOrphan(1000, 'synthetic dead-letter original unavailable');
    assert.equal(backupInbox.status().unrecoverableOrphans, 0);
    const attachmentDirectory = path.join(backupStorageRoot, 'telegram-attachments');
    fs.mkdirSync(attachmentDirectory, { recursive: true });
    fs.writeFileSync(path.join(attachmentDirectory, 'user-file.json'), Buffer.from([0xff, 0x00, 0x01]));
    fs.writeFileSync(path.join(backupStorageRoot, 'runtime-health.json'), '{"ephemeral":true}\n');
    fs.writeFileSync(path.join(backupStorageRoot, 'runtime-health.json.tmp-interrupted'), 'partial');
    fs.writeFileSync(path.join(backupStorageRoot, '.tether-tool-journal.lock'), JSON.stringify({
      pid: 999_999_999, token: 'stale-synthetic-token', acquiredAt: '2030-01-01T00:00:00.000Z',
    }));
    const backupDestination = path.join(root, 'backups');
    const createdBackup = createBackup({
      storageRoot: backupStorageRoot,
      destinationRoot: backupDestination,
      agentId: 'agent',
      clock: () => '2030-01-02T03:04:05.000Z',
    });
    assert.equal(createdBackup.manifest.files.some((entry) => entry.path === 'runtime-health.json'), false);
    assert.equal(createdBackup.manifest.files.some((entry) => entry.path.includes('runtime-health.json.tmp-')), false);
    assert.equal(createdBackup.manifest.files.some((entry) => entry.path === '.tether-tool-journal.lock'), false);
    assert.equal(verifyBackup(createdBackup.backupPath).passed, true);
    assert.throws(
      () => verifyBackup(createdBackup.backupPath, { expectedAgentId: 'different-agent' }),
      (error) => error.code === 'TETHER_BACKUP_AGENT_MISMATCH',
    );
    fs.writeFileSync(path.join(createdBackup.backupPath, 'unexpected.txt'), 'unexpected');
    assert.throws(
      () => verifyBackup(createdBackup.backupPath),
      (error) => error.code === 'TETHER_BACKUP_EXTRA_FILE',
    );
    fs.unlinkSync(path.join(createdBackup.backupPath, 'unexpected.txt'));
    assert.throws(
      () => createBackup({
        storageRoot: backupStorageRoot,
        destinationRoot: path.join(backupStorageRoot, 'nested-backups'),
        agentId: 'agent',
      }),
      (error) => error.code === 'TETHER_BACKUP_DESTINATION_INVALID',
    );
    const backupSourceAlias = path.join(root, 'backup-source-alias');
    fs.symlinkSync(backupStorageRoot, backupSourceAlias, 'dir');
    assert.throws(
      () => createBackup({
        storageRoot: backupStorageRoot,
        destinationRoot: path.join(backupSourceAlias, 'physical-nested-backups'),
        agentId: 'agent',
      }),
      (error) => error.code === 'TETHER_BACKUP_DESTINATION_INVALID',
    );
    assert.equal(fs.existsSync(path.join(backupStorageRoot, 'physical-nested-backups')), false);
    const restoredStorageRoot = path.join(root, 'backup-restored');
    const restoredBackup = restoreBackup({
      backupPath: createdBackup.backupPath,
      storageRoot: restoredStorageRoot,
      clock: () => '2030-01-02T04:05:06.000Z',
    });
    assert.equal(restoredBackup.restored, true);
    assert.equal(inspectStorageSchema(restoredStorageRoot).status, 'current');
    assert.deepEqual(
      fs.readFileSync(path.join(restoredStorageRoot, 'session.json')),
      fs.readFileSync(path.join(backupStorageRoot, 'session.json')),
    );
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(restoredStorageRoot, '.tether-restore-receipt.json'),
        'utf8',
      )).state,
      'completed',
    );
    assert.equal(restoreBackup({
      backupPath: createdBackup.backupPath,
      storageRoot: restoredStorageRoot,
    }).replayed, true);
    const partialRestoreRoot = path.join(root, 'backup-partial-restore');
    fs.mkdirSync(partialRestoreRoot, { recursive: true });
    fs.writeFileSync(path.join(partialRestoreRoot, '.tether-restore-receipt.json'), JSON.stringify({
      schemaVersion: 1,
      state: 'prepared',
      backupRootSha256: createdBackup.manifest.rootSha256,
      preparedAt: '2030-01-02T04:00:00.000Z',
    }));
    fs.copyFileSync(
      path.join(createdBackup.backupPath, 'data', 'storage-version.json'),
      path.join(partialRestoreRoot, 'storage-version.json'),
    );
    const restoreWorkRoot = path.join(partialRestoreRoot, '.tether-restore-work');
    fs.mkdirSync(restoreWorkRoot);
    fs.writeFileSync(path.join(
      restoreWorkRoot,
      `${crypto.createHash('sha256').update('memory/history.json').digest('hex')}.partial`,
    ), 'interrupted-copy');
    assert.equal(restoreBackup({
      backupPath: createdBackup.backupPath,
      storageRoot: partialRestoreRoot,
    }).replayed, false);
    assert.deepEqual(
      fs.readFileSync(path.join(partialRestoreRoot, 'session.json')),
      fs.readFileSync(path.join(backupStorageRoot, 'session.json')),
    );
    const opsConfigPath = path.join(root, 'ops-config.json');
    fs.writeFileSync(opsConfigPath, JSON.stringify({
      agent: { id: 'agent', displayName: 'Agent' },
      owner: { entityId: 'owner', displayName: 'Owner' },
      persona: { inlinePolicy: 'Synthetic operations policy.' },
      storage: { root: backupStorageRoot },
      providers: [{
        id: 'offline',
        label: 'Offline',
        adapter: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
        authentication: 'none',
        model: 'offline-model',
      }],
    }));
    assert.equal(runOpsCommand(['status', opsConfigPath]).storage.status, 'current');
    assert.equal(runOpsCommand(['dead-letters', opsConfigPath])[0].state, 'operator-paused');
    assert.equal(runOpsCommand(['inspect', '501', opsConfigPath]).update.update_id, 501);
    const heldSupervisorLock = acquireInstanceLock(path.join(
      backupStorageRoot,
      '.tether-supervisor.lock',
    ));
    assert.throws(
      () => runOpsCommand(['migrate', opsConfigPath]),
      (error) => error.code === 'TETHER_INSTANCE_LOCKED',
    );
    await assert.rejects(
      () => runMemoryCommand({ command: 'status', configPath: opsConfigPath }),
      (error) => error.code === 'TETHER_INSTANCE_LOCKED',
    );
    heldSupervisorLock.release();
    const heldRuntimeLock = acquireInstanceLock(path.join(
      backupStorageRoot,
      '.tether-instance.lock',
    ));
    await assert.rejects(
      () => runMemoryCommand({ command: 'status', configPath: opsConfigPath }),
      (error) => error.code === 'TETHER_INSTANCE_LOCKED',
    );
    assert.equal(
      fs.existsSync(path.join(backupStorageRoot, '.tether-supervisor.lock')),
      false,
    );
    heldRuntimeLock.release();
    assert.equal(runOpsCommand(['resume', '501', opsConfigPath]).state, 'received');
    const opsInbox = new DurableInbox({
      filePath: path.join(backupStorageRoot, 'telegram-inbox.jsonl'),
      log: () => {},
    });
    opsInbox.markProcessing(501, true);
    opsInbox.markDone(501);
    assert.throws(
      () => runOpsCommand(['requeue-done', '501', opsConfigPath]),
      /Usage:/,
    );
    assert.equal(runOpsCommand([
      'requeue-done', '501', '--confirm-redeliver', opsConfigPath,
    ]).state, 'received');
    const tamperedBackupTranscript = path.join(
      createdBackup.backupPath,
      'data',
      'memory',
      'transcript.jsonl',
    );
    fs.appendFileSync(tamperedBackupTranscript, '{"tampered":true}\n');
    assert.throws(
      () => verifyBackup(createdBackup.backupPath),
      (error) => error.code === 'TETHER_BACKUP_HASH_MISMATCH',
    );

    let healthNow = Date.parse('2030-02-01T00:00:00.000Z');
    let heartbeatCallback = null;
    let heartbeatCleared = false;
    const healthFile = path.join(root, 'health', 'runtime-health.json');
    const healthReporter = new RuntimeHealthReporter({
      filePath: healthFile,
      runId: 'health-run',
      pid: process.pid,
      intervalMs: 5_000,
      clock: () => new Date(healthNow).toISOString(),
      setIntervalImpl(callback) {
        heartbeatCallback = callback;
        return { unref() {} };
      },
      clearIntervalImpl() { heartbeatCleared = true; },
    });
    healthReporter.start({ agentId: 'agent', storageSchemaVersion: 1 });
    healthReporter.ready({ sessionId: 'health-session' });
    healthReporter.noteActivity({ channelId: 'telegram' });
    healthReporter.noteMaintenance({ state: 'healthy', consecutiveFailures: 0 });
    heartbeatCallback();
    const availableHealth = readRuntimeHealth(healthFile);
    assert.equal(availableHealth.status, 'available');
    assert.equal(availableHealth.record.sessionAnchorSha256.length, 64);
    assert.equal(evaluateRuntimeHealth(availableHealth, {
      expectedRunId: 'health-run',
      now: healthNow,
      spawnedAt: healthNow - 1_000,
      readyTimeoutMs: 60_000,
      staleAfterMs: 30_000,
    }).action, 'healthy');
    healthNow += 31_000;
    assert.equal(evaluateRuntimeHealth(availableHealth, {
      expectedRunId: 'health-run',
      now: healthNow,
      spawnedAt: healthNow - 32_000,
      readyTimeoutMs: 60_000,
      staleAfterMs: 30_000,
    }).reason, 'heartbeat-stale');
    healthReporter.fatal(Object.assign(new Error('synthetic fatal'), { code: 'SYNTHETIC_FATAL' }));
    assert.equal(readRuntimeHealth(healthFile).record.state, 'fatal');
    healthReporter.stop();
    assert.equal(heartbeatCleared, true);
    assert.equal(readRuntimeHealth(healthFile).record.state, 'fatal');
    assert.equal(evaluateRuntimeHealth({ status: 'missing', record: null }, {
      now: 100_000,
      spawnedAt: 0,
      readyTimeoutMs: 10_000,
    }).reason, 'health-missing');
    assert.equal(evaluateRuntimeHealth({
      status: 'available',
      record: { state: 'ready', runId: 'old', updatedAt: new Date(100_000).toISOString() },
    }, {
      expectedRunId: 'new', now: 100_000, spawnedAt: 0, readyTimeoutMs: 10_000,
    }).reason, 'health-run-mismatch');
    assert.equal(restartDelay(1, { baseMs: 1_000, maxMs: 5_000, random: () => 0.5 }), 1_000);
    assert.equal(restartDelay(20, { baseMs: 1_000, maxMs: 5_000, random: () => 1 }), 5_000);
    const restartBudget = new RestartBudget({ maxRestarts: 2, windowMs: 10_000 });
    assert.equal(restartBudget.record(1_000).allowed, true);
    assert.equal(restartBudget.record(2_000).allowed, true);
    assert.equal(restartBudget.record(3_000).allowed, false);
    assert.equal(restartBudget.record(20_000).allowed, true);
    const { EventEmitter } = require('node:events');
    const supervisorRoot = path.join(root, 'supervisor-runtime');
    let supervisorMonitor = null;
    let spawnedCommand = null;
    let spawnedArguments = null;
    let spawnedOptions = null;
    const childSignals = [];
    class FakeChild extends EventEmitter {
      kill(signal) {
        childSignals.push(signal);
        queueMicrotask(() => this.emit('exit', 0, signal));
        return true;
      }
    }
    const tetherSupervisor = new TetherSupervisor({
      configPath: path.join(root, 'synthetic-supervisor-config.json'),
      storageRoot: supervisorRoot,
      settings: {
        monitorIntervalMs: 5_000,
        heartbeatStaleMs: 30_000,
        readyTimeoutMs: 60_000,
        shutdownGraceMs: 15_000,
      },
      spawnImpl(command, args, options) {
        spawnedCommand = command;
        spawnedArguments = args;
        spawnedOptions = options;
        return new FakeChild();
      },
      setIntervalImpl(callback) {
        supervisorMonitor = callback;
        return { unref() {} };
      },
      clearIntervalImpl() {},
      setTimeoutImpl(callback, delay) { return { callback, delay, unref() {} }; },
      clearTimeoutImpl() {},
      log: () => {},
      installSignalHandlers: false,
    });
    const supervisorCompletion = tetherSupervisor.start();
    assert.equal(spawnedCommand, process.execPath);
    assert.equal(spawnedArguments.at(-1), path.join(root, 'synthetic-supervisor-config.json'));
    assert.equal(spawnedOptions.env.TETHER_SUPERVISOR_RUN_ID, tetherSupervisor.runId);
    assert.equal(spawnedOptions.env.TETHER_SUPERVISOR_PID, String(process.pid));
    assert.equal(spawnedOptions.env.TETHER_SUPERVISOR_TOKEN, tetherSupervisor.lock.token);
    fs.writeFileSync(path.join(supervisorRoot, 'runtime-health.json'), JSON.stringify({
      schemaVersion: 1,
      runId: tetherSupervisor.runId,
      pid: 123,
      state: 'ready',
      startedAt: new Date(tetherSupervisor.spawnedAt).toISOString(),
      updatedAt: new Date(tetherSupervisor.spawnedAt).toISOString(),
    }));
    supervisorMonitor();
    assert.deepEqual(childSignals, []);
    tetherSupervisor.stop('SIGTERM');
    await supervisorCompletion;
    assert.deepEqual(childSignals, ['SIGTERM']);
    assert.equal(fs.existsSync(path.join(supervisorRoot, '.tether-supervisor.lock')), false);

    const lockRoot = path.join(root, 'lock-test');
    fs.mkdirSync(lockRoot);
    fs.writeFileSync(path.join(lockRoot, 'a.txt'), 'alpha');
    const digest = require('node:crypto').createHash('sha256').update('alpha').digest('hex');
    assert.deepEqual(verifyFileLock(lockRoot, [{ path: 'a.txt', sha256: digest, size: 5 }]), []);
    fs.writeFileSync(path.join(lockRoot, 'a.txt'), 'omega');
    assert.ok(verifyFileLock(lockRoot, [{ path: 'a.txt', sha256: digest, size: 5 }]).length > 0);
    assert.ok(verifyFileLock(lockRoot, [{ path: '../escape', sha256: digest, size: 5 }]).length > 0);
    assert.deepEqual(
      findStaleManagedPaths([{ path: 'kept.txt' }, { path: 'stale.txt' }], ['kept.txt']),
      ['stale.txt'],
      'an allowlist removal must not leave a previously managed public file behind silently',
    );

    const scheduled = [];
    const maintenanceStates = [];
    let supervisorRuns = 0;
    const supervisor = new MemoryMaintenanceSupervisor({
      memory: {
        async maintainOne() {
          supervisorRuns += 1;
          return { status: 'completed', semantic: { status: 'generated' }, cards: { status: 'idle' } };
        },
      },
      idleIntervalMs: 5_000,
      activeDelayMs: 10,
      setTimer(callback, delay) {
        const timer = { callback, delay, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearTimer() {},
      log: () => {},
      onState: (record) => maintenanceStates.push(record.state),
    });
    assert.equal(supervisor.start(), true);
    assert.equal(scheduled.at(-1).delay, 0);
    await supervisor._cycle();
    assert.equal(supervisorRuns, 1);
    assert(maintenanceStates.includes('running'));
    assert(maintenanceStates.includes('healthy'));
    assert.equal(scheduled.at(-1).delay, 10);
    assert.equal(resultDidWork({ semantic: { status: 'generated' } }), true);
    assert.equal(supervisor.stop(), true);

    const instanceLockPath = path.join(root, 'single-writer', '.tether-instance.lock');
    const firstLock = acquireInstanceLock(instanceLockPath);
    assert.throws(
      () => acquireInstanceLock(instanceLockPath),
      (error) => error.code === 'TETHER_INSTANCE_LOCKED',
    );
    assert.equal(firstLock.release(), true);
    const restartedLock = acquireInstanceLock(instanceLockPath);
    assert.equal(restartedLock.release(), true, 'storage lock must be reusable after an orderly release');

    assert.throws(
      () => new CausalJournal({ directory: (() => {
        const directory = path.join(root, 'corrupt-causal');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'causal-journal.jsonl'), '{"torn":');
        return directory;
      })() }),
      (error) => error.code === 'TETHER_CAUSAL_CORRUPT',
    );

    process.stdout.write('Tether offline suite: PASS (causal, selfsame, memory, semantic, durable, dual-channel, provider, export-lock)\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.stderr.write('Tether offline suite: FAIL\n');
  process.exitCode = 1;
});
