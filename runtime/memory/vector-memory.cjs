// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function appendRecords(filePath, records) {
  if (!records.length) return;
  ensurePrivateDirectory(path.dirname(filePath));
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function atomicRewrite(filePath, records) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(
    temporary,
    records.length ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function atomicWriteJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || !vector.length) throw new Error('Embedding vector is empty');
  const normalized = vector.map(Number);
  if (normalized.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding vector contains a non-finite value');
  }
  return normalized;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || left.length !== right?.length || !left.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalizedDocuments(documents = []) {
  const latest = new Map();
  for (const document of documents || []) {
    const recordId = String(document?.recordId || '').trim();
    const text = String(document?.text || '').trim();
    if (!recordId || !text) continue;
    latest.set(recordId, {
      recordId,
      kind: String(document.kind || 'memory'),
      title: document.title == null ? null : String(document.title),
      text,
      metadata: document.metadata && typeof document.metadata === 'object'
        ? structuredClone(document.metadata)
        : {},
      contentSha256: contentHash(text),
    });
  }
  return [...latest.values()];
}

class VectorMemoryIndex {
  constructor({
    directory,
    embed,
    enabled = false,
    batchSize = 32,
    topK = 6,
    minScore = 0.25,
    maxEmbeddingChars = 12_000,
    maxRetrievedChars = 2_000,
    maxBytes = 64 * 1024 * 1024,
    clock = () => new Date().toISOString(),
    log = console.log,
  } = {}) {
    if (!directory) throw new Error('VectorMemoryIndex requires directory');
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, 'embeddings.jsonl');
    this.stateFile = path.join(this.directory, 'embedding-state.json');
    this.enabled = Boolean(enabled);
    this.embed = typeof embed === 'function' ? embed : null;
    if (this.enabled && !this.embed) {
      throw new Error('Vector memory is enabled but the provider has no embedding adapter');
    }
    this.batchSize = Math.max(1, Number(batchSize) || 32);
    this.topK = Math.max(1, Number(topK) || 6);
    this.minScore = Number.isFinite(Number(minScore)) ? Number(minScore) : 0.25;
    this.maxEmbeddingChars = Math.max(128, Number(maxEmbeddingChars) || 12_000);
    this.maxRetrievedChars = Math.max(128, Number(maxRetrievedChars) || 2_000);
    this.maxBytes = Math.max(1024 * 1024, Number(maxBytes) || 64 * 1024 * 1024);
    this.clock = clock;
    this.log = log;
    this.latest = new Map();
    this._load();
  }

  _writeState(status) {
    const stable = {
      schemaVersion: 1,
      enabled: Boolean(status.enabled),
      totalDocuments: Number(status.totalDocuments || 0),
      indexedDocuments: Number(status.indexedDocuments || 0),
      missingDocuments: Number(status.missingDocuments || 0),
      storedVectors: Number(status.storedVectors || 0),
    };
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const priorStable = prior && { ...prior };
    if (priorStable) delete priorStable.updatedAt;
    if (priorStable && JSON.stringify(priorStable) === JSON.stringify(stable)) return;
    atomicWriteJson(this.stateFile, { ...stable, updatedAt: this.clock() });
  }

  _load() {
    let raw = '';
    try { raw = fs.readFileSync(this.filePath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) {
        const failure = new Error(`Vector journal is corrupt at line ${index + 1}`);
        failure.code = 'TETHER_VECTOR_CORRUPT';
        failure.line = index + 1;
        throw failure;
      }
      if (!record?.recordId || !record?.contentSha256) {
        const failure = new Error(`Vector journal record ${index + 1} lacks recordId/contentSha256`);
        failure.code = 'TETHER_VECTOR_CORRUPT';
        failure.line = index + 1;
        throw failure;
      }
      normalizeVector(record.vector);
      this.latest.set(String(record.recordId), record);
    }
  }

  status(documents = []) {
    const active = normalizedDocuments(documents);
    const missing = active.filter((document) => (
      this.latest.get(document.recordId)?.contentSha256 !== document.contentSha256
    ));
    return {
      enabled: this.enabled,
      totalDocuments: active.length,
      indexedDocuments: active.length - missing.length,
      missingDocuments: missing.length,
      storedVectors: this.latest.size,
    };
  }

  async maintainOne(documents = []) {
    if (!this.enabled) {
      const result = { status: 'disabled', ...this.status(documents) };
      this._writeState(result);
      return result;
    }
    const active = normalizedDocuments(documents);
    const pending = active.filter((document) => (
      this.latest.get(document.recordId)?.contentSha256 !== document.contentSha256
    ));
    if (!pending.length) {
      this.compact(active.map((document) => document.recordId));
      const result = { status: 'idle', ...this.status(active) };
      this._writeState(result);
      return result;
    }
    const batch = pending.slice(0, this.batchSize);
    const result = await this.embed({
      texts: batch.map((document) => document.text.slice(0, this.maxEmbeddingChars)),
      purpose: 'memory-embedding',
    });
    if (!Array.isArray(result?.vectors) || result.vectors.length !== batch.length) {
      throw new Error('Embedding adapter returned the wrong number of vectors');
    }
    const vectors = result.vectors.map(normalizeVector);
    const dimensions = vectors[0].length;
    if (vectors.some((vector) => vector.length !== dimensions)) {
      throw new Error('Embedding adapter returned inconsistent dimensions');
    }
    const updatedAt = this.clock();
    const records = batch.map((document, index) => ({
      schemaVersion: 1,
      recordId: document.recordId,
      kind: document.kind,
      title: document.title,
      contentSha256: document.contentSha256,
      vector: vectors[index],
      dimensions,
      providerId: result.providerId || null,
      model: result.model || null,
      updatedAt,
    }));
    appendRecords(this.filePath, records);
    for (const record of records) this.latest.set(record.recordId, record);
    this.compact(active.map((document) => document.recordId));
    const resultStatus = {
      status: 'generated',
      generated: records.length,
      remaining: Math.max(0, pending.length - records.length),
      ...this.status(active),
    };
    this._writeState(resultStatus);
    return resultStatus;
  }

  async backfillAll(documents = []) {
    const results = [];
    for (;;) {
      const result = await this.maintainOne(documents);
      results.push(result);
      if (!['generated'].includes(result.status) || result.remaining === 0) break;
    }
    return { status: 'completed', passes: results.length, final: this.status(documents) };
  }

  async search(query, documents = [], { topK = this.topK, minScore = this.minScore } = {}) {
    if (!this.enabled || !String(query || '').trim()) return [];
    const active = normalizedDocuments(documents);
    const result = await this.embed({ texts: [String(query)], purpose: 'memory-query' });
    if (!Array.isArray(result?.vectors) || result.vectors.length !== 1) {
      throw new Error('Embedding query adapter returned the wrong number of vectors');
    }
    const queryVector = normalizeVector(result.vectors[0]);
    const matches = [];
    for (const document of active) {
      const record = this.latest.get(document.recordId);
      if (!record || record.contentSha256 !== document.contentSha256) continue;
      const score = cosineSimilarity(queryVector, record.vector);
      if (score == null || score < Number(minScore)) continue;
      matches.push({
        ...document,
        text: document.text.length <= this.maxRetrievedChars
          ? document.text
          : `${document.text.slice(0, this.maxRetrievedChars).trimEnd()}…`,
        score,
        model: record.model || null,
      });
    }
    return matches
      .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
      .slice(0, Math.max(1, Number(topK) || this.topK));
  }

  compact(activeRecordIds = []) {
    let size = 0;
    try { size = fs.statSync(this.filePath).size; } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (size <= this.maxBytes) return false;
    const active = new Set(activeRecordIds.map(String));
    const retained = [...this.latest.values()]
      .filter((record) => !active.size || active.has(String(record.recordId)))
      .sort((left, right) => String(left.recordId).localeCompare(String(right.recordId)));
    atomicRewrite(this.filePath, retained);
    this.latest = new Map(retained.map((record) => [String(record.recordId), record]));
    this.log(`[tether] compacted vector journal to ${retained.length} active records`);
    return true;
  }
}

module.exports = {
  VectorMemoryIndex,
  contentHash,
  cosineSimilarity,
  normalizedDocuments,
  normalizeVector,
};
