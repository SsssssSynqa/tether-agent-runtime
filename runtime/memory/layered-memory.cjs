// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

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
const {
  createSemanticMemoryModelAdapter,
  EXTRACTOR_PROMPT_VERSION,
} = require(path.join(localModuleRoot, 'semantic-memory-model-adapter.js'));
const {
  SemanticMemoryManager,
  projectionText,
} = require(path.join(localModuleRoot, 'semantic-memory-manager.js'));
const { VectorMemoryIndex } = require('./vector-memory.cjs');

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
      semanticDisallowedDisplayNames: addressPolicy.semanticDisallowedOwnerNames
        || addressPolicy.disallowedOwnerNames
        || [],
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

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizedEntities({ entities = [], policy, owner = {}, agent = {} }) {
  const byId = new Map((entities || [])
    .filter((entity) => entity?.entityId)
    .map((entity) => [String(entity.entityId), { ...entity, entityId: String(entity.entityId) }]));
  const mergeIdentity = (identity, source, type) => {
    const prior = byId.get(identity.entityId) || {};
    byId.set(identity.entityId, {
      ...prior,
      entityId: identity.entityId,
      canonicalDisplayName: String(
        prior.canonicalDisplayName || identity.displayName || identity.entityId,
      ),
      type: prior.type || type,
      telegramUserIds: uniqueStrings([
        ...(prior.telegramUserIds || []),
        ...(source.telegramUserIds || []),
      ]),
      botDisplayNames: uniqueStrings([
        ...(prior.botDisplayNames || []),
        ...(source.botDisplayNames || []),
      ]),
      aliasDisplayNames: uniqueStrings(prior.aliasDisplayNames || []),
    });
  };
  mergeIdentity(policy.owner, owner, 'person');
  mergeIdentity(policy.agent, agent, 'ai');
  return [...byId.values()];
}

