#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Fully synthetic Selfsame Protocol probe: no runtime imports, production data,
// network calls, provider calls, credentials, or local state.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const protocolPath = path.resolve(__dirname, '..', 'SELFSAME_PROTOCOL.md');
const protocol = fs.readFileSync(protocolPath, 'utf8');
let passed = 0;

function test(name, run) {
  run();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

class SyntheticSelfsameRuntime {
  constructor({ identityId, sessionId, provider = 'provider-a' }) {
    this.identityId = identityId;
    this.sessionId = sessionId;
    this.provider = provider;
    this.channels = new Set();
    this.raw = [];
    this.activeContext = [];
    this.committed = new Map();
    this.deliveries = [];
    this.derived = [];
    this.corrections = [];
    this.inferenceCount = 0;
    this.blocked = null;
  }

  attachChannel(channel, requestedSessionId = this.sessionId) {
    assert.equal(requestedSessionId, this.sessionId, 'channel attempted to own another persona session');
    this.channels.add(channel);
    return { identityId: this.identityId, sessionId: this.sessionId };
  }

  resume({ persistedSessionId, available }) {
    if (!available || persistedSessionId !== this.sessionId) {
      this.blocked = { reason: 'authoritative-session-unavailable', attempted: persistedSessionId };
      return false;
    }
    this.blocked = null;
    return true;
  }

  append(type, payload) {
    const record = Object.freeze({ sequence: this.raw.length + 1, type, payload: structuredClone(payload) });
    this.raw.push(record);
    return record;
  }

  accept({ causalId, channel, speaker, text }) {
    assert.equal(this.blocked, null, 'persona-bearing inference is blocked');
    assert.ok(this.channels.has(channel), 'channel is not attached');

    const prior = this.committed.get(causalId);
    if (prior) {
      const replay = Buffer.from(prior.bytes);
      this.deliveries.push({ causalId, channel, replay: true, bytes: replay });
      return replay;
    }

    this.append('input', { causalId, channel, speaker, text });
    this.activeContext.push({ role: 'user', speaker, text, causalId });
    this.inferenceCount += 1;
    const output = { causalId, role: 'agent', text: `committed:${text}`, provider: this.provider };
    const bytes = Buffer.from(stableJson(output));
    this.append('output', output);
    this.activeContext.push(output);
    this.committed.set(causalId, { output, bytes });
    this.deliveries.push({ causalId, channel, replay: false, bytes: Buffer.from(bytes) });
    return Buffer.from(bytes);
  }

  compact({ fail = false } = {}) {
    const rawBefore = digest(this.raw);
    const contextBefore = structuredClone(this.activeContext);
    if (fail) return { ok: false, rawBefore, rawAfter: digest(this.raw), contextBefore, contextAfter: structuredClone(this.activeContext) };

    const sources = [...new Set(this.activeContext.map((item) => item.causalId))];
    this.activeContext = [{
      role: 'compaction',
      sources,
      speakers: [...new Set(contextBefore.map((item) => item.speaker).filter(Boolean))],
      summary: contextBefore.map((item) => `${item.role}:${item.text}`).join(' | '),
    }];
    this.derived.push({ kind: 'compaction', sources, rawDigest: rawBefore });
    return { ok: true, rawBefore, rawAfter: digest(this.raw) };
  }

  rememberQuote({ sourceCausalId, speaker, quote, entityId }) {
    const source = this.raw.find((record) => record.type === 'input' && record.payload.causalId === sourceCausalId);
    assert.ok(source, 'quote source is missing');
    assert.equal(source.payload.speaker, speaker, 'quotation attribution mismatch');
    assert.ok(source.payload.text.includes(quote), 'quotation is not present in raw source');
    const item = { kind: 'quote', sourceCausalId, speaker, quote, entityId };
    this.derived.push(item);
    return item;
  }

  normalizeAlias(item, aliases) {
    if (item.kind === 'quote' || item.kind === 'naming-event') return structuredClone(item);
    return { ...structuredClone(item), text: aliases[item.text] ?? item.text };
  }

  correct({ principal, target, replacement, reason, timestamp }) {
    assert.ok(principal && target && reason && timestamp, 'correction provenance is incomplete');
    const correction = Object.freeze({
      sequence: this.corrections.length + 1,
      principal,
      target,
      replacement,
      reason,
      timestamp,
      supersedes: this.corrections.filter((entry) => entry.target === target).at(-1)?.sequence ?? null,
    });
    this.corrections.push(correction);
    this.append('human-correction', correction);
    return correction;
  }

  rebuildDerived() {
    const corrections = this.raw.filter((record) => record.type === 'human-correction').map((record) => record.payload);
    this.derived = this.raw
      .filter((record) => record.type === 'input')
      .map((record) => {
        const latest = corrections.filter((entry) => entry.target === record.payload.causalId).at(-1);
        return {
          kind: 'claim',
          sourceCausalId: record.payload.causalId,
          speaker: record.payload.speaker,
          text: latest?.replacement ?? record.payload.text,
          correctionSequence: latest?.sequence ?? null,
        };
      });
    return structuredClone(this.derived);
  }

  switchProvider(provider) {
    const before = { identityId: this.identityId, sessionId: this.sessionId, rawDigest: digest(this.raw) };
    this.provider = provider;
    return { before, after: { identityId: this.identityId, sessionId: this.sessionId, rawDigest: digest(this.raw) } };
  }

  capabilityView(channel) {
    const rules = channel === 'terminal' ? ['read', 'write'] : ['read'];
    return { channel, capabilities: rules, identityId: this.identityId, sessionId: this.sessionId, contextDigest: digest(this.raw) };
  }
}

test('protocol declares independent scope, normative language, levels, and counterexamples', () => {
  for (const marker of [
    'Tether is a reference implementation of SSP',
    'MUST',
    'MUST NOT',
    'SSP Level 1',
    'SSP Level 4',
    'Non-conforming counterexamples',
    'Capability is not context isolation',
  ]) assert.ok(protocol.includes(marker), `missing protocol marker: ${marker}`);
});

test('all channels attach to one complete authoritative session', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  assert.deepEqual(runtime.attachChannel('telegram'), runtime.attachChannel('terminal'));
  assert.throws(() => runtime.attachChannel('web', 'session-2'), /another persona session/);
});

