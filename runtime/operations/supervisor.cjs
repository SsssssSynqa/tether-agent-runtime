// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acquireInstanceLock } = require('../instance-lock.cjs');
const { evaluateRuntimeHealth, readRuntimeHealth } = require('./health.cjs');

function restartDelay(attempt, {
  baseMs = 1_000,
  maxMs = 60_000,
  random = Math.random,
} = {}) {
  const exponential = Math.min(
    Math.max(baseMs, maxMs),
    Math.max(1, Number(baseMs) || 1_000) * (2 ** Math.min(Math.max(0, attempt - 1), 10)),
  );
  const jitter = 0.8 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4);
  return Math.max(1, Math.min(Number(maxMs) || 60_000, Math.round(exponential * jitter)));
}

class RestartBudget {
  constructor({ maxRestarts = 8, windowMs = 5 * 60_000 } = {}) {
    this.maxRestarts = Math.max(1, Number(maxRestarts) || 8);
    this.windowMs = Math.max(1_000, Number(windowMs) || 5 * 60_000);
    this.timestamps = [];
  }

  record(now = Date.now()) {
    const cutoff = Number(now) - this.windowMs;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp >= cutoff);
    this.timestamps.push(Number(now));
    return {
      allowed: this.timestamps.length <= this.maxRestarts,
      count: this.timestamps.length,
      maxRestarts: this.maxRestarts,
      windowMs: this.windowMs,
    };
  }
}

