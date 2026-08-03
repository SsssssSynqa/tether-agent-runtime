// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppendOnlyMemory } = require('../runtime/memory/append-only-memory.cjs');
const {
  SelfsameContinuityError,
  SelfsameSession,
  atomicWriteJson,
} = require('../runtime/selfsame-session.cjs');
const { TetherRuntime } = require('../runtime/tether-runtime.cjs');
const { createMemoryChannel } = require('../runtime/channels/memory-channel.cjs');
const { createOpenAICompatibleProvider } = require('../runtime/providers/openai-compatible.cjs');
const { validateMemoryBundle } = require('../runtime/semantic/semantic-memory-validators.js');
const { SemanticMemoryStore } = require('../runtime/semantic/semantic-memory-store.js');
const { DurableInbox } = require('../runtime/durable/durable-inbox.js');
const { sendWithGroupRateLimit } = require('../lib/telegram/group-rate-limit.cjs');
const {
  createFileOffsetStore,
  createTelegramApi,
  createTelegramChannel,
  normalizeTelegramUpdate,
} = require('../runtime/channels/telegram.cjs');
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
    const exampleConfig = loadTetherConfig(path.join(__dirname, '..', 'config.example.json'), {
      privateOverlayPath: path.join(root, 'missing-private-overlay.json'),
      env: { PRIMARY_API_KEY: 'synthetic-test-value' },
    });
    assert.equal(exampleConfig.agent.id, 'agent');
    assert.match(exampleConfig.persona.prompt, /same continuous agent/);
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
      () => loadTetherConfig(path.join(__dirname, '..', 'config.example.json'), {
        privateOverlayPath: path.join(root, 'missing-private-overlay.json'),
        env: {},
      }),
      /Missing required provider credential env/,
    );
    const configEnvelope = {
      agent: { id: 'agent', displayName: 'Agent' },
      owner: { entityId: 'owner' },
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

    const inboxPath = path.join(root, 'nested-durable', 'durable.jsonl');
    const inbox = new DurableInbox({ filePath: inboxPath, log: () => {} });
    assert.equal(inbox.receive({ update_id: 1, message: { chat: { id: 7, type: 'private' }, text: 'hello' } }), true);
    inbox.markProcessing(1);
    inbox.markDone(1);
    assert.equal(inbox.isDone(1), true);
    assert.equal(fs.statSync(path.dirname(inboxPath)).mode & 0o777, 0o700);

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
    assert.equal(normalized.messageId, 'telegram:update:8');
    assert.equal(normalized.metadata.updateKind, 'message');
    assert.equal(normalizeTelegramUpdate({
      update_id: 9,
      message: { message_id: 10, text: 'blocked', from: { id: 99 }, chat: { id: 12, type: 'private' } },
    }, { ownerIds: [11] }), null);

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
    assert.throws(
      () => createTelegramApi({ token: 'synthetic-token', apiBase: 'http://example.invalid' }),
      /https unless the host is loopback/,
    );
    assert.doesNotThrow(() => createTelegramApi({
      token: 'synthetic-token',
      apiBase: 'http://127.0.0.1:8081/',
      fetchImpl: async () => { throw new Error('not called'); },
    }));

    let requestedBody = null;
    const openAi = createOpenAICompatibleProvider({
      providers: [{ id: 'mock', label: 'Mock Provider', baseUrl: 'https://example.invalid/v1/chat/completions', model: 'mock-model' }],
      fetchImpl: async (_url, options) => {
        requestedBody = JSON.parse(options.body);
        return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'ok' } }] }; } };
      },
    });
    assert.equal((await openAi.respond({ messages: [{ role: 'user', content: 'offline' }] })).text, 'ok');
    assert.equal(requestedBody.model, 'mock-model');
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
  console.error(error.stack || error);
  process.exitCode = 1;
});
