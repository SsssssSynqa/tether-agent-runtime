// SPDX-License-Identifier: Apache-2.0
'use strict';

const DEFAULT_MEMORY_POLICY = Object.freeze({
  agent: Object.freeze({
    entityId: 'agent',
    displayName: 'Agent',
  }),
  owner: Object.freeze({
    entityId: 'owner',
    displayName: 'Owner',
    disallowedDisplayNames: Object.freeze([]),
    namingSubjects: Object.freeze(['they', 'the owner', 'user', 'User', 'Owner']),
  }),
  sourceLabels: Object.freeze({
    input: 'Input',
    assistant: 'Agent',
  }),
  time: Object.freeze({
    timezoneOffsetMinutes: 0,
    cutoffHour: 6,
    forceHour: 12,
    quietMinutes: 45,
    displayLabel: 'configured local time',
  }),
  files: Object.freeze({
    dayDirectory: 'day-cards',
    weekDirectory: 'week-cards',
    foldDirectory: 'folds',
    dayHeadingTemplate: '# {agent} day card · {period}',
    weekHeadingTemplate: '# {agent} week card · {period} to {end}',
    lockName: '.tether-memory-sync.lock',
  }),
  records: Object.freeze({
    fileRevisionType: 'tether-memory-file-revision',
    humanOverrideType: 'tether-memory-card-override',
    semanticStoreType: 'tether-semantic-memory',
    humanResolutionLabel: 'owner_human_resolution',
  }),
  actors: Object.freeze({
    automatic: 'tether:auto',
    materialize: 'tether:materialize',
    humanOverride: 'owner:memory-console',
  }),
});

function nonEmptyString(value, fallback) {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function boundedNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function normalizeMemoryPolicy(value = {}) {
  const policy = value && typeof value === 'object' ? value : {};
  const agent = policy.agent && typeof policy.agent === 'object' ? policy.agent : {};
  const owner = policy.owner && typeof policy.owner === 'object' ? policy.owner : {};
  const sourceLabels = policy.sourceLabels && typeof policy.sourceLabels === 'object'
    ? policy.sourceLabels
    : {};
  const time = policy.time && typeof policy.time === 'object' ? policy.time : {};
  const files = policy.files && typeof policy.files === 'object' ? policy.files : {};
  const records = policy.records && typeof policy.records === 'object' ? policy.records : {};
  const actors = policy.actors && typeof policy.actors === 'object' ? policy.actors : {};

  const normalizedAgent = {
    entityId: nonEmptyString(agent.entityId, DEFAULT_MEMORY_POLICY.agent.entityId),
    displayName: nonEmptyString(agent.displayName, DEFAULT_MEMORY_POLICY.agent.displayName),
  };
  const normalizedOwner = {
    entityId: nonEmptyString(owner.entityId, DEFAULT_MEMORY_POLICY.owner.entityId),
    displayName: nonEmptyString(owner.displayName, DEFAULT_MEMORY_POLICY.owner.displayName),
    disallowedDisplayNames: uniqueStrings(owner.disallowedDisplayNames)
      .filter((name) => name !== nonEmptyString(
        owner.displayName,
        DEFAULT_MEMORY_POLICY.owner.displayName,
      )),
    namingSubjects: uniqueStrings(owner.namingSubjects).length
      ? uniqueStrings(owner.namingSubjects)
      : [...DEFAULT_MEMORY_POLICY.owner.namingSubjects],
  };
  const normalizedTime = {
    timezoneOffsetMinutes: boundedNumber(
      time.timezoneOffsetMinutes,
      DEFAULT_MEMORY_POLICY.time.timezoneOffsetMinutes,
      -14 * 60,
      14 * 60,
    ),
    cutoffHour: boundedNumber(time.cutoffHour, DEFAULT_MEMORY_POLICY.time.cutoffHour, 0, 23),
    forceHour: boundedNumber(time.forceHour, DEFAULT_MEMORY_POLICY.time.forceHour, 0, 47),
    quietMinutes: boundedNumber(
      time.quietMinutes,
      DEFAULT_MEMORY_POLICY.time.quietMinutes,
      0,
      24 * 60,
    ),
    displayLabel: nonEmptyString(time.displayLabel, DEFAULT_MEMORY_POLICY.time.displayLabel),
  };
  if (normalizedTime.forceHour < normalizedTime.cutoffHour) {
    throw new Error('memory policy time.forceHour must be greater than or equal to cutoffHour');
  }

  return {
    schemaVersion: 1,
    agent: normalizedAgent,
    owner: normalizedOwner,
    sourceLabels: {
      input: nonEmptyString(sourceLabels.input, DEFAULT_MEMORY_POLICY.sourceLabels.input),
      assistant: nonEmptyString(
        sourceLabels.assistant,
        normalizedAgent.displayName,
      ),
    },
    time: normalizedTime,
    files: {
      dayDirectory: nonEmptyString(files.dayDirectory, DEFAULT_MEMORY_POLICY.files.dayDirectory),
      weekDirectory: nonEmptyString(files.weekDirectory, DEFAULT_MEMORY_POLICY.files.weekDirectory),
      foldDirectory: nonEmptyString(files.foldDirectory, DEFAULT_MEMORY_POLICY.files.foldDirectory),
      dayHeadingTemplate: nonEmptyString(
        files.dayHeadingTemplate,
        DEFAULT_MEMORY_POLICY.files.dayHeadingTemplate,
      ),
      weekHeadingTemplate: nonEmptyString(
        files.weekHeadingTemplate,
        DEFAULT_MEMORY_POLICY.files.weekHeadingTemplate,
      ),
      lockName: nonEmptyString(files.lockName, DEFAULT_MEMORY_POLICY.files.lockName),
    },
    records: {
      fileRevisionType: nonEmptyString(
        records.fileRevisionType,
        DEFAULT_MEMORY_POLICY.records.fileRevisionType,
      ),
      humanOverrideType: nonEmptyString(
        records.humanOverrideType,
        DEFAULT_MEMORY_POLICY.records.humanOverrideType,
      ),
      semanticStoreType: nonEmptyString(
        records.semanticStoreType,
        DEFAULT_MEMORY_POLICY.records.semanticStoreType,
      ),
      humanResolutionLabel: nonEmptyString(
        records.humanResolutionLabel,
        DEFAULT_MEMORY_POLICY.records.humanResolutionLabel,
      ),
    },
    actors: {
      automatic: nonEmptyString(actors.automatic, DEFAULT_MEMORY_POLICY.actors.automatic),
      materialize: nonEmptyString(actors.materialize, DEFAULT_MEMORY_POLICY.actors.materialize),
      humanOverride: nonEmptyString(
        actors.humanOverride,
        DEFAULT_MEMORY_POLICY.actors.humanOverride,
      ),
    },
  };
}

module.exports = {
  DEFAULT_MEMORY_POLICY,
  normalizeMemoryPolicy,
  uniqueStrings,
};