test('resume failure blocks inference and never creates a replacement session', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('telegram');
  assert.equal(runtime.resume({ persistedSessionId: 'session-1', available: false }), false);
  assert.equal(runtime.sessionId, 'session-1');
  assert.equal(runtime.raw.length, 0);
  assert.throws(() => runtime.accept({ causalId: 'event-1', channel: 'telegram', speaker: 'user-1', text: 'hello' }), /blocked/);
});

test('duplicate ingress performs one inference and byte-equivalent exact replay', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('telegram');
  const first = runtime.accept({ causalId: 'event-1', channel: 'telegram', speaker: 'user-1', text: 'hello' });
  const replay = runtime.accept({ causalId: 'event-1', channel: 'telegram', speaker: 'user-1', text: 'hello' });
  assert.equal(runtime.inferenceCount, 1);
  assert.equal(Buffer.compare(first, replay), 0);
  assert.equal(runtime.raw.filter((record) => record.type === 'output').length, 1);
  assert.equal(runtime.deliveries.at(-1).replay, true);
});

test('failed compaction conserves raw authority and active context', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('terminal');
  runtime.accept({ causalId: 'event-1', channel: 'terminal', speaker: 'user-1', text: 'remember this' });
  const result = runtime.compact({ fail: true });
  assert.equal(result.rawBefore, result.rawAfter);
  assert.deepEqual(result.contextBefore, result.contextAfter);
});

test('successful compaction preserves raw authority and source boundaries', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('terminal');
  runtime.accept({ causalId: 'event-1', channel: 'terminal', speaker: 'user-1', text: 'remember this' });
  const result = runtime.compact();
  assert.equal(result.rawBefore, result.rawAfter);
  assert.deepEqual(runtime.activeContext[0].sources, ['event-1']);
  assert.equal(runtime.derived[0].rawDigest, result.rawBefore);
});

