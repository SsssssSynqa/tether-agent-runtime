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
    result?.vectors?.status,
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
    onState = () => {},
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
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.timer = null;
    this.running = false;
    this.started = false;
    this.stopped = true;
    this.runAgain = false;
    this.consecutiveFailures = 0;
  }

  _emitState(record) {
    try { this.onState(record); } catch (error) {
      this.log(`[tether] maintenance state reporter failed: ${error.message}`);
    }
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
    this._emitState({ state: 'scheduled', consecutiveFailures: this.consecutiveFailures });
    this._schedule(0);
    return true;
  }

  stop() {
    const wasRunning = !this.stopped;
    this.stopped = true;
    this.runAgain = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this._emitState({ state: 'stopped', consecutiveFailures: this.consecutiveFailures });
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

  // 2026-08-18：失败日志限流窗口——10 分钟内至多放行一条（失败与恢复共用一个窗口）。
  // 返回 true 时同时占用窗口；窗口内的调用返回 false，由调用方计入 suppressed。
  _failLogWindowOpen() {
    const now = Date.now();
    if (!this._lastFailLogAt || now - this._lastFailLogAt > 10 * 60 * 1000) {
      this._lastFailLogAt = now;
      return true;
    }
    return false;
  }

  async _cycle() {
    if (this.stopped) return;
    if (this.running) {
      this.runAgain = true;
      return;
    }
    this.running = true;
    this._emitState({ state: 'running', consecutiveFailures: this.consecutiveFailures });
    let nextDelay = this.idleIntervalMs;
    try {
      const result = await this.runOnce();
      // 2026-08-18：失败→成功震荡时报告恢复（纳入同一限流窗口，防震荡刷屏）
      if (this.consecutiveFailures > 0 && this._failLogWindowOpen()) {
        this.log('[tether] memory supervisor recovered');
      }
      this.consecutiveFailures = 0;
      this._emitState({ state: 'healthy', consecutiveFailures: 0, result });
      if (resultDidWork(result)) nextDelay = this.activeDelayMs;
    } catch (error) {
      this.consecutiveFailures += 1;
      this._emitState({ state: 'backoff', consecutiveFailures: this.consecutiveFailures });
      nextDelay = Math.min(
        this.errorMaxDelayMs,
        this.errorBaseDelayMs * (2 ** Math.min(this.consecutiveFailures - 1, 10)),
      );
      // 2026-08-18：两处修整——①时间限流：渠道级故障（如上游配额耗尽）会让失败↔成功
      // 反复震荡，每 30s 一条日志把终端对话界面刷成瀑布（Syrah 8/18 实况），改为
      // 10 分钟窗口内只打一条并统计被抑制的条数；②AggregateError 展开：只打
      // error.message 会把子错误全部吞掉（"One or more jobs failed" 无法诊断），
      // 附上各子错误的首行摘要。
      if (this._failLogWindowOpen()) {
        const sub = Array.isArray(error.errors) && error.errors.length
          ? ` [${error.errors.map((e) => String((e && e.message) || e).split('\n')[0].slice(0, 100)).join(' | ').slice(0, 400)}]`
          : '';
        const muted = this._suppressedFailLogs
          ? ` (+${this._suppressedFailLogs} suppressed in last window)`
          : '';
        this._suppressedFailLogs = 0;
        this.log(
          `[tether] memory supervisor retry ${this.consecutiveFailures} scheduled in `
          + `${nextDelay}ms: ${error.message}${sub}${muted}`,
        );
      } else {
        this._suppressedFailLogs = (this._suppressedFailLogs || 0) + 1;
      }
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
