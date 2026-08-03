// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeMemoryPolicy } = require('./memory-policy.js');
const {
  operationalDayKey,
  zonedPartsToIso,
  zonedWallClock,
} = require('./memory-time.js');

function sourceId(...parts) {
  const canonical = parts.map((part) => String(part || '')).join('\n');
  return `memory-source:${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceOptions(value = {}) {
  const memoryPolicy = normalizeMemoryPolicy(value.memoryPolicy || value.policy || {});
  return {
    memoryPolicy,
    sanitizeSummary: typeof value.sanitizeSummary === 'function'
      ? value.sanitizeSummary
      : (text) => String(text || '').trim(),
    renderOwnerForContext: typeof value.renderOwnerForContext === 'function'
      ? value.renderOwnerForContext
      : (text) => String(text || ''),
  };
}

function parseRangeFromSummary(text, fallbackAt = null, options = {}) {
  const { memoryPolicy } = sourceOptions(options);
  const match = String(text || '').match(
    /【(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+[–-]\s+(?:(\d{2})-(\d{2})\s+)?(\d{2}):(\d{2})/,
  );
  const fallback = fallbackAt ? new Date(fallbackAt) : new Date();
  if (!match || Number.isNaN(fallback.getTime())) {
    const at = fallback.toISOString();
    return { startAt: at, endAt: at };
  }
  const localFallback = zonedWallClock(fallback, memoryPolicy.time);
  const year = localFallback.getUTCFullYear();
  const startMonth = Number(match[1]);
  const startYear = startMonth > localFallback.getUTCMonth() + 1 + 6 ? year - 1 : year;
  const startAt = zonedPartsToIso(
    startYear,
    startMonth,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    0,
    memoryPolicy.time,
  );
  const endMonth = Number(match[5] || match[1]);
  const endDay = Number(match[6] || match[2]);
  let endAt = zonedPartsToIso(
    startYear,
    endMonth,
    endDay,
    Number(match[7]),
    Number(match[8]),
    0,
    memoryPolicy.time,
  );
  if (new Date(endAt) < new Date(startAt)) {
    endAt = new Date(new Date(endAt).setUTCFullYear(startYear + 1)).toISOString();
  }
  return { startAt, endAt };
}

function normalizeProvenance(value = {}) {
  const list = (item) => [...new Set((Array.isArray(item) ? item : []).map(String).filter(Boolean))].sort();
  return {
    trustZones: list(value.trustZones),
    chatIds: list(value.chatIds),
    senderIds: list(value.senderIds),
  };
}

function summarySource(entry, fallbackAt = null, options = {}) {
  const resolved = sourceOptions(options);
  const text = resolved.sanitizeSummary(entry?.text || '');
  if (!text) return null;
  const at = entry?.at || fallbackAt || new Date().toISOString();
  const range = entry?.sourceRange?.startAt && entry?.sourceRange?.endAt
    ? entry.sourceRange
    : parseRangeFromSummary(text, at, resolved);
  return {
    // Time range participates in identity: identical text at different times
    // remains distinct, while one fold mirrored in two stores still dedupes.
    id: entry?.id || sourceId(range.startAt, range.endAt, text),
    kind: 'summary',
    text,
    startAt: range.startAt,
    endAt: range.endAt,
    dayKey: operationalDayKey(range.endAt, resolved.memoryPolicy.time),
    provenance: normalizeProvenance(entry?.provenance),
    origin: entry?.origin || 'history-summary',
  };
}

function roundSourceId(round, index = 0) {
  const at = round?.ts || new Date().toISOString();
  const causalKey = Array.isArray(round?.causalIds) && round.causalIds.length
    ? round.causalIds.map(String).sort().join(',')
    : `${at}:${index}`;
  return `memory-turn:${createHash('sha256').update(causalKey).digest('hex').slice(0, 24)}`;
}

function roundSource(round, index = 0, options = {}) {
  const resolved = sourceOptions(options);
  const at = round?.ts || new Date().toISOString();
  const owner = resolved.renderOwnerForContext(round?.user || '');
  const assistant = String(round?.assistant || '');
  const text = [
    `【raw tail turn · ${at}】`,
    `${resolved.memoryPolicy.sourceLabels.input}：${owner}`,
    `${resolved.memoryPolicy.sourceLabels.assistant}：${assistant}`,
  ].join('\n');
  return {
    id: roundSourceId(round, index),
    kind: 'round',
    text,
    startAt: at,
    endAt: at,
    dayKey: operationalDayKey(at, resolved.memoryPolicy.time),
    provenance: normalizeProvenance(round?.provenance),
    origin: 'active-round',
  };
}

function parseFoldLogFile(filePath, options = {}) {
  const resolved = sourceOptions(options);
  const filename = path.basename(filePath);
  const dateKey = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
  if (!dateKey) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const label = escapeRegExp(resolved.memoryPolicy.time.displayLabel);
  const header = new RegExp(
    `^##\\s+(\\d{2}):(\\d{2}):(\\d{2})（${label}）·\\s*折叠\\s+\\d+\\s*轮\\s*$`,
    'gm',
  );
  const matches = [...raw.matchAll(header)];
  return matches.map((match, index) => {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? raw.length;
    const body = raw.slice(bodyStart, bodyEnd).replace(/\n---\s*$/s, '').trim();
    const fallbackAt = zonedPartsToIso(
      Number(dateKey.slice(0, 4)),
      Number(dateKey.slice(5, 7)),
      Number(dateKey.slice(8, 10)),
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      resolved.memoryPolicy.time,
    );
    return summarySource(
      { text: body, at: fallbackAt, origin: `fold-log:${filename}` },
      fallbackAt,
      resolved,
    );
  }).filter(Boolean);
}

function parseFoldLogDirectory(directory, options = {}) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .flatMap((name) => parseFoldLogFile(path.join(directory, name), options));
}

function collectMemorySources({
  foldLogDir = null,
  summaryHistory = [],
  rounds = [],
  memoryPolicy = {},
  sanitizeSummary = undefined,
  renderOwnerForContext = undefined,
} = {}) {
  const options = sourceOptions({ memoryPolicy, sanitizeSummary, renderOwnerForContext });
  const byId = new Map();
  for (const source of parseFoldLogDirectory(foldLogDir, options)) byId.set(source.id, source);
  for (const entry of summaryHistory || []) {
    const source = summarySource(entry, null, options);
    if (source) byId.set(source.id, source);
  }
  for (const [index, round] of (rounds || []).entries()) {
    const source = roundSource(round, index, options);
    byId.set(source.id, source);
  }
  return [...byId.values()].sort(
    (left, right) => new Date(left.startAt) - new Date(right.startAt) || left.id.localeCompare(right.id),
  );
}

module.exports = {
  collectMemorySources,
  normalizeProvenance,
  parseFoldLogDirectory,
  parseFoldLogFile,
  parseRangeFromSummary,
  roundSource,
  roundSourceId,
  sourceId,
  sourceOptions,
  summarySource,
};
