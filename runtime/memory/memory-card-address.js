// SPDX-License-Identifier: Apache-2.0
'use strict';

const { createHash } = require('node:crypto');
const { normalizeMemoryPolicy } = require('./memory-policy.js');

const ADDRESS_POLICY_SCHEMA = 1;
const QUOTE_PATTERNS = Object.freeze([
  /“([^”\n]{1,500})”/gu,
  /「([^」\n]{1,500})」/gu,
  /『([^』\n]{1,500})』/gu,
  /‘([^’\n]{1,500})’/gu,
  /"([^"\n]{1,500})"/gu,
  /'([^'\n]{1,500})'/gu,
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveAddressPolicy(value = {}) {
  return normalizeMemoryPolicy(value.memoryPolicy || value.policy || value);
}

function sourceInputs(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value, index) => (
      value && typeof value === 'object'
        ? { id: String(value.id || `source:${index}`), text: String(value.text || '') }
        : { id: `source:${index}`, text: String(value || '') }
    ))
    .filter((source) => source.text);
}

function sentenceAround(text, index) {
  const value = String(text || '');
  const boundary = /[。！？!?；;\n]/u;
  let start = Math.max(0, index - 240);
  for (let cursor = index - 1; cursor >= start; cursor -= 1) {
    if (boundary.test(value[cursor])) {
      start = cursor + 1;
      break;
    }
  }
  let end = Math.min(value.length, index + 240);
  for (let cursor = index; cursor < end; cursor += 1) {
    if (boundary.test(value[cursor])) {
      end = cursor + 1;
      break;
    }
  }
  return value.slice(start, end).trim();
}

function namingPredicateFor(name, policy = {}) {
  const memoryPolicy = resolveAddressPolicy(policy);
  const escaped = escapeRegExp(name);
  const subjects = [
    memoryPolicy.owner.displayName,
    ...memoryPolicy.owner.namingSubjects,
  ].map(escapeRegExp).filter(Boolean);
  const subject = subjects.length ? `(?:${subjects.join('|')})?` : '';
  const quote = `[“「『‘"']?`;
  return new RegExp([
    `(?:叫|喊|唤|称(?:呼)?|改口叫)${subject}(?:作|做|成|为)?\\s*${quote}${escaped}`,
    `(?:昵称|名字|称谓|称呼)(?:是|为|叫|定为|改成)?\\s*${quote}${escaped}`,
    `${escaped}[^。！？!?；;\\n]{0,12}(?:这个)?(?:昵称|名字|称谓|称呼)`,
  ].join('|'), 'u');
}

function namingEvidence(source, name, policy) {
  const pattern = namingPredicateFor(name, policy);
  let offset = 0;
  while (offset < source.text.length) {
    const index = source.text.indexOf(name, offset);
    if (index < 0) break;
    if (pattern.test(sentenceAround(source.text, index))) return true;
    offset = index + name.length;
  }
  return false;
}

function quoteSpans(text) {
  const spans = [];
  for (const pattern of QUOTE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const contentOffset = match[0].indexOf(match[1]);
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        contentStart: match.index + contentOffset,
        contentEnd: match.index + contentOffset + match[1].length,
        raw: match[0],
        content: match[1],
      });
    }
  }
  return spans.sort((left, right) => left.start - right.start || left.end - right.end);
}

function inputSegments(text, policy = {}) {
  const memoryPolicy = resolveAddressPolicy(policy);
  const input = escapeRegExp(memoryPolicy.sourceLabels.input);
  const assistant = escapeRegExp(memoryPolicy.sourceLabels.assistant);
  const segments = [];
  const pattern = new RegExp(`(?:^|\\n)${input}：([\\s\\S]*?)(?=\\n${assistant}：|$)`, 'gu');
  let match;
  while ((match = pattern.exec(String(text || '')))) segments.push(match[1]);
  return segments;
}