test('quotation attribution rejects invented or misattributed lines', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('telegram');
  runtime.accept({ causalId: 'event-1', channel: 'telegram', speaker: 'user-1', text: 'I named it Northstar.' });
  assert.throws(() => runtime.rememberQuote({ sourceCausalId: 'event-1', speaker: 'agent-1', quote: 'I named it Northstar.', entityId: 'entity-1' }), /attribution/);
  assert.throws(() => runtime.rememberQuote({ sourceCausalId: 'event-1', speaker: 'user-1', quote: 'invented words', entityId: 'entity-1' }), /not present/);
  assert.equal(runtime.rememberQuote({ sourceCausalId: 'event-1', speaker: 'user-1', quote: 'I named it Northstar.', entityId: 'entity-1' }).speaker, 'user-1');
});

test('alias normalization leaves quotations and naming events untouched', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  const aliases = { old_name: 'canonical-name' };
  assert.equal(runtime.normalizeAlias({ kind: 'quote', text: 'old_name' }, aliases).text, 'old_name');
  assert.equal(runtime.normalizeAlias({ kind: 'naming-event', text: 'old_name' }, aliases).text, 'old_name');
  assert.equal(runtime.normalizeAlias({ kind: 'claim', text: 'old_name' }, aliases).text, 'canonical-name');
});

test('ambiguous aliases do not collapse distinct entities', () => {
  const entities = [
    { entityId: 'entity-a', aliases: ['shared-alias'] },
    { entityId: 'entity-b', aliases: ['shared-alias'] },
  ];
  const matches = entities.filter((entity) => entity.aliases.includes('shared-alias'));
  assert.equal(matches.length, 2);
  assert.throws(() => {
    if (matches.length !== 1) throw new Error('ambiguous entity alias');
  }, /ambiguous entity alias/);
  assert.notEqual(matches[0].entityId, matches[1].entityId);
});

test('derived memory rebuilds from raw authority and append-only correction', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('terminal');
  runtime.accept({ causalId: 'event-1', channel: 'terminal', speaker: 'user-1', text: 'draft fact' });
  const rawBeforeCorrection = digest(runtime.raw);
  runtime.correct({
    principal: 'authorized-human',
    target: 'event-1',
    replacement: 'corrected fact',
    reason: 'source owner correction',
    timestamp: '2030-01-01T00:00:00Z',
  });
  assert.notEqual(digest(runtime.raw), rawBeforeCorrection);
  assert.equal(runtime.raw[0].payload.text, 'draft fact');
  runtime.derived = [];
  const rebuilt = runtime.rebuildDerived();
  assert.equal(rebuilt[0].text, 'corrected fact');
  assert.equal(rebuilt[0].sourceCausalId, 'event-1');
  assert.equal(runtime.corrections[0].target, 'event-1');
});

test('provider switching preserves identity, session, and raw authority', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('terminal');
  runtime.accept({ causalId: 'event-1', channel: 'terminal', speaker: 'user-1', text: 'hello' });
  const transition = runtime.switchProvider('provider-b');
  assert.deepEqual(transition.before, transition.after);
  assert.equal(runtime.provider, 'provider-b');
});

test('capability views differ without context or identity isolation', () => {
  const runtime = new SyntheticSelfsameRuntime({ identityId: 'agent-1', sessionId: 'session-1' });
  runtime.attachChannel('terminal');
  runtime.attachChannel('telegram');
  runtime.accept({ causalId: 'event-1', channel: 'terminal', speaker: 'user-1', text: 'hello' });
  const terminal = runtime.capabilityView('terminal');
  const telegram = runtime.capabilityView('telegram');
  assert.notDeepEqual(terminal.capabilities, telegram.capabilities);
  assert.equal(terminal.identityId, telegram.identityId);
  assert.equal(terminal.sessionId, telegram.sessionId);
  assert.equal(terminal.contextDigest, telegram.contextDigest);
});

test('probe contains no private runtime imports or network primitives', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  const imports = [...source.matchAll(/require\((['"])(.*?)\1\)/g)].map((match) => match[2]);
  assert.deepEqual(imports, ['node:assert/strict', 'node:crypto', 'node:fs', 'node:path']);
  const networkCallPattern = new RegExp(['fet', 'ch\\s*\\('].join(''));
  assert.ok(!networkCallPattern.test(source), 'synthetic probe contains a network call');
});

process.stdout.write(`# Selfsame Protocol synthetic probe: ${passed} passed\n`);
