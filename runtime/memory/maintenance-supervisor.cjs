#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

function boundedDelay(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function resultDidWork(result) {
  const statuses = [
    result?.status,
    result?.semantic?.status,
    result?.cards?.status,
  ].map((value) => String(value || ''));
  return statuses.some((status) => [
    'generated',
    'partial-review-queued',
    'needs-human-review',
    'completed-after-review',
    'duplicate',
  ].includes(status));
}

class MemoryMaintenanceSupervisor {
  constructor({
    memory,
    idleIntervalMs = 30_000,
    activeDelayMs = 250,
    errorBaseDelayMs = 30_000,
    errorMaxDelayMs = 60 * 60 * 1000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = console.log,
  } = {}) {
    if (typeof memory?.maintainOne !== 'function') {
      throw new Error('MemoryMaintenanceSupervisor requires memory.maintainOne');
    }
    this.memory = memory;
    this.idleIntervalMs = boundedDelay(idleIntervalMs, 30_000, 1_000, 24 * 60 * 60 * 1000);
    this.activeDelayMs = boundedDelay(activeDelayMs, 250, 0, this.idleIntervalMs);
    this.errorBaseDelayMs = boundedDelay(
      errorBaseDelayMs,
      30_000,
      1_000,
      60 * 60 * 1000,
    );
    this.errorMaxDelayMs = boundedDelay(
      errorMaxDelayMs,
      60 * 60 * 1000,
      this.errorBaseDelayMs,
      24 * 60 * 60 * 1000,
    );
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.timer = null;
    this.running = false;
    this.started = false;
    this.stopped = true;
    this.runAgain = false;
    this.consecutiveFailures = 0;
  }

  _schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this._cycle();
    }, Math.max(0, Number(delayMs) || 0));
    this.timer?.unref?.();
  }

  start() {
    if (this.started && !this.stopped) return false;
    this.started = true;
    this.stopped = false;
    this._schedule(0);
    return true;
  }

  stop() {
    const wasRunning = !this.stopped;
    this.stopped = true;
    this.runAgain = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    return wasRunning;
  }

  trigger() {
    if (this.stopped) return false;
    if (this.running) {
      this.runAgain = true;
      return true;
    }
    this._schedule(0);
    return true;
  }

  async runOnce() {
    return this.memory.maintainOne();
  }

  async _cycle() {
    if (this.stopped) return;
    if (this.running) {
      this.runAgain = true;
      return;
    }
    this.running = true;
    let nextDelay = this.idleIntervalMs;
    try {
      const result = await this.runOnce();
      this.consecutiveFailures = 0;
      if (resultDidWork(result)) nextDelay = this.activeDelayMs;
    } catch (error) {
      this.consecutiveFailures += 1;
      nextDelay = Math.min(
        this.errorMaxDelayMs,
        this.errorBaseDelayMs * (2 ** Math.min(this.consecutiveFailures - 1, 10)),
      );
      this.log(
        `[tether] memory supervisor retry ${this.consecutiveFailures} scheduled in `
        + `${nextDelay}ms: ${error.message}`,
      );
    } finally {
      this.running = false;
      if (this.runAgain) {
        this.runAgain = false;
        nextDelay = 0;
      }
      this._schedule(nextDelay);
    }
  }
}

module.exports = {
  MemoryMaintenanceSupervisor,
  boundedDelay,
  resultDidWork,
};