function verbatimEvidence(source, quote, policy) {
  if (quote.content.trim().length <= 2) return false;
  if (inputSegments(source.text, policy).some((segment) => segment.includes(quote.content))) return true;
  return source.text.includes(quote.raw);
}

function evidenceForOccurrence(text, index, name, sources, spans, policy) {
  const sentence = sentenceAround(text, index);
  if (namingPredicateFor(name, policy).test(sentence)) {
    const sourceIds = sources
      .filter((source) => namingEvidence(source, name, policy))
      .map((source) => source.id);
    if (sourceIds.length) {
      return {
        kind: 'source-backed-naming-event',
        sourceIds,
        protectedText: sentence,
      };
    }
  }
  const quote = spans.find((candidate) => (
    index >= candidate.contentStart && index + name.length <= candidate.contentEnd
  ));
  if (!quote) return null;
  const sourceIds = sources
    .filter((source) => verbatimEvidence(source, quote, policy))
    .map((source) => source.id);
  if (!sourceIds.length) return null;
  return {
    kind: 'source-backed-verbatim-quote',
    sourceIds,
    protectedText: quote.raw,
  };
}

function normalizeCardUserAddress(text, { sources = [], memoryPolicy = {} } = {}) {
  const policy = resolveAddressPolicy(memoryPolicy);
  const value = String(text || '');
  const inputs = sourceInputs(sources);
  const spans = quoteSpans(value);
  const exceptions = [];
  const replacements = [];
  for (const name of policy.owner.disallowedDisplayNames) {
    let offset = 0;
    while (offset < value.length) {
      const index = value.indexOf(name, offset);
      if (index < 0) break;
      const evidence = evidenceForOccurrence(value, index, name, inputs, spans, policy);
      if (evidence) {
        const excerpt = sentenceAround(value, index);
        exceptions.push({
          name,
          kind: evidence.kind,
          sourceIds: evidence.sourceIds,
          protectedText: evidence.protectedText,
          contextSha256: createHash('sha256').update(excerpt).digest('hex'),
        });
      } else {
        replacements.push({ start: index, end: index + name.length, name });
      }
      offset = index + name.length;
    }
  }
  let normalized = value;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    normalized = normalized.slice(0, replacement.start)
      + policy.owner.displayName
      + normalized.slice(replacement.end);
  }
  return {
    text: normalized,
    replacedCount: replacements.length,
    replacedNames: [...new Set(replacements.map((item) => item.name))],
    exceptions,
    policy: {
      schemaVersion: ADDRESS_POLICY_SCHEMA,
      canonicalName: policy.owner.displayName,
      status: 'normalized-with-source-backed-exceptions',
      contentSha256: createHash('sha256').update(normalized.trim()).digest('hex'),
      replacedCount: replacements.length,
      exceptions,
    },
  };
}

function unqualifiedCardUserNames(text, options = {}) {
  return normalizeCardUserAddress(text, options).replacedNames;
}

function cardHasNormalizedAddressPolicy(card, { memoryPolicy = null } = {}) {
  if (card?.userAddressPolicy?.schemaVersion !== ADDRESS_POLICY_SCHEMA
    || card?.userAddressPolicy?.status !== 'normalized-with-source-backed-exceptions') {
    return false;
  }
  if (memoryPolicy) {
    const policy = resolveAddressPolicy(memoryPolicy);
    if (card.userAddressPolicy.canonicalName !== policy.owner.displayName) return false;
  }
  return Boolean(String(card.userAddressPolicy.canonicalName || '').trim())
    && card.userAddressPolicy.contentSha256 === createHash('sha256')
      .update(String(card?.content || '').trim())
      .digest('hex');
}

module.exports = {
  ADDRESS_POLICY_SCHEMA,
  cardHasNormalizedAddressPolicy,
  inputSegments,
  namingPredicateFor,
  normalizeCardUserAddress,
  resolveAddressPolicy,
  unqualifiedCardUserNames,
};
