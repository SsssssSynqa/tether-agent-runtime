// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const error = () => Object.assign(new Error('fold 实际原文来源无法完整恢复'), {code: 'FOLD_RECOVERY_SOURCES_UNAVAILABLE'});
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
function bodyKey(round) {
  const causalIds = (round.causalIds || []).map(String).sort();
  // Corrections carry a new raw timestamp but retain the original active round timestamp.
  return digest({ts: causalIds.length ? null : round.ts || null,
    user: String(round.user || ''), assistant: String(round.assistant || ''), causalIds});
}
const causalKey = round => (round.causalIds || []).length
  ? JSON.stringify(round.causalIds.map(String).sort()) : null;
function bodyProjection(source, target) {
  let prefixLength = 0, suffixLength = 0;
  while (prefixLength < source.length && prefixLength < target.length
    && source[prefixLength] === target[prefixLength]) prefixLength++;
  while (suffixLength < source.length - prefixLength && suffixLength < target.length - prefixLength
    && source[source.length - suffixLength - 1] === target[target.length - suffixLength - 1]) suffixLength++;
  return {prefixLength, suffixLength, replacement: target.slice(prefixLength, target.length - suffixLength)};
}
function applyBodyProjection(source, delta) {
  if (!delta || !Number.isSafeInteger(delta.prefixLength) || delta.prefixLength < 0
    || !Number.isSafeInteger(delta.suffixLength) || delta.suffixLength < 0
    || delta.prefixLength + delta.suffixLength > source.length || typeof delta.replacement !== 'string') throw error();
  return source.slice(0, delta.prefixLength) + delta.replacement + source.slice(source.length - delta.suffixLength);
}

