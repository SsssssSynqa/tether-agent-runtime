// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TRANSACTION_EVENTS = new Set([
  'begin',
  'request-started',
  'provider-failed',
  'provider-step',
  'tool-result',
  'final',
]);

function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(input).digest('hex');
}

function appendFsynced(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

class ToolJournal {
  constructor({ directory, clock = () => new Date().toISOString() } = {}) {
    if (!directory) throw new Error('ToolJournal requires directory');
    this.directory = path.resolve(directory);
    this.filePath = path.join(this.directory, 'tool-journal.jsonl');
    this.clock = clock;
    this.transactions = new Map();
    this.operations = new Map();
    this.approvals = new Map();
    this._load();
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
        const failure = new Error(`Tool journal is malformed at line ${index + 1}`);
        failure.code = 'TETHER_TOOL_JOURNAL_CORRUPT';
        throw failure;
      }
      if (record.recordType === 'transaction' && record.causalId && record.event) {
        const key = String(record.causalId);
        const events = this.transactions.get(key) || [];
        const invalid = this._invalidTransactionAppend(events, record);
        if (invalid) {
          const failure = new Error(`Tool journal transaction is invalid at line ${index + 1}: ${invalid}`);
          failure.code = 'TETHER_TOOL_JOURNAL_CORRUPT';
          throw failure;
        }
        if (!this.transactions.has(key)) this.transactions.set(key, events);
        events.push(record);
      } else if (record.recordType === 'operation' && record.operationKey && record.state) {
        const prior = this.operations.get(String(record.operationKey));
        if (
          !['prepared', 'committed'].includes(record.state)
          || (record.state === 'prepared' && prior)
          || (record.state === 'committed' && (!prior || prior.state !== 'prepared'))
          || (prior && prior.fingerprint !== record.fingerprint)
        ) {
          const failure = new Error(`Tool journal operation is invalid at line ${index + 1}`);
          failure.code = 'TETHER_TOOL_JOURNAL_CORRUPT';
          throw failure;
        }
        this.operations.set(String(record.operationKey), record);
      } else if (record.recordType === 'approval' && record.approvalId && record.state) {
        const prior = this.approvals.get(String(record.approvalId));
        if (
          !['pending', 'approved', 'denied'].includes(record.state)
          || (record.state === 'pending' && prior)
          || (record.state !== 'pending' && (!prior || prior.state !== 'pending'))
          || (prior && prior.fingerprint !== record.fingerprint)
        ) {
          const failure = new Error(`Tool journal approval is invalid at line ${index + 1}`);
          failure.code = 'TETHER_TOOL_JOURNAL_CORRUPT';
          throw failure;
        }
        this.approvals.set(String(record.approvalId), record);
      } else {
        const failure = new Error(`Tool journal record ${index + 1} has an unknown shape`);
        failure.code = 'TETHER_TOOL_JOURNAL_CORRUPT';
        throw failure;
      }
    }
  }

  _invalidTransactionAppend(events, record) {
    if (!TRANSACTION_EVENTS.has(String(record.event))) return 'unknown event';
    if (record.event === 'begin') {
      if (events.length) return 'duplicate or out-of-order begin';
      if (!String(record.requestHash || '')) return 'begin lacks requestHash';
      return null;
    }
    if (!events.length || events[0].event !== 'begin') return 'event precedes begin';
    if (events.some((event) => event.event === 'final')) return 'event follows final';
    const prior = events.at(-1);
    if (record.event === 'request-started') {
      if (!['begin', 'provider-failed', 'tool-result'].includes(prior.event)) {
        return `request-started follows ${prior.event}`;
      }
    } else if (record.event === 'provider-failed') {
      if (!['begin', 'request-started', 'provider-failed', 'tool-result'].includes(prior.event)) {
        return `provider-failed follows ${prior.event}`;
      }
    } else if (record.event === 'provider-step') {
      if (prior.event !== 'request-started') return `provider-step follows ${prior.event}`;
      if (!record.message || !record.result) return 'provider-step lacks message/result';
    } else if (record.event === 'tool-result') {
      if (!['provider-step', 'tool-result'].includes(prior.event)) {
        return `tool-result follows ${prior.event}`;
      }
      if (!record.toolCallId || record.message?.role !== 'tool') {
        return 'tool-result lacks a valid tool message';
      }
    } else if (record.event === 'final') {
      if (prior.event !== 'provider-step' || !record.result) return 'final lacks a provider-step/result';
    }
    if (['request-started', 'provider-failed', 'provider-step', 'tool-result'].includes(record.event)) {
      if (!Number.isSafeInteger(Number(record.iteration)) || Number(record.iteration) < 0) {
        return `${record.event} lacks a valid iteration`;
      }
    }
    if (['request-started', 'provider-failed', 'provider-step'].includes(record.event)) {
      if (!Number.isSafeInteger(Number(record.providerIndex)) || Number(record.providerIndex) < 0) {
        return `${record.event} lacks a valid providerIndex`;
      }
      if (!String(record.providerId || '')) return `${record.event} lacks providerId`;
    }
    return null;
  }

  _append(record) {
    const full = {
      ...record,
      schemaVersion: 1,
      at: this.clock(),
    };
    appendFsynced(this.filePath, full);
    if (full.recordType === 'transaction') {
      const key = String(full.causalId);
      if (!this.transactions.has(key)) this.transactions.set(key, []);
      this.transactions.get(key).push(full);
    } else if (full.recordType === 'operation') {
      this.operations.set(String(full.operationKey), full);
    } else if (full.recordType === 'approval') {
      this.approvals.set(String(full.approvalId), full);
    }
    return structuredClone(full);
  }

  transactionEvents(causalId) {
    return structuredClone(this.transactions.get(String(causalId || '')) || []);
  }

  beginTransaction(causalId, requestHash) {
    const key = String(causalId || '');
    if (!key || !requestHash) throw new Error('Tool transaction requires causalId and requestHash');
    const events = this.transactions.get(key) || [];
    const begin = events.find((record) => record.event === 'begin');
    if (begin) {
      if (begin.requestHash !== String(requestHash)) {
        const error = new Error('Tool transaction request does not match its durable beginning');
        error.code = 'TETHER_TOOL_TRANSACTION_MISMATCH';
        throw error;
      }
      return structuredClone(begin);
    }
    return this._append({
      recordType: 'transaction',
      event: 'begin',
      causalId: key,
      requestHash: String(requestHash),
    });
  }

  recordTransaction(causalId, event, details = {}) {
    const key = String(causalId || '');
    if (!key || !event) throw new Error('Tool transaction event requires causalId and event');
    const record = {
      ...structuredClone(details),
      recordType: 'transaction',
      event: String(event),
      causalId: key,
    };
    const invalid = this._invalidTransactionAppend(this.transactions.get(key) || [], record);
    if (invalid) throw new Error(`Invalid tool transaction event: ${invalid}`);
    return this._append(record);
  }

  canResume(causalId) {
    const events = this.transactions.get(String(causalId || '')) || [];
    const latest = events.at(-1);
    return Boolean(latest && [
      'begin',
      'provider-failed',
      'provider-step',
      'tool-result',
      'final',
    ].includes(latest.event));
  }

  operation(operationKey) {
    const record = this.operations.get(String(operationKey || ''));
    return record ? structuredClone(record) : null;
  }

  prepareOperation({ operationKey, fingerprint, causalId, toolCallId, toolName, details = {} }) {
    const key = String(operationKey || '');
    if (!key || !fingerprint || !causalId || !toolName) {
      throw new Error('Tool operation preparation is incomplete');
    }
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.fingerprint !== String(fingerprint)) {
        const error = new Error('Tool operation key was reused with different arguments');
        error.code = 'TETHER_TOOL_OPERATION_MISMATCH';
        throw error;
      }
      return structuredClone(existing);
    }
    return this._append({
      recordType: 'operation',
      state: 'prepared',
      operationKey: key,
      fingerprint: String(fingerprint),
      causalId: String(causalId),
      toolCallId: String(toolCallId || ''),
      toolName: String(toolName),
      details: structuredClone(details),
    });
  }

  commitOperation(operationKey, result, { recovered = false } = {}) {
    const key = String(operationKey || '');
    const existing = this.operations.get(key);
    if (!existing) throw new Error(`Tool operation ${key} was not prepared`);
    if (existing.state === 'committed') return structuredClone(existing);
    return this._append({
      ...existing,
      recordType: 'operation',
      state: 'committed',
      operationKey: key,
      result: structuredClone(result),
      recovered: recovered === true,
    });
  }

  requestApproval({ fingerprint, toolName, scope, summary }) {
    const normalizedFingerprint = String(fingerprint || '');
    if (!normalizedFingerprint) throw new Error('Tool approval requires an operation fingerprint');
    const approvalId = `approval:${sha256(`v1\0${normalizedFingerprint}`).slice(0, 24)}`;
    const existing = this.approvals.get(approvalId);
    if (existing) return structuredClone(existing);
    return this._append({
      recordType: 'approval',
      state: 'pending',
      approvalId,
      fingerprint: normalizedFingerprint,
      toolName: String(toolName || ''),
      scope: String(scope || 'default'),
      summary: structuredClone(summary || {}),
    });
  }

  resolveApproval(approvalId, state, { actor = 'operator', reason = null } = {}) {
    const id = String(approvalId || '');
    const normalizedState = String(state || '');
    if (!['approved', 'denied'].includes(normalizedState)) {
      throw new Error('Tool approval resolution must be approved or denied');
    }
    const existing = this.approvals.get(id);
    if (!existing) throw new Error(`Unknown tool approval: ${id}`);
    if (existing.state === normalizedState) return structuredClone(existing);
    if (existing.state !== 'pending') {
      throw new Error(`Tool approval ${id} is already ${existing.state}`);
    }
    return this._append({
      ...existing,
      recordType: 'approval',
      state: normalizedState,
      approvalId: id,
      resolvedBy: String(actor || 'operator'),
      reason: reason == null ? null : String(reason).slice(0, 500),
    });
  }

  approvalForFingerprint(fingerprint) {
    const approvalId = `approval:${sha256(`v1\0${String(fingerprint || '')}`).slice(0, 24)}`;
    const record = this.approvals.get(approvalId);
    return record ? structuredClone(record) : null;
  }

  listApprovals({ state = null } = {}) {
    return [...this.approvals.values()]
      .filter((record) => !state || record.state === state)
      .sort((left, right) => String(left.at).localeCompare(String(right.at)))
      .map((record) => structuredClone(record));
  }

  listOperations({ limit = 100 } = {}) {
    return [...this.operations.values()]
      .sort((left, right) => String(right.at).localeCompare(String(left.at)))
      .slice(0, Math.max(1, Number(limit) || 100))
      .map((record) => structuredClone(record));
  }
}

module.exports = { ToolJournal, appendFsynced, sha256 };
