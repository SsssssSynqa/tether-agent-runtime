// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalJson } = require('../causal-journal.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function appendFsynced(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  try {
    fs.writeSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(filePath, 0o600);
  return bytes;
}

function readJsonlState(filePath) {
  let bytes = Buffer.alloc(0);
  try { bytes = fs.readFileSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') return { bytes, records: [] };
    throw error;
  }
  const records = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { bytes, records };
}

function readJsonl(filePath) {
  return readJsonlState(filePath).records;
}

function boundedLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function sha256FilePrefix(filePath, byteLength) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, byteLength)));
  let offset = 0;
  try {
    while (offset < byteLength) {
      const wanted = Math.min(buffer.length, byteLength - offset);
      const read = fs.readSync(descriptor, buffer, 0, wanted, offset);
      if (read === 0) throw new Error('transcript prefix ended unexpectedly');
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

class AppendOnlyMemory {
  constructor({ directory, clock = () => new Date().toISOString() } = {}) {
    if (!directory) throw new Error('AppendOnlyMemory requires directory');
    this.directory = path.resolve(directory);
    this.transcriptFile = path.join(this.directory, 'transcript.jsonl');
    this.summariesFile = path.join(this.directory, 'summaries.jsonl');
    // Tether Console treats `directory` as TETHER_MEMORY_ROOT and reads cards
    // from its conventional cards/ child.  Keep the runtime writer on that
    // same authoritative path instead of maintaining a second projection.
    this.cardsFile = path.join(this.directory, 'cards', 'cards.jsonl');
    this.clock = clock;
    this.refresh();
  }

  // A running Tether process is the sole writer for this folder. External
  // edits are intentionally unsupported until the caller explicitly refreshes.
  refresh() {
    const transcript = readJsonlState(this.transcriptFile);
    const summaries = readJsonlState(this.summariesFile);
    const cards = readJsonlState(this.cardsFile);
    const messageById = new Map();
    for (const record of transcript.records) {
      const messageId = String(record?.messageId || '');
      if (!messageId || messageById.has(messageId)) {
        throw new Error(`Transcript contains a missing or duplicate messageId: ${messageId || '<empty>'}`);
      }
      messageById.set(messageId, record);
    }
    this._messages = transcript.records;
    this._summaries = summaries.records;
    this._cards = cards.records;
    this._messageById = messageById;
    this._transcriptBytes = transcript.bytes.length;
    this._transcriptHash = crypto.createHash('sha256').update(transcript.bytes);
    return this;
  }

  messages() { return structuredClone(this._messages); }
  summaries() { return structuredClone(this._summaries); }
  cards() { return structuredClone(this._cards); }

  appendMessage({ messageId = crypto.randomUUID(), sessionId, channelId, role, text, metadata = {} } = {}) {
    if (!sessionId || !channelId || !['user', 'assistant', 'system'].includes(role)) {
      throw new Error('Memory message requires sessionId, channelId, and a valid role');
    }
    const content = String(text ?? '');
    const envelope = {
      sessionId: String(sessionId),
      channelId: String(channelId),
      role,
      textSha256: sha256(content),
      metadata: structuredClone(metadata || {}),
    };
    const existing = this._messageById.get(String(messageId));
    if (existing) {
      const existingEnvelope = {
        sessionId: String(existing.sessionId),
        channelId: String(existing.channelId),
        role: existing.role,
        textSha256: existing.textSha256,
        metadata: existing.metadata || {},
      };
      if (canonicalJson(existingEnvelope) !== canonicalJson(envelope)) {
        throw new Error(`Message id ${messageId} already exists with a different causal envelope`);
      }
      return { duplicate: true, record: structuredClone(existing) };
    }
    const record = {
      schemaVersion: 1,
      messageId: String(messageId),
      ...envelope,
      text: content,
      createdAt: this.clock(),
    };
    const appendedBytes = appendFsynced(this.transcriptFile, record);
    this._messages.push(record);
    this._messageById.set(record.messageId, record);
    this._transcriptBytes += appendedBytes.length;
    this._transcriptHash.update(appendedBytes);
    return { duplicate: false, record: structuredClone(record) };
  }

  appendSummary({ summaryId = crypto.randomUUID(), sourceMessageIds, text } = {}) {
    const resolvedSummaryId = String(summaryId || '').trim();
    if (!resolvedSummaryId) throw new Error('Summary requires a non-empty summaryId');
    if (this._summaries.some((record) => record.summaryId === resolvedSummaryId)) {
      throw new Error(`Summary id ${resolvedSummaryId} already exists`);
    }
    const suppliedSourceIds = (sourceMessageIds || []).map(String);
    const sourceIds = [...new Set(suppliedSourceIds)];
    if (!sourceIds.length
      || sourceIds.length !== suppliedSourceIds.length
      || sourceIds.some((id) => !id || !this._messageById.has(id))) {
      throw new Error('Summary evidence must reference existing transcript messages');
    }
    const record = {
      schemaVersion: 1,
      summaryId: resolvedSummaryId,
      sourceMessageIds: sourceIds,
      text: String(text || ''),
      textSha256: sha256(text || ''),
      createdAt: this.clock(),
    };
    appendFsynced(this.summariesFile, record);
    this._summaries.push(record);
    return structuredClone(record);
  }

  appendCard({
    cardId = null,
    cardType,
    version = 1,
    period,
    sourceMessageIds,
    title = null,
    text,
    content = text,
    provenance = {},
  } = {}) {
    if (!['day', 'week'].includes(cardType)) throw new Error('Card requires cardType day or week');
    if (!period?.key) throw new Error('Card requires period.key');
    if (!Number.isInteger(version) || version < 1) throw new Error('Card version must be a positive integer');
    const suppliedSourceIds = (sourceMessageIds || []).map(String);
    const sourceIds = [...new Set(suppliedSourceIds)];
    if (!sourceIds.length
      || sourceIds.length !== suppliedSourceIds.length
      || sourceIds.some((id) => !id || !this._messageById.has(id))) {
      throw new Error('Card provenance must reference existing transcript messages');
    }
    const cardContent = String(content || '');
    const resolvedCardId = String(
      cardId || `memory-card:${cardType}:${period.key}:v${version}:${crypto.randomUUID()}`,
    );
    if (this._cards.some((record) => record.id === resolvedCardId)) {
      throw new Error(`Card id ${resolvedCardId} already exists`);
    }
    const record = {
      type: 'memory-card',
      schema: 1,
      id: resolvedCardId,
      cardType,
      version,
      period: structuredClone(period),
      sourceIds,
      title: String(title || `${cardType === 'day' ? 'Day' : 'Week'} card · ${period.key}`),
      content: cardContent,
      contentSha256: sha256(cardContent),
      provenance: structuredClone(provenance || {}),
      createdAt: this.clock(),
    };
    appendFsynced(this.cardsFile, record);
    this._cards.push(record);
    return structuredClone(record);
  }

  compileContext({ rawTailMessages = 40, summaryLimit = 20, cardLimit = 20 } = {}) {
    const rawLimit = boundedLimit(rawTailMessages, 40);
    const summariesLimit = boundedLimit(summaryLimit, 20);
    const cardsLimit = boundedLimit(cardLimit, 20);
    const latestCards = new Map();
    for (const record of this._cards) {
      const logicalId = `${record.cardType}:${record.period?.key}`;
      const current = latestCards.get(logicalId);
      if (!current || Number(record.version || 0) >= Number(current.version || 0)) {
        latestCards.set(logicalId, record);
      }
    }
    const cards = [...latestCards.values()].sort((left, right) => (
      String(left.period?.key || '').localeCompare(String(right.period?.key || ''))
      || String(left.cardType || '').localeCompare(String(right.cardType || ''))
      || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
    return {
      summaries: structuredClone(summariesLimit === 0 ? [] : this._summaries.slice(-summariesLimit)),
      cards: structuredClone(cardsLimit === 0 ? [] : cards.slice(-cardsLimit)),
      rawTail: structuredClone(rawLimit === 0 ? [] : this._messages.slice(-rawLimit)),
      rawTranscriptCount: this._messages.length,
    };
  }

  verify() {
    const errors = [];
    try {
      for (const record of this._messages) {
        if (record.textSha256 !== sha256(record.text)) errors.push(`message:${record.messageId}`);
      }
      const summaryIds = new Set();
      for (const record of this._summaries) {
        const summaryId = String(record?.summaryId || '');
        if (!summaryId || summaryIds.has(summaryId)) {
          errors.push(`summary-id:${summaryId || '<missing>'}`);
        } else {
          summaryIds.add(summaryId);
        }
        const sourceIds = Array.isArray(record.sourceMessageIds) ? record.sourceMessageIds.map(String) : [];
        if (!sourceIds.length
          || new Set(sourceIds).size !== sourceIds.length
          || sourceIds.some((id) => !id || !this._messageById.has(id))) {
          errors.push(`summary-lineage:${summaryId || '<missing>'}`);
        }
        if (typeof record.text !== 'string' || record.textSha256 !== sha256(record.text)) {
          errors.push(`derived:${summaryId || '<missing>'}`);
        }
      }
      const cardIds = new Set();
      for (const record of this._cards) {
        const cardId = String(record?.id || '');
        if (!cardId || cardIds.has(cardId)) {
          errors.push(`card-id:${cardId || '<missing>'}`);
        } else {
          cardIds.add(cardId);
        }
        const sourceIds = Array.isArray(record.sourceIds) ? record.sourceIds.map(String) : [];
        if (!sourceIds.length
          || new Set(sourceIds).size !== sourceIds.length
          || sourceIds.some((id) => !id || !this._messageById.has(id))) {
          errors.push(`card-lineage:${cardId || '<missing>'}`);
        }
        if (record.type !== 'memory-card'
          || !['day', 'week'].includes(record.cardType)
          || !record.period?.key
          || !Number.isInteger(record.version)
          || record.version < 1
          || typeof record.content !== 'string'
          || record.contentSha256 !== sha256(record.content)) {
          errors.push(`derived:${cardId || '<missing-card-id>'}`);
        }
      }
    } catch (error) {
      errors.push(`journal:${error.message}`);
    }
    return { passed: errors.length === 0, errors };
  }

  hasExistingAuthority() {
    if (this._messages.length || this._summaries.length || this._cards.length) return true;
    try { return fs.statSync(path.join(this.directory, 'causal-journal.jsonl')).size > 0; } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  sessionProof(sessionId) {
    const verification = this.verifySession(sessionId);
    if (!verification.passed) return verification;
    return {
      passed: true,
      errors: [],
      proof: {
        schemaVersion: 1,
        transcriptBytes: this._transcriptBytes,
        transcriptSha256: this._transcriptHash.copy().digest('hex'),
        messageCount: this._messages.length,
      },
    };
  }

  verifySession(sessionId, { expectedProof = null } = {}) {
    const integrity = this.verify();
    if (!integrity.passed) return integrity;
    const mismatched = this._messages
      .filter((record) => String(record.sessionId) !== String(sessionId))
      .map((record) => record.messageId);
    const errors = mismatched.map((messageId) => `session-mismatch:${messageId}`);
    if (expectedProof) {
      const prefixBytes = Number(expectedProof.transcriptBytes);
      const expectedMessageCount = Number(expectedProof.messageCount);
      if (expectedProof.schemaVersion !== 1
        || !/^[a-f0-9]{64}$/.test(String(expectedProof.transcriptSha256 || ''))
        || !Number.isInteger(expectedMessageCount)
        || expectedMessageCount < 0) {
        errors.push('memory-proof:invalid');
      } else if (!Number.isInteger(prefixBytes) || prefixBytes < 0 || this._transcriptBytes < prefixBytes) {
        errors.push('memory-proof:truncated');
      } else {
        try {
          const actualHash = prefixBytes === this._transcriptBytes
            ? this._transcriptHash.copy().digest('hex')
            : sha256FilePrefix(this.transcriptFile, prefixBytes);
          if (actualHash !== expectedProof.transcriptSha256) errors.push('memory-proof:prefix-mismatch');
        } catch (error) {
          errors.push(`journal:${error.message}`);
        }
      }
      if (this._messages.length < expectedMessageCount) {
        errors.push('memory-proof:message-count-regressed');
      }
    }
    return {
      passed: errors.length === 0,
      errors,
    };
  }
}

module.exports = {
  AppendOnlyMemory,
  appendFsynced,
  boundedLimit,
  readJsonl,
  readJsonlState,
  sha256,
  sha256Bytes,
  sha256FilePrefix,
};
