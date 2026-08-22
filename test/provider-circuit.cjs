// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ProviderCircuitBreaker,
  readProviderCircuitState,
} = require('../runtime/providers/provider-circuit-breaker.cjs');
const { classifyDurableError } = require('../runtime/durable/durable-error-policy.js');

function providerFailure() {
  const error = new Error('Every configured provider failed');
  error.providerFailure = true;
  return error;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-provider-circuit-'));
  const filePath = path.join(root, 'provider-circuit.json');
  let calls = 0;
  let opened = 0;
  const base = {
    async respond() {
      calls += 1;
      throw providerFailure();
    },
  };
  const breaker = new ProviderCircuitBreaker({
    filePath,
    threshold: 5,
    onOpen: () => { opened += 1; },
    log: () => {},
  });
  const wrapped = breaker.wrap(base);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  for (let index = 1; index <= 4; index += 1) {
    await assert.rejects(() => wrapped.respond({ causalId: `causal:${index}` }), (error) => (
      error.providerFailure === true && !error.circuitOpen
    ));
  }
  await assert.rejects(() => wrapped.respond({ causalId: 'causal:4' }), (error) => (
    error.providerFailure === true && !error.circuitOpen
  ));
  assert.equal(breaker.status().distinctFailures, 4, 'same causal request counts once');
  await assert.rejects(() => wrapped.respond({ causalId: 'causal:5' }), (error) => (
    error.circuitOpen === true && error.circuitJustOpened === true
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 1, 'trip notification fires once');
  assert.equal(calls, 6);
  await assert.rejects(() => wrapped.respond({ causalId: 'causal:6' }), (error) => (
    error.code === 'TETHER_PROVIDER_CIRCUIT_OPEN'
  ));
  assert.equal(calls, 6, 'open circuit makes no provider call');

  const reloaded = new ProviderCircuitBreaker({ filePath, threshold: 5, log: () => {} });
  assert.equal(reloaded.status().status, 'open', 'open state survives restart');
  assert.equal(classifyDurableError(
    await wrapped.respond({ causalId: 'causal:7' }).catch((error) => error),
  ).action, 'operator-pause', 'open circuit requires explicit operator recovery');
  reloaded.clear('test-manual-clear');
  assert.equal(readProviderCircuitState(filePath).status, 'closed');

  let succeeds = false;
  const resetting = new ProviderCircuitBreaker({ filePath, threshold: 5, log: () => {} }).wrap({
    async respond() {
      if (succeeds) return { text: 'ok', providerId: 'test' };
      throw providerFailure();
    },
  });
  await assert.rejects(() => resetting.respond({ causalId: 'reset:1' }), (error) => (
    error.providerFailure === true && !error.circuitOpen
  ));
  succeeds = true;
  await resetting.respond({ causalId: 'reset:2' });
  assert.equal(readProviderCircuitState(filePath).distinctFailures, 0, 'success resets pre-trip failures');

  process.stdout.write('provider circuit breaker: pass\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