class TetherSupervisor {
  constructor({
    configPath,
    storageRoot,
    settings = {},
    runtimeEntrypoint = path.resolve(__dirname, '..', '..', 'bin', 'tether.cjs'),
    spawnImpl = spawn,
    clock = () => Date.now(),
    random = Math.random,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    log = console.error,
    installSignalHandlers = true,
  } = {}) {
    if (!configPath || !storageRoot) throw new Error('TetherSupervisor requires configPath and storageRoot');
    this.configPath = path.resolve(configPath);
    this.storageRoot = path.resolve(storageRoot);
    this.runtimeEntrypoint = path.resolve(runtimeEntrypoint);
    this.spawnImpl = spawnImpl;
    this.clock = clock;
    this.random = random;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.log = log;
    this.installSignalHandlers = installSignalHandlers;
    this.settings = {
      monitorIntervalMs: Number(settings.monitorIntervalMs || 5_000),
      heartbeatStaleMs: Number(settings.heartbeatStaleMs || 30_000),
      readyTimeoutMs: Number(settings.readyTimeoutMs || 60_000),
      restartBaseMs: Number(settings.restartBaseMs || 1_000),
      restartMaxMs: Number(settings.restartMaxMs || 60_000),
      restartWindowMs: Number(settings.restartWindowMs || 5 * 60_000),
      maxRestartsPerWindow: Number(settings.maxRestartsPerWindow || 8),
      shutdownGraceMs: Number(settings.shutdownGraceMs || 15_000),
    };
    this.healthFile = path.join(this.storageRoot, 'runtime-health.json');
    this.budget = new RestartBudget({
      maxRestarts: this.settings.maxRestartsPerWindow,
      windowMs: this.settings.restartWindowMs,
    });
    this.child = null;
    this.runId = null;
    this.spawnedAt = 0;
    this.restartAttempt = 0;
    this.stopping = false;
    this.terminatingChild = false;
    this.monitorTimer = null;
    this.restartTimer = null;
    this.killTimer = null;
    this.lock = null;
    this.signalHandlers = new Map();
    this.completion = null;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  _clearChildTimers() {
    if (this.monitorTimer) this.clearIntervalImpl(this.monitorTimer);
    if (this.killTimer) this.clearTimeoutImpl(this.killTimer);
    this.monitorTimer = null;
    this.killTimer = null;
  }

  _installSignals() {
    if (!this.installSignalHandlers) return;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => this.stop(signal);
      this.signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  _removeSignals() {
    for (const [signal, handler] of this.signalHandlers) process.removeListener(signal, handler);
    this.signalHandlers.clear();
  }

  _finish(error = null) {
    this._clearChildTimers();
    if (this.restartTimer) this.clearTimeoutImpl(this.restartTimer);
    this.restartTimer = null;
    this._removeSignals();
    try { this.lock?.release(); } catch (_) { /* shutdown is best effort */ }
    this.lock = null;
    if (error) this.rejectCompletion?.(error);
    else this.resolveCompletion?.();
  }

  _scheduleRestart(reason) {
    const budget = this.budget.record(this.clock());
    if (!budget.allowed) {
      const error = new Error(
        `Tether restart budget exhausted (${budget.count}/${budget.maxRestarts} in ${budget.windowMs}ms)`,
      );
      error.code = 'TETHER_SUPERVISOR_CRASH_LOOP';
      this._finish(error);
      return;
    }
    this.restartAttempt += 1;
    const delay = restartDelay(this.restartAttempt, {
      baseMs: this.settings.restartBaseMs,
      maxMs: this.settings.restartMaxMs,
      random: this.random,
    });
    this.log(`[tether-supervisor] restart in ${delay}ms (${reason})`);
    this.restartTimer = this.setTimeoutImpl(() => {
      this.restartTimer = null;
      this._spawnChildSafe('scheduled restart');
    }, delay);
  }

  _spawnChildSafe(reason) {
    try {
      this._spawnChild();
      return true;
    } catch (error) {
      this.log(`[tether-supervisor] child spawn threw (${reason}): ${error.message}`);
      if (this.stopping) this._finish();
      else this._scheduleRestart('spawn-threw');
      return false;
    }
  }

  _onChildExit(child, code, signal) {
    if (child !== this.child) return;
    this._clearChildTimers();
    this.child = null;
    this.terminatingChild = false;
    if (this.stopping) {
      this._finish();
      return;
    }
    const uptime = this.clock() - this.spawnedAt;
    if (uptime >= this.settings.restartWindowMs) this.restartAttempt = 0;
    this._scheduleRestart(`exit code=${code ?? 'null'} signal=${signal || 'none'}`);
  }

  _terminateChild(reason) {
    if (!this.child || this.terminatingChild) return;
    this.terminatingChild = true;
    this.log(`[tether-supervisor] restarting unhealthy runtime (${reason})`);
    this.child.kill('SIGTERM');
    this.killTimer = this.setTimeoutImpl(() => {
      if (this.child) this.child.kill('SIGKILL');
    }, this.settings.shutdownGraceMs);
    this.killTimer?.unref?.();
  }

  _monitor() {
    if (!this.child || this.stopping) return;
    const decision = evaluateRuntimeHealth(readRuntimeHealth(this.healthFile), {
      expectedRunId: this.runId,
      now: this.clock(),
      spawnedAt: this.spawnedAt,
      readyTimeoutMs: this.settings.readyTimeoutMs,
      staleAfterMs: this.settings.heartbeatStaleMs,
    });
    if (decision.action === 'restart') this._terminateChild(decision.reason);
  }

  _spawnChild() {
    if (this.stopping) return;
    this.runId = crypto.randomUUID();
    this.spawnedAt = this.clock();
    this.terminatingChild = false;
    const child = this.spawnImpl(process.execPath, [this.runtimeEntrypoint, this.configPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        TETHER_SUPERVISOR_RUN_ID: this.runId,
        TETHER_SUPERVISOR_PID: String(process.pid),
        TETHER_SUPERVISOR_TOKEN: this.lock.token,
      },
    });
    this.child = child;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      this._onChildExit(child, code, signal);
    };
    child.once('exit', finish);
    child.once('error', (error) => {
      this.log(`[tether-supervisor] child spawn failed: ${error.message}`);
      finish(null, 'spawn-error');
    });
    this.monitorTimer = this.setIntervalImpl(
      () => this._monitor(),
      this.settings.monitorIntervalMs,
    );
    this.monitorTimer?.unref?.();
  }

  start() {
    if (this.completion) return this.completion;
    this.lock = acquireInstanceLock(path.join(this.storageRoot, '.tether-supervisor.lock'));
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this._installSignals();
    this._spawnChildSafe('initial start');
    return this.completion;
  }

  stop(signal = 'SIGTERM') {
    if (this.stopping) return;
    this.stopping = true;
    if (this.restartTimer) this.clearTimeoutImpl(this.restartTimer);
    this.restartTimer = null;
    if (!this.child) {
      this._finish();
      return;
    }
    this.child.kill(signal);
    this.killTimer = this.setTimeoutImpl(() => {
      if (this.child) this.child.kill('SIGKILL');
    }, this.settings.shutdownGraceMs);
    this.killTimer?.unref?.();
  }
}

module.exports = {
  RestartBudget,
  TetherSupervisor,
  restartDelay,
};
