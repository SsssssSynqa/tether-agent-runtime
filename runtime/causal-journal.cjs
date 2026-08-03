// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function appendFsynced(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(filePath, 0o600);
}

class CausalStateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'CausalStateError';
    this.code = code;
    this.details = details;
  }
}

class CausalJournal {
  constructor({ directory, clock = () => new Date().toISOString() } = {}) {
    if (!directory) throw new Error('CausalJournal requires directory');
    this.filePath = path.join(path.resolve(directory), 'causal-journal.jsonl');
    this.clock = clock;
    this.latest = new Map();
    this._load();
  }

  _load() {
    let text = '';
    try { text = fs.readFileSync(this.filePath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const [index, line] of text.split('\n').entries()) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) {
        throw new CausalStateError(
          `Causal journal is malformed at line ${index + 1}`,
          'TETHER_CAUSAL_CORRUPT',
        );
      }
      if (!record.causalId || !record.state) {
        throw new CausalStateError(
          `Causal journal record ${index + 1} lacks causalId/state`,
          'TETHER_CAUSAL_CORRUPT',
        );
      }
      this.latest.set(String(record.causalId), record);
    }
  }

  _append(record) {
    const full = { ...record, schemaVersion: 1, at: this.clock() };
    appendFsynced(this.filePath, full);
    this.latest.set(String(full.causalId), full);
    return full;
  }

  prepareInput({ sessionId, channelId, messageId, role = 'user', text, metadata = {} } = {}) {
    if (!sessionId || !channelId || !messageId) {
      throw new Error('Causal input requires sessionId, channelId, and messageId');
    }
    const causalId = `causal:${sha256(`v1\0${sessionId}\0${channelId}\0${messageId}`)}`;
    const input = {
      sessionId: String(sessionId),
      channelId: String(channelId),
      messageId: String(messageId),
      role: String(role),
      textSha256: sha256(text ?? ''),
      metadataSha256: sha256(canonicalJson(metadata || {})),
    };
    const inputFingerprint = sha256(canonicalJson(input));
    const existing = this.latest.get(causalId);
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint || canonicalJson(existing.input) !== canonicalJson(input)) {
        throw new CausalStateError(
          'Duplicate causal message does not match the committed input envelope',
          'TETHER_CAUSAL_MISMATCH',
          { causalId },
        );
      }
      return { causalId, record: existing, duplicate: true };
    }
    const record = this._append({
      causalId,
      state: 'received',
      input,
      inputFingerprint,
    });
    return { causalId, record, duplicate: false };
  }

  state(causalId) {
    return this.latest.get(String(causalId)) || null;
  }

  _transition(causalId, allowedStates, state, extra = {}) {
    const prior = this.state(causalId);
    if (!prior || !allowedStates.includes(prior.state)) {
      throw new CausalStateError(
        `Invalid causal transition ${prior?.state || 'missing'} -> ${state}`,
        'TETHER_CAUSAL_TRANSITION',
        { causalId, priorState: prior?.state || null, nextState: state },
      );
    }
    return this._append({
      ...prior,
      ...extra,
      causalId: String(causalId),
      state,
      previousState: prior.state,
    });
  }

  markInferenceStarted(causalId) {
    return this._transition(causalId, ['received'], 'inference-started');
  }

  commitOutput(causalId, { text, providerId = null } = {}) {
    const outputText = String(text ?? '');
    const output = {
      outputId: `output:${sha256(`v1\0${causalId}\0${outputText}`)}`,
      text: outputText,
      textSha256: sha256(outputText),
      providerId: providerId ? String(providerId) : null,
    };
    return this._transition(causalId, ['inference-started'], 'committed', { output });
  }

  markDeliveryStarted(causalId) {
    return this._transition(causalId, ['committed', 'delivery-failed'], 'delivery-started');
  }

  markDeliveryFailed(causalId, error) {
    return this._transition(causalId, ['delivery-started'], 'delivery-failed', {
      deliveryError: String(error?.message || error || 'delivery failed').slice(0, 500),
    });
  }

  markDelivered(causalId) {
    return this._transition(causalId, ['delivery-started'], 'delivered');
  }
}

module.exports = { CausalJournal, CausalStateError, canonicalJson, sha256 };
