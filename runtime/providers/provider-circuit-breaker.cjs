// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
const DEFAULT_THRESHOLD = 5;

function closedState(threshold = DEFAULT_THRESHOLD) {
  return {
    version: STATE_VERSION,
    status: 'closed',
    threshold: Math.max(1, Number(threshold) || DEFAULT_THRESHOLD),
    causalFailureKeys: [],
    openedAt: null,
    lastFailureAt: null,
    clearedAt: null,
    clearReason: null,
  };
}

function publicCircuitState(state) {
  return {
    version: STATE_VERSION,
    status: state.status,
    threshold: state.threshold,
    distinctFailures: state.causalFailureKeys.length,
    openedAt: state.openedAt,
    lastFailureAt: state.lastFailureAt,
    clearedAt: state.clearedAt,
    clearReason: state.clearReason,
  };
}

function validateState(value, threshold = DEFAULT_THRESHOLD) {
  if (!value || value.version !== STATE_VERSION) throw new Error('Provider circuit state version is invalid');
  if (!['closed', 'open'].includes(value.status)) throw new Error('Provider circuit state status is invalid');
  if (!Array.isArray(value.causalFailureKeys) || value.causalFailureKeys.some((key) => typeof key !== 'string')) {
    throw new Error('Provider circuit failure keys are invalid');
  }
  const state = {
    ...closedState(threshold),
    ...value,
    threshold: Math.max(1, Number(value.threshold) || Number(threshold) || DEFAULT_THRESHOLD),
    causalFailureKeys: [...new Set(value.causalFailureKeys)],
  };
  if (state.status === 'open' && state.causalFailureKeys.length < state.threshold) {
    throw new Error('Open provider circuit lacks the required distinct failures');
  }
  return state;
}

function readProviderCircuitState(filePath, { threshold = DEFAULT_THRESHOLD } = {}) {
  if (!fs.existsSync(filePath)) return publicCircuitState(closedState(threshold));
  const state = validateState(JSON.parse(fs.readFileSync(filePath, 'utf8')), threshold);
  return publicCircuitState(state);
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function failureKey(causalId) {
  return crypto.createHash('sha256').update(String(causalId)).digest('hex');
}

function circuitOpenError({ threshold = DEFAULT_THRESHOLD, justOpened = false, cause = null } = {}) {
  const error = new Error(
    `Provider circuit is open after ${threshold} distinct causal failures; manual recovery is required`,
    cause ? { cause } : undefined,
  );
  error.code = 'TETHER_PROVIDER_CIRCUIT_OPEN';
  error.circuitOpen = true;
  error.manualRetryOnly = true;
  error.circuitJustOpened = justOpened;
  return error;
}

class ProviderCircuitBreaker {
  constructor({
    filePath,
    threshold = DEFAULT_THRESHOLD,
    onOpen = null,
    log = console.error,
  } = {}) {
    if (!filePath) throw new Error('Provider circuit breaker requires a state file');
    this.filePath = path.resolve(filePath);
    this.threshold = Math.max(1, Number(threshold) || DEFAULT_THRESHOLD);
    this.onOpen = typeof onOpen === 'function' ? onOpen : null;
    this.log = log;
    const existed = fs.existsSync(this.filePath);
    this.state = existed
      ? validateState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')), this.threshold)
      : closedState(this.threshold);
    if (this.state.status === 'closed') this.state.threshold = this.threshold;
    if (!existed || this.state.status === 'closed') writePrivateJson(this.filePath, this.state);
    else fs.chmodSync(this.filePath, 0o600);
  }

  status() {
    return publicCircuitState(this.state);
  }

  _write() {
    writePrivateJson(this.filePath, this.state);
  }

  _success() {
    if (this.state.status !== 'closed' || this.state.causalFailureKeys.length === 0) return;
    this.state = closedState(this.threshold);
    this._write();
  }

  _failure(causalId) {
    const key = failureKey(causalId);
    if (!this.state.causalFailureKeys.includes(key)) this.state.causalFailureKeys.push(key);
    this.state.lastFailureAt = new Date().toISOString();
    let justOpened = false;
    if (this.state.status !== 'open' && this.state.causalFailureKeys.length >= this.threshold) {
      this.state.status = 'open';
      this.state.openedAt = this.state.lastFailureAt;
      justOpened = true;
    }
    this._write();
    if (justOpened && this.onOpen) {
      Promise.resolve(this.onOpen(this.status())).catch((error) => {
        this.log(`[tether] provider circuit notification failed: ${error.message}`);
      });
    }
    return justOpened;
  }

  clear(reason = 'operator-manual-clear') {
    this.state = {
      ...closedState(this.threshold),
      clearedAt: new Date().toISOString(),
      clearReason: String(reason || 'operator-manual-clear').slice(0, 200),
    };
    this._write();
    return this.status();
  }

  async run(causalId, operation) {
    if (!causalId) return operation();
    if (this.state.status === 'open') throw circuitOpenError({ threshold: this.state.threshold });
    try {
      const result = await operation();
      this._success();
      return result;
    } catch (error) {
      if (error?.providerFailure === true) {
        const justOpened = this._failure(causalId);
        if (this.state.status === 'open') {
          throw circuitOpenError({ threshold: this.state.threshold, justOpened, cause: error });
        }
      }
      throw error;
    }
  }

  wrap(provider) {
    if (!provider || typeof provider.respond !== 'function') throw new Error('Provider circuit requires a provider adapter');
    return {
      ...provider,
      canResume: provider.canResume?.bind(provider),
      respond: (request = {}) => this.run(request.causalId, () => provider.respond(request)),
      embed: provider.embed?.bind(provider),
      circuitStatus: () => this.status(),
    };
  }
}

module.exports = {
  DEFAULT_THRESHOLD,
  ProviderCircuitBreaker,
  circuitOpenError,
  readProviderCircuitState,
};
