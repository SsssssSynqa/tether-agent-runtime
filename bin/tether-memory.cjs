#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const path = require('node:path');
const { loadTetherConfig } = require('../runtime/config-loader.cjs');
const { acquireInstanceLock } = require('../runtime/instance-lock.cjs');
const { LayeredMemory } = require('../runtime/memory/layered-memory.cjs');
const { createOpenAICompatibleProvider } = require('../runtime/providers/openai-compatible.cjs');

function configuredProviders(config) {
  return config.providers
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
      imageInput: provider.imageInput,
      maxImageParts: provider.maxImageParts,
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
}

function usage() {
  return [
    'Usage: tether-memory <status|rebuild-semantic|backfill-vectors> [config.json]',
    '',
    'The command acquires the same storage lock as the runtime. Stop the runtime',
    'before running a maintenance write; concurrent mutation is refused.',
  ].join('\n');
}

async function runMemoryCommand({ command, configPath = './config.json' } = {}) {
  if (!['status', 'rebuild-semantic', 'backfill-vectors'].includes(command)) {
    const error = new Error(usage());
    error.code = 'TETHER_MEMORY_USAGE';
    throw error;
  }
  const config = loadTetherConfig(configPath);
  const lock = acquireInstanceLock(path.join(config.storage.root, '.tether-instance.lock'));
  let memory = null;
  try {
    const provider = createOpenAICompatibleProvider({
      providers: configuredProviders(config),
    });
    memory = new LayeredMemory({
      directory: path.join(config.storage.root, 'memory'),
      provider,
      agent: config.agent,
      owner: config.owner,
      entities: config.entities,
      addressPolicy: config.addressPolicy,
      memory: config.memory,
    });
    if (command === 'status') return memory.status();
    if (command === 'rebuild-semantic') {
      return memory.rebuildSemanticQueue({ queueClass: 'rebuild-priority' });
    }
    return memory.backfillVectors();
  } finally {
    try { memory?.close(); } finally { lock.release(); }
  }
}

async function main() {
  const command = process.argv[2];
  const configPath = process.argv[3] || './config.json';
  const result = await runMemoryCommand({ command, configPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === 'TETHER_MEMORY_USAGE' ? 2 : 1;
  });
}

module.exports = { configuredProviders, runMemoryCommand, usage };
