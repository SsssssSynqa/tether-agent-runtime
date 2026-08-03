#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { loadTetherConfig } = require('../runtime/config-loader.cjs');
const { AppendOnlyMemory } = require('../runtime/memory/append-only-memory.cjs');
const { acquireInstanceLock } = require('../runtime/instance-lock.cjs');
const { SelfsameSession } = require('../runtime/selfsame-session.cjs');
const { TetherRuntime } = require('../runtime/tether-runtime.cjs');
const { createTerminalChannel } = require('../runtime/channels/terminal.cjs');
const {
  createFileOffsetStore,
  createTelegramApi,
  createTelegramChannel,
} = require('../runtime/channels/telegram.cjs');
const { createOpenAICompatibleProvider } = require('../runtime/providers/openai-compatible.cjs');

let instanceLock = null;

function releaseInstanceLock() {
  try { instanceLock?.release(); } catch (_) { /* process shutdown is best effort */ }
  instanceLock = null;
}

async function main() {
  const configPath = process.argv[2] || './config.json';
  const config = loadTetherConfig(configPath);
  instanceLock = acquireInstanceLock(path.join(config.storage.root, '.tether-instance.lock'));
  process.once('exit', releaseInstanceLock);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      releaseInstanceLock();
      process.exit(0);
    });
  }
  const memory = new AppendOnlyMemory({ directory: path.join(config.storage.root, 'memory') });
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
  const providers = config.providers
    .filter((provider) => provider.adapter === 'openai-compatible')
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      headers: provider.headers,
      timeoutMs: provider.timeoutMs,
    }));
  const provider = createOpenAICompatibleProvider({ providers });
  const terminal = createTerminalChannel();
  const runtime = new TetherRuntime({
    session,
    memory,
    provider,
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
    });
    runtime.attach(telegram);
    telegram.start().catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
  }
  terminal.start();
}

main().catch((error) => {
  releaseInstanceLock();
  console.error(error.stack || error);
  process.exitCode = 1;
});