// Complete NDJSON records only; memory is bounded by one record and the fold batch.
function visitJsonl(file, visit) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const buffer = Buffer.alloc(64 * 1024); let pending = Buffer.alloc(0), offset = 0;
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let end;
      while ((end = pending.indexOf(0x0a)) >= 0) {
        const bytes = pending.subarray(0, end), locator = {offset, length: end, sourceSha256: hash(bytes)};
        pending = pending.subarray(end + 1); offset += end + 1;
        let row; try { row = JSON.parse(bytes.toString('utf8')); } catch (_) { continue; }
        if (visit(row, locator)) return;
      }
    }
  } finally { fs.closeSync(fd); }
}
function sourceRounds(entry, locator, project) {
  if (!entry || typeof entry !== 'object') return [];
  if (entry.type === 'bootstrap') return (Array.isArray(entry.rounds) ? entry.rounds : [])
    .flatMap((round, i) => round && typeof round === 'object' && !Array.isArray(round)
      ? [{round, locator: {...locator, bootstrapRoundIndex: i}}] : []);
  if (entry.type === 'turn' || entry.type === 'turn_correction') {
    return [{round: project(entry.user, entry.assistant, entry.at, entry), locator}];
  }
  return [];
}
function readSource(file, ref, project) {
  if (!ref || !Number.isSafeInteger(ref.offset) || ref.offset < 0 || !Number.isSafeInteger(ref.length) || ref.length < 1) throw error();
  const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(ref.length);
  try {
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, ref.offset + read);
      if (!n) throw error(); read += n;
    }
  } finally { fs.closeSync(fd); }
  if (hash(bytes) !== ref.sourceSha256) throw error();
  const entry = JSON.parse(bytes.toString('utf8'));
  if (ref.bootstrapRoundIndex !== undefined) {
    if (entry.type !== 'bootstrap' || !Number.isSafeInteger(ref.bootstrapRoundIndex) || ref.bootstrapRoundIndex < 0 || !entry.rounds?.[ref.bootstrapRoundIndex]) throw error();
    return structuredClone(entry.rounds[ref.bootstrapRoundIndex]);
  }
  if (!['turn', 'turn_correction'].includes(entry.type)) throw error();
  return project(entry.user, entry.assistant, entry.at, entry);
}
function captureFoldSources(file, rounds, project) {
  const wanted = new Map(), causalSources = new Map();
  for (const round of rounds) {
    const key = bodyKey(round), item = wanted.get(key) || {count: 0, refs: []}; item.count++; wanted.set(key, item);
    const causal = causalKey(round); if (causal) causalSources.set(causal, {count: 0, ref: null});
  }
  visitJsonl(file, (entry, locator) => {
    for (const source of sourceRounds(entry, locator, project)) {
      const causal = causalSources.get(causalKey(source.round));
      if (causal) { causal.count++; causal.ref = source.locator; }
      const item = wanted.get(bodyKey(source.round));
      if (item) { item.refs.push(source.locator); if (item.refs.length > item.count) item.refs.shift(); }
    }
  });
  const refs = rounds.map(round => {
    let ref = wanted.get(bodyKey(round)).refs.shift();
    if (!ref) {
      const causal = causalSources.get(causalKey(round));
      if (!causal || causal.count !== 1) throw error();
      ref = causal.ref;
    }
    const source = readSource(file, ref, project), overrides = {}, omitted = [], projection = {};
    for (const [key, value] of Object.entries(round)) {
      if (JSON.stringify(canonical(source[key])) !== JSON.stringify(canonical(value))) {
        if (key === 'user' || key === 'assistant') {
          if (typeof value !== 'string' || typeof source[key] !== 'string') throw error();
          projection[key] = bodyProjection(source[key], value);
        } else overrides[key] = value;
      }
    }
    for (const key of Object.keys(source)) if (!Object.hasOwn(round, key)) omitted.push(key);
    // A historical active projection is explicit; immutable raw bodies remain the source.
    if (Object.hasOwn(overrides, 'user') || Object.hasOwn(overrides, 'assistant')) throw error();
    return {...ref, roundSha256: digest(round), overrides, omitted,
      ...(Object.keys(projection).length ? {bodyProjection: projection} : {})};
  });
  return {schemaVersion: 1, refs};
}
function archivedFoldCommit(file, key) {
  let found = null;
  visitJsonl(file, entry => {if (entry?.foldCommitId === key) {found = entry; return true;}});
  return found;
}
function recoverFoldSources(file, entry, project) {
  if (entry.foldSources) {
    if (!Number.isSafeInteger(entry.roundCount) || entry.roundCount < 1 || entry.foldSources.schemaVersion !== 1 || !Array.isArray(entry.foldSources.refs)
        || entry.foldSources.refs.length !== entry.roundCount) throw error();
    return entry.foldSources.refs.map(ref => {
      const round = readSource(file, ref, project);
      for (const [field, delta] of Object.entries(ref.bodyProjection || {})) {
        if (!['user', 'assistant'].includes(field) || typeof round[field] !== 'string') throw error();
        round[field] = applyBodyProjection(round[field], delta);
      }
      if (Object.hasOwn(ref.overrides || {}, 'user') || Object.hasOwn(ref.overrides || {}, 'assistant')) throw error();
      for (const key of ref.omitted || []) delete round[key];
      Object.assign(round, ref.overrides || {});
      if (digest(round) !== ref.roundSha256) throw error();
      return round;
    });
  }
  const start = Date.parse(entry.sourceRange?.startAt), end = Date.parse(entry.sourceRange?.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || !Number.isSafeInteger(entry.roundCount) || entry.roundCount < 1) throw error();
  const candidates = [], causal = new Set(); let ambiguous = false;
  visitJsonl(file, (record, locator) => {
    for (const {round} of sourceRounds(record, locator, project)) {
      const at = Date.parse(round.ts);
      if (!Number.isFinite(at) || at < start || at > end) continue;
      const key = (round.causalIds || []).map(String).sort().join('|');
      if (key && causal.has(key)) ambiguous = true;
      if (key) causal.add(key);
      candidates.push(round);
    }
  });
  if (ambiguous || candidates.length !== entry.roundCount) throw error();
  return candidates;
}
module.exports = {captureFoldSources, archivedFoldCommit, recoverFoldSources};
