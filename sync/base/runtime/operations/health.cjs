// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readLock } = require('../instance-lock.cjs');
const { writeJsonAtomic } = require('./storage-schema.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function readRuntimeHealth(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('health path is not a regular file');
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (
      record?.schemaVersion !== 1
      || !record.runId
      || !Number.isInteger(Number(record.pid))
      || !record.updatedAt
      || !['starting', 'ready', 'fatal', 'stopped'].includes(record.state)
    ) throw new Error('health record has an invalid shape');
    return { status: 'available', record };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', record: null };
    return { status: 'invalid', record: null, error: error.message };
  }
}

function evaluateRuntimeHealth(health, {
  expectedRunId = null,
  now = Date.now(),
  spawnedAt = now,
  readyTimeoutMs = 60_000,
  staleAfterMs = 30_000,
} = {}) {
  const elapsed = Math.max(0, Number(now) - Number(spawnedAt));
  if (!health || health.status === 'missing') {
    return elapsed > readyTimeoutMs
      ? { action: 'restart', reason: 'health-missing' }
      : { action: 'wait', reason: 'health-pending' };
  }
  if (health.status !== 'available') return { action: 'restart', reason: 'health-invalid' };
  const record = health.record;
  if (expectedRunId && record.runId !== expectedRunId) {
    return elapsed > readyTimeoutMs
      ? { action: 'restart', reason: 'health-run-mismatch' }
      : { action: 'wait', reason: 'health-run-pending' };
  }
  if (record.state === 'fatal') return { action: 'restart', reason: 'runtime-fatal' };
  if (record.state === 'stopped') return { action: 'restart', reason: 'runtime-stopped' };
  const updatedAt = new Date(record.updatedAt).getTime();
  if (!Number.isFinite(updatedAt) || Number(now) - updatedAt > staleAfterMs) {
    return { action: 'restart', reason: 'heartbeat-stale' };
  }
  if (record.state === 'starting' && elapsed > readyTimeoutMs) {
    return { action: 'restart', reason: 'readiness-timeout' };
  }
  return record.state === 'ready'
    ? { action: 'healthy', reason: 'ready' }
    : { action: 'wait', reason: 'starting' };
}

class RuntimeHealthReporter {
  constructor({
    filePath,
    runId = process.env.TETHER_SUPERVISOR_RUN_ID || crypto.randomUUID(),
    pid = process.pid,
    intervalMs = 5_000,
    clock = () => new Date().toISOString(),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onWriteError = () => {},
    supervisorPid = process.env.TETHER_SUPERVISOR_PID || null,
    supervisorToken = process.env.TETHER_SUPERVISOR_TOKEN || null,
  } = {}) {
    if (!filePath) throw new Error('RuntimeHealthReporter requires filePath');
    this.filePath = path.resolve(filePath);
    this.runId = String(runId);
    this.pid = Number(pid);
    this.intervalMs = Math.max(1_000, Number(intervalMs) || 5_000);
    this.clock = clock;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.onWriteError = onWriteError;
    this.supervisorPid = supervisorPid == null ? null : Number(supervisorPid);
    this.supervisorToken = supervisorToken == null ? null : String(supervisorToken);
    this.timer = null;
    this.record = {
      schemaVersion: 1,
      runId: this.runId,
      pid: this.pid,
      state: 'starting',
      startedAt: this.clock(),
      updatedAt: null,
      agentId: null,
      sessionAnchorSha256: null,
      storageSchemaVersion: null,
      lastActivityAt: null,
      lastActivityChannel: null,
      maintenance: { state: 'starting', consecutiveFailures: 0, updatedAt: null },
      fatalCode: null,
    };
  }

  _write() {
    this.record.updatedAt = this.clock();
    writeJsonAtomic(this.filePath, this.record);
  }

  _safeWrite() {
    try {
      if (this.supervisorPid) {
        try { process.kill(this.supervisorPid, 0); } catch (error) {
          if (error.code !== 'EPERM') {
            const failure = new Error('Tether supervisor process is no longer alive');
            failure.code = 'TETHER_SUPERVISOR_GONE';
            throw failure;
          }
        }
        if (this.supervisorToken) {
          const lock = readLock(path.join(path.dirname(this.filePath), '.tether-supervisor.lock'));
          if (
            !lock
            || lock.pid !== this.supervisorPid
            || lock.token !== this.supervisorToken
          ) {
            const failure = new Error('Tether supervisor lock identity no longer matches');
            failure.code = 'TETHER_SUPERVISOR_GONE';
            throw failure;
          }
        }
      }
      this._write();
    } catch (error) { this.onWriteError(error); }
  }

  start({ agentId = null, storageSchemaVersion = null } = {}) {
    this.record.agentId = agentId == null ? null : String(agentId);
    this.record.storageSchemaVersion = storageSchemaVersion == null
      ? null
      : Number(storageSchemaVersion);
    this._write();
    if (!this.timer) {
      this.timer = this.setIntervalImpl(() => this._safeWrite(), this.intervalMs);
      if (!this.supervisorPid) this.timer?.unref?.();
    }
    return structuredClone(this.record);
  }

  ready({ sessionId } = {}) {
    this.record.state = 'ready';
    this.record.sessionAnchorSha256 = sessionId == null ? null : sha256(sessionId);
    this._write();
  }

  noteActivity({ channelId = null } = {}) {
    this.record.lastActivityAt = this.clock();
    this.record.lastActivityChannel = channelId == null ? null : String(channelId);
  }

  noteMaintenance({ state, consecutiveFailures = 0 } = {}) {
    this.record.maintenance = {
      state: String(state || 'unknown'),
      consecutiveFailures: Number(consecutiveFailures) || 0,
      updatedAt: this.clock(),
    };
  }

  fatal(error) {
    this.record.state = 'fatal';
    this.record.fatalCode = String(error?.code || 'TETHER_RUNTIME_FATAL');
    this._safeWrite();
  }

  stop() {
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
    if (this.record.state !== 'fatal') this.record.state = 'stopped';
    this._safeWrite();
  }
}

module.exports = {
  RuntimeHealthReporter,
  evaluateRuntimeHealth,
  readRuntimeHealth,
  sha256,
};