function validIsoTimestamp(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
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
    this._maintenance = null;
    this.policy = memoryPolicyFromConfig({ agent, owner, addressPolicy, memory });
    this.entities = normalizedEntities({
      entities: Array.isArray(entities) ? entities : [],
      policy: this.policy,
      owner,
      agent,
    });
    this.foldLogDir = path.join(this.directory, this.policy.files.foldDirectory);
    const historyFile = path.join(this.directory, 'history.json');
    const semantic = memory.semantic || {};
    this.semanticMode = String(semantic.mode || 'cards');
    this.semantic = null;
    if (this.semanticMode !== 'off') {
      const adapter = createSemanticMemoryModelAdapter({
        memoryPolicy: this.policy,
        completeExtractor: async (messages, metadata = {}) => completionEnvelope(
          await this.provider.respond({
            messages,
            purpose: metadata.reason === 'no-signal-audit'
              ? 'semantic-extract-audit'
              : metadata.repair
                ? 'semantic-extract-repair'
                : 'semantic-extract',
            metadata,
          }),
        ),
        completeVerifier: async (messages) => completionEnvelope(
          await this.provider.respond({ messages, purpose: 'semantic-verify' }),
        ),
        completeHighRisk: async (messages) => completionEnvelope(
          await this.provider.respond({ messages, purpose: 'semantic-high-risk' }),
        ),
      });
      this.semantic = new SemanticMemoryManager({
        directory: path.join(this.directory, 'semantic'),
        mode: this.semanticMode,
        memoryPolicy: this.policy,
        entities: this.entities,
        extract: adapter.extract,
        verify: adapter.verify,
        verifyHighRisk: adapter.verifyHighRisk,
        extractorModel: String(semantic.extractorModelLabel || 'provider:semantic-extract'),
        extractorPromptVersion: EXTRACTOR_PROMPT_VERSION,
        recentWeekCount: Number(memory.recentWeekCount) || 4,
        contextTokenBudget: Number(memory.contextTokenBudget) || 180_000,
        manifestMaxRecords: Number(semantic.manifestMaxRecords) || 50,
        manifestMaxBytes: Number(semantic.manifestMaxBytes) || 8 * 1024 * 1024,
        estimateTokens,
        log,
      });
    }
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
      semanticMemoryMode: this.semanticMode,
      semanticFold: this.semantic?.effectiveVerifiedFold()
        ? (rounds) => this.semantic.foldRounds(rounds)
        : null,
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
    const embeddingOptions = semantic.embeddings || {};
    this.vectors = new VectorMemoryIndex({
      directory: path.join(this.directory, 'semantic'),
      embed: typeof this.provider.embed === 'function'
        ? (request) => this.provider.embed(request)
        : null,
      enabled: embeddingOptions.enabled === true,
      batchSize: embeddingOptions.batchSize,
      topK: embeddingOptions.topK,
      minScore: embeddingOptions.minScore,
      maxEmbeddingChars: embeddingOptions.maxEmbeddingChars,
      maxRetrievedChars: embeddingOptions.maxRetrievedChars,
      maxBytes: embeddingOptions.maxBytes,
      log,
    });
  }

  getData() { return this.history.getData(); }

  compile({ reservedTokens = 0, request = {} } = {}) {
    const archive = this.cards.compile({ reservedTokens, request });
    if (!this.semantic?.effectiveCards()) return archive;
    return this.semantic.compile({
      reservedTokens,
      archiveText: archive.text,
      archiveBlocks: archive.blocks,
    }) || archive;
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

  _vectorDocuments() {
    const documents = this.cards.store.effectiveCards().map((card) => ({
      recordId: String(card.id),
      kind: `card:${card.cardType}`,
      title: card.title || `${card.cardType}:${card.period?.key || ''}`,
      text: String(card.content || ''),
      metadata: {
        periodKey: card.period?.key || null,
        sourceIds: uniqueStrings(card.sourceIds),
      },
    }));
    if (!this.semantic) return documents;
    for (const claim of this.semantic.store.claims()) {
      if (claim.verificationStatus !== 'supported') continue;
      documents.push({
        recordId: String(claim.claimId),
        kind: 'claim',
        title: claim.kind || 'claim',
        text: String(claim.content || claim.objectLiteral || ''),
        metadata: { packetId: claim.packetId || null },
      });
    }
    for (const event of this.semantic.store.events()) {
      if (event.status !== 'accepted') continue;
      documents.push({
        recordId: String(event.eventId),
        kind: 'event',
        title: event.title || 'event',
        text: [event.title, event.summary, event.description].filter(Boolean).join('\n'),
        metadata: { packetId: event.packetId || null },
      });
    }
    for (const projection of this.semantic.store.projections()) {
      if (projection.status !== 'accepted' || projection.stale === true) continue;
      documents.push({
        recordId: String(projection.projectionId),
        kind: `projection:${projection.projectionType || 'memory'}`,
        title: projection.title || projection.projectionType || 'projection',
        text: projectionText(projection),
        metadata: { periodKey: projection.period?.key || null },
      });
    }
    return documents;
  }

  async buildMessagesAsync(options = {}) {
    const built = this.buildMessages(options);
    if (!this.vectors.enabled || !String(options.userText || '').trim()) return built;
    try {
      const matches = await this.vectors.search(options.userText, this._vectorDocuments());
      if (!matches.length) return { ...built, vectorMatches: [] };
      const retrieval = [
        '[Tether query-relevant verified memory]',
        ...matches.map((match) => (
          `- ${match.title || match.kind} (${match.recordId}, score ${match.score.toFixed(4)})\n`
          + `${match.text}`
        )),
      ].join('\n');
      const messages = built.messages.map((message) => ({ ...message }));
      const systemIndex = messages.findIndex((message) => message.role === 'system');
      if (systemIndex >= 0) {
        messages[systemIndex].content = `${messages[systemIndex].content}\n\n${retrieval}`;
      } else {
        messages.unshift({ role: 'system', content: retrieval });
      }
      return {
        ...built,
        messages,
        vectorMatches: matches.map((match) => ({
          recordId: match.recordId,
          kind: match.kind,
          score: match.score,
        })),
      };
    } catch (error) {
      this.log(`[tether] vector recall unavailable; layered cards remain active: ${error.message}`);
      return { ...built, vectorMatches: [], vectorError: true };
    }
  }

  vectorStatus() {
    return this.vectors.status(this._vectorDocuments());
  }

  backfillVectors() {
    return this.vectors.backfillAll(this._vectorDocuments());
  }

  appendTurn(userText, assistantText, metadata = {}) {
    return this.history.appendTurn(userText, assistantText, metadata);
  }

  _semanticSender(metadata = {}) {
    const explicit = String(metadata.senderEntityId || '').trim();
    if (explicit) return explicit;
    const channel = String(metadata.source || metadata.channel || '');
    if (
      metadata.owner === true
      || ['terminal', 'trusted_local'].includes(channel)
      || String(metadata.trustZone || '') === 'trusted_local'
    ) return this.policy.owner.entityId;
    const canonical = this.semantic?.entityResolver.canonicalEntityIdForMessage({
      senderId: metadata.senderId,
      senderEntityId: explicit,
      senderDisplayName: metadata.senderDisplayName,
      senderIsBot: metadata.senderIsBot === true,
    });
    if (canonical) return canonical;
    if (metadata.senderId) return `telegram-user:${String(metadata.senderId)}`;
    return this.policy.owner.entityId;
  }

  _semanticPacketInput(userText, assistantText, metadata = {}) {
    const causalIds = uniqueStrings(metadata.causalIds);
    const turnKey = causalIds[0]
      || crypto.createHash('sha256')
        .update(`${metadata.sourceMessageId || ''}\0${userText}\0${assistantText}`, 'utf8')
        .digest('hex');
    const userMessageId = `input:${turnKey}`;
    const assistantMessageId = String(metadata.outputMessageId || `assistant:${turnKey}`);
    const conversationId = String(metadata.sessionId || 'primary-continuous-session');
    const source = String(metadata.source || metadata.channel || 'session');
    const chatId = metadata.chatId == null ? null : String(metadata.chatId);
    const occurredAt = validIsoTimestamp(metadata.receivedAt, metadata.sentAt);
    const completedAt = validIsoTimestamp(metadata.completedAt, occurredAt);
    const senderEntityId = this._semanticSender(metadata);
    const rawMessages = [{
      messageId: userMessageId,
      conversationId,
      channel: source,
      chatId,
      senderId: metadata.senderId == null ? null : String(metadata.senderId),
      senderEntityId,
      senderDisplayName: String(
        metadata.senderDisplayName
        || this.semantic.entityResolver.canonicalDisplayName(senderEntityId, senderEntityId),
      ),
      senderIsBot: metadata.senderIsBot === true,
      sentAt: occurredAt,
      replyToMessageId: null,
      replyTargetAvailable: false,
      text: String(userText || ''),
      archiveRef: `transcript.jsonl#${turnKey}`,
      ingestionCursor: `${turnKey}:input`,
      attachmentRefs: uniqueStrings(metadata.attachmentRefs),
    }, {
      messageId: assistantMessageId,
      conversationId,
      channel: source,
      chatId,
      senderEntityId: this.policy.agent.entityId,
      senderDisplayName: this.policy.agent.displayName,
      senderIsBot: true,
      sentAt: completedAt,
      replyToMessageId: userMessageId,
      replyTargetAvailable: true,
      text: String(assistantText || ''),
      archiveRef: `transcript.jsonl#${turnKey}`,
      ingestionCursor: `${turnKey}:assistant`,
      attachmentRefs: [],
    }];
    return {
      ...(metadata.semanticPacketId ? { packetId: String(metadata.semanticPacketId) } : {}),
      rawMessages,
      source,
      cursorStart: `${turnKey}:input`,
      cursorEnd: `${turnKey}:assistant`,
    };
  }

  _enqueueSemanticTurn(userText, assistantText, metadata = {}) {
    if (!this.semantic?.enabled()) return null;
    return this.semantic.enqueue(
      this._semanticPacketInput(userText, assistantText, metadata),
    ).packetId;
  }

  async rebuildSemanticQueue({ queueClass = 'historical', batchSize = 100 } = {}) {
    if (!this.semantic?.enabled()) throw new Error('Semantic memory is disabled');
    if (!['live', 'rebuild-priority', 'historical'].includes(queueClass)) {
      throw new Error(`Unknown semantic rebuild queueClass: ${queueClass}`);
    }
    let queued = 0;
    let duplicates = 0;
    let sourceDuplicates = 0;
    let promoted = 0;
    let turns = 0;
    let lineNumber = 0;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const result = this.semantic.enqueueMany(batch, { queueClass });
      queued += Number(result.queued || 0);
      duplicates += Number(result.duplicates || 0);
      sourceDuplicates += Number(result.sourceDuplicates || 0);
      promoted += Number(result.promoted || 0);
      batch = [];
    };
    let stream;
    try {
      stream = fs.createReadStream(this.history.transcriptFile, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (error) {
          const failure = new Error(`Transcript is corrupt at line ${lineNumber}`);
          failure.code = 'TETHER_TRANSCRIPT_CORRUPT';
          failure.line = lineNumber;
          throw failure;
        }
        if (entry?.type !== 'turn') continue;
        turns += 1;
        batch.push(this._semanticPacketInput(entry.user, entry.assistant, {
          causalIds: entry.causalIds || [],
          source: entry.source || 'transcript-rebuild',
          trustZone: entry.trustZone || null,
          chatId: entry.chatId || null,
          senderId: entry.senderId || null,
          sourceMessageId: entry.sourceMessageId || null,
          semanticPacketId: entry.semanticPacketId || null,
          receivedAt: entry.at || null,
          completedAt: entry.at || null,
          attachmentRefs: (Array.isArray(entry.sourceParts) ? entry.sourceParts : []).map(
            (part) => part?.archivePath || part?.path || part?.sha256,
          ),
        }));
        if (batch.length >= Math.max(1, Number(batchSize) || 100)) flush();
      }
      flush();
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'empty', turns: 0, queued: 0 };
      throw error;
    } finally {
      stream?.destroy();
    }
    return {
      status: 'queued',
      turns,
      queued,
      duplicates,
      sourceDuplicates,
      promoted,
      queueClass,
    };
  }

  status() {
    return {
      semantic: this.semantic
        ? {
            mode: this.semantic.mode,
            queue: this.semantic.queueStatus(),
            claims: this.semantic.store.claims().length,
            events: this.semantic.store.events().length,
            projections: this.semantic.store.projections().length,
          }
        : { mode: 'off', queue: { total: 0, actionable: 0, counts: {} } },
      vectors: this.vectorStatus(),
      transcript: this.history.transcriptProof(),
    };
  }

  async ensureTurn(userText, assistantText, metadata = {}) {
    const causalIds = Array.isArray(metadata.causalIds) ? metadata.causalIds.map(String) : [];
    const semanticPacketId = metadata.semanticPacketId
      || this._enqueueSemanticTurn(userText, assistantText, metadata);
    const existing = this.history.findTurnByCausalIds(causalIds);
    if (existing) {
      await this.history.restoreUncommittedTurn(existing);
      return { duplicate: true, entry: existing, semanticPacketId };
    }
    await this.history.appendTurn(userText, assistantText, {
      ...metadata,
      semanticPacketId,
    });
    return { duplicate: false, semanticPacketId };
  }

  async maintainOne() {
    if (this._maintenance) return { status: 'busy' };
    this._maintenance = this._maintainOne();
    try {
      return await this._maintenance;
    } finally {
      this._maintenance = null;
    }
  }

  async _maintainOne() {
    const failures = [];
    let semantic = { status: 'disabled' };
    let cards = { status: 'disabled' };
    let vectors = { status: 'disabled' };
    try {
      if (this.semantic) semantic = await this.semantic.maintainOne();
    } catch (error) {
      failures.push(error);
    }
    try {
      cards = await this.cards.maintainOne();
    } catch (error) {
      failures.push(error);
    }
    try {
      vectors = await this.vectors.maintainOne(this._vectorDocuments());
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, 'One or more layered memory maintenance jobs failed');
    }
    return { status: 'completed', semantic, cards, vectors };
  }

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
      path.join(this.directory, 'semantic', 'inbox.jsonl'),
      path.join(this.directory, 'semantic', 'packets.jsonl'),
      path.join(this.directory, 'semantic', 'embeddings.jsonl'),
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
