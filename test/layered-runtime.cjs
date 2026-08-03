#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryChannel } = require('../runtime/channels/memory-channel.cjs');
const { LayeredMemory } = require('../runtime/memory/layered-memory.cjs');
const { SelfsameSession } = require('../runtime/selfsame-session.cjs');
const { TetherRuntime } = require('../runtime/tether-runtime.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-layered-runtime-'));
  try {
    const calls = [];
    const provider = {
      async respond({ messages, purpose = 'chat' }) {
        calls.push({ purpose, messages: structuredClone(messages) });
        if (purpose === 'fold') {
          return {
            text: 'Rin asked for continuity and Archivist preserved the completed turn.\n未收尾：无',
            providerId: 'offline-fold',
          };
        }
        if (purpose === 'memory-card') {
          return { text: 'Rin and Archivist retained the evidence.', providerId: 'offline-card' };
        }
        const user = messages.filter((message) => message.role === 'user').at(-1);
        return { text: `reply:${user.content}`, providerId: 'offline-chat' };
      },
    };
    const memoryDirectory = path.join(root, 'memory');
    const memoryOptions = {
      directory: memoryDirectory,
      provider,
      agent: { id: 'archivist', displayName: 'Archivist' },
      owner: { entityId: 'rin', displayName: 'Rin' },
      entities: [
        { entityId: 'rin', canonicalDisplayName: 'Rin', type: 'person' },
        { entityId: 'archivist', canonicalDisplayName: 'Archivist', type: 'ai' },
      ],
      memory: {
        activeSoftTokenWatermark: 12,
        activeTargetTokenWatermark: 6,
        minimumRawTailRounds: 1,
        roundsBudget: 1,
        cards: { enabled: true, policy: 'lossless' },
      },
      log: () => {},
    };
    const memory = new LayeredMemory(memoryOptions);
    const stateFile = path.join(root, 'session.json');
    const session = new SelfsameSession({
      stateFile,
      agentId: 'archivist',
      createSession: async () => 'one-continuous-session',
      resumeSession: async (sessionId, stored) => memory.verifySession(sessionId, {
        expectedProof: stored.memoryProof || null,
      }).passed,
      canCreateSession: async () => !memory.hasExistingAuthority(),
    });
    await session.open({ allowCreate: true });
    const terminal = createMemoryChannel('terminal');
    const telegram = createMemoryChannel('telegram');
    const runtime = new TetherRuntime({
      session,
      memory,
      provider,
      personaPrompt: 'Remain the same Archivist across every channel.',
      log: () => {},
    }).attach(terminal).attach(telegram);

    const firstInput = { messageId: 'terminal:1', text: 'first', metadata: { trustZone: 'dm' } };
    const first = await terminal.receive(firstInput);
    const duplicate = await terminal.receive(firstInput);
    assert.equal(duplicate.outputId, first.outputId);
    assert.equal(duplicate.replayed, true);
    assert.equal(calls.filter((call) => call.purpose === 'chat').length, 1);

    await telegram.receive({ messageId: 'telegram:1', text: 'second', metadata: { trustZone: 'dm' } });
    await terminal.receive({ messageId: 'terminal:2', text: 'third', metadata: { trustZone: 'dm' } });
    const chatCalls = calls.filter((call) => call.purpose === 'chat');
    assert.equal(chatCalls.length, 3);
    assert(chatCalls[1].messages.some((message) => message.content === 'first'));
    assert(chatCalls[1].messages.some((message) => message.content === 'reply:first'));
    assert(calls.some((call) => call.purpose === 'fold'));

    const transcript = fs.readFileSync(path.join(memoryDirectory, 'transcript.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(transcript[0].type, 'bootstrap');
    assert.equal(transcript.filter((entry) => entry.type === 'turn').length, 3);
    assert.equal(transcript.some((entry) => entry.user === 'first' && entry.assistant === 'reply:first'), true);
    const causal = fs.readFileSync(path.join(memoryDirectory, 'causal-journal.jsonl'), 'utf8');
    assert(causal.includes('"text":"first"'));
    assert.equal(memory.history.transcriptProof().memorySourceCount, 3);
    const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(memory.verifySession(stored.sessionId, { expectedProof: stored.memoryProof }).passed, true);
    memory.close();

    const resumedMemory = new LayeredMemory(memoryOptions);
    const resumedSession = new SelfsameSession({
      stateFile,
      agentId: 'archivist',
      createSession: async () => 'forbidden-replacement',
      resumeSession: async (sessionId, anchor) => resumedMemory.verifySession(sessionId, {
        expectedProof: anchor.memoryProof,
      }).passed,
    });
    assert.equal((await resumedSession.open()).sessionId, 'one-continuous-session');
    resumedMemory.close();
    process.stdout.write('public layered runtime: pass\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
