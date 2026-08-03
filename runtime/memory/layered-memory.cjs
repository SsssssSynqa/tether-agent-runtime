// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// In the production source tree the canonical modules live at the repository
// root. In an exported Tether snapshot they are exact-byte siblings of this
// glue module. Resolve either layout without maintaining a second copy.
const localModuleRoot = fs.existsSync(path.join(__dirname, 'conversation-history.js'))
  ? __dirname
  : path.resolve(__dirname, '..', '..');
const {
  ConversationHistory,
  estimateTokens,
} = require(path.join(localModuleRoot, 'conversation-history.js'));
const { MemoryCardManager } = require(path.join(localModuleRoot, 'memory-card-manager.js'));
const { normalizeMemoryPolicy } = require(path.join(localModuleRoot, 'memory-policy.js'));

function memoryPolicyFromConfig({ agent = {}, owner = {}, addressPolicy = {}, memory = {} } = {}) {
  return normalizeMemoryPolicy({
    agent: {
      entityId: agent.id,
      displayName: agent.displayName,
    },
    owner: {
      entityId: owner.entityId,
      displayName: owner.displayName,
      disallowedDisplayNames: addressPolicy.disallowedOwnerNames || [],
      namingSubjects: memory.namingSubjects || [],
    },
    sourceLabels: memory.sourceLabels || {},
    time: memory.time || {},
    files: memory.files || {},
    records: memory.records || {},
    actors: memory.actors || {},
  });
}

function completionEnvelope(result) {
  return {
    choices: [{
      finish_reason: result?.finishReason || 'stop',
      message: { content: String(result?.text || '') },
    }],
  };
}

function fileHasBytes(filePath) {
  try { return fs.statSync(filePath).size > 0; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

class LayeredMemory {
  constructor({
    directory,
    provider,
    agent = {},
    owner = {},
    entities = [],
    addressPolicy = {},
    memory = {},
    log = console.log,
  } = {}) {
    if (!directory) throw new Error('LayeredMemory requires directory');
    if (typeof provider?.respond !== 'function') {
      throw new Error('LayeredMemory requires a provider adapter');
    }
    this.directory = path.resolve(directory);
    this.provider = provider;
    this.log = log;
    this.policy = memoryPolicyFromConfig({ agent, owner, addressPolicy, memory });
    this.entities = Array.isArray(entities) && entities.length
      ? entities
      : [
          { entityId: this.policy.owner.entityId, canonicalDisplayName: this.policy.owner.displayName },
          { entityId: this.policy.agent.entityId, canonicalDisplayName: this.policy.agent.displayName },
        ];
    this.foldLogDir = path.join(this.directory, this.policy.files.foldDirectory);
    const historyFile = path.join(this.directory, 'history.json');
    this.history = new ConversationHistory({
      historyFile,
      transcriptFile: path.join(this.directory, 'transcript.jsonl'),
      transcriptAssetDir: path.join(this.directory, 'transcript-assets'),
      tokenBudget: Number(memory.historyTokenBudget) || 10_000,
      roundsBudget: Number(memory.roundsBudget) || 30,
      hardTokenCap: Number(memory.hardTokenCap) || 150_000,
      activeSoftTokenWatermark: memory.activeSoftTokenWatermark ?? 36_000,
      activeTargetTokenWatermark: memory.activeTargetTokenWatermark ?? 24_000,
      roundHardLimit: Number(memory.roundHardLimit) || 120,
      minimumRawTailRounds: Number(memory.minimumRawTailRounds) || 8,
      summaryHistoryLimit: Number(memory.summaryHistoryLimit) || 64,
      foldSummaryMaxChars: Number(memory.foldSummaryMaxChars) || 1_500,
      memoryPolicy: this.policy,
      foldLogDir: this.foldLogDir,
      foldEntityDisplayNames: this.entities.map((entity) => entity.canonicalDisplayName),
      foldRequest: async (messages) => completionEnvelope(await this.provider.respond({
        messages,
        purpose: 'fold',
      })),
      log,
    });
    this.cards = new MemoryCardManager({
      history: this.history,
      foldLogDir: this.foldLogDir,
      directory: path.join(this.directory, 'cards'),
      generateCard: async (messages, metadata) => (await this.provider.respond({
        messages,
        purpose: 'memory-card',
        metadata,
      })).text,
      policy: memory.cards?.policy || 'lossless',
      autoGenerate: memory.cards?.enabled !== false,
      tokenBudget: Number(memory.contextTokenBudget) || 180_000,
      recentWeekCount: Number(memory.recentWeekCount) || 4,
      estimateTokens,
      memoryPolicy: this.policy,
      log,
    });
  }

  getData() { return this.history.getData(); }

  compile({ reservedTokens = 0, request = {} } = {}) {
    return this.cards.compile({ reservedTokens, request });
  }

  buildMessages({ personaPrompt = '', userText = '', request = {} } = {}) {
    const data = this.history.getData();
    const reservedTokens = estimateTokens(`${personaPrompt}\n${userText}`)
      + data.rounds.reduce(
        (total, round) => total
          + estimateTokens(round.user)
          + estimateTokens(round.assistant),
        0,
      );
    const compiled = this.compile({ reservedTokens, request });
    const memoryBlock = compiled.text
      ? `\n\n[Tether layered continuous memory]\n${compiled.text}`
      : '';
    const systemContent = `${String(personaPrompt || '')}${memoryBlock}`.trim();
    return {
      messages: [
        ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
        ...data.rounds.flatMap((round) => [
          { role: 'user', content: String(round.user || '') },
          { role: 'assistant', content: String(round.assistant || '') },
        ]),
        { role: 'user', content: String(userText || '') },
      ],
      compiled,
    };
  }

  appendTurn(userText, assistantText, metadata = {}) {
    return this.history.appendTurn(userText, assistantText, metadata);
  }

  async ensureTurn(userText, assistantText, metadata = {}) {
    const causalIds = Array.isArray(metadata.causalIds) ? metadata.causalIds.map(String) : [];
    const existing = this.history.findTurnByCausalIds(causalIds);
    if (existing) {
      await this.history.restoreUncommittedTurn(existing);
      return { duplicate: true, entry: existing };
    }
    await this.history.appendTurn(userText, assistantText, metadata);
    return { duplicate: false };
  }

  maintainOne() { return this.cards.maintainOne(); }

  sessionProof() {
    return { passed: true, errors: [], proof: this.history.transcriptProof() };
  }

  verifySession(_sessionId, { expectedProof = null } = {}) {
    return this.history.verifyTranscriptProof(expectedProof);
  }

  hasExistingAuthority() {
    if (this.history.hasDurableAuthority()) return true;
    return [
      path.join(this.directory, 'causal-journal.jsonl'),
      path.join(this.directory, 'cards', 'cards.jsonl'),
      path.join(this.directory, 'cards', 'human-overrides.jsonl'),
      // Files from the pre-layered public preview must block silent creation;
      // the migration command handles them explicitly instead.
      path.join(this.directory, 'summaries.jsonl'),
    ].some(fileHasBytes);
  }

  messageView({ sessionId, channelId, messageId, role, text, metadata = {} }) {
    return {
      schemaVersion: 1,
      messageId: String(messageId),
      sessionId: String(sessionId),
      channelId: String(channelId),
      role,
      text: String(text || ''),
      textSha256: crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex'),
      metadata: structuredClone(metadata || {}),
    };
  }

  close() { this.history.close(); }
}

module.exports = {
  LayeredMemory,
  completionEnvelope,
  memoryPolicyFromConfig,
};
