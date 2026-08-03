// SPDX-License-Identifier: Apache-2.0
'use strict';

const { normalizeMemoryPolicy } = require('./memory-policy.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid time value: ${value}`);
  return date;
}

function resolveTimePolicy(value = {}) {
  if (value?.time && typeof value.time === 'object') {
    return normalizeMemoryPolicy(value).time;
  }
  return normalizeMemoryPolicy({ time: value }).time;
}

function zonedWallClock(value, timePolicy = {}) {
  const policy = resolveTimePolicy(timePolicy);
  return new Date(asDate(value).getTime() + policy.timezoneOffsetMinutes * 60 * 1000);
}

function zonedPartsToIso(year, month, day, hour, minute, second = 0, timePolicy = {}) {
  const policy = resolveTimePolicy(timePolicy);
  const utc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute - policy.timezoneOffsetMinutes,
    second,
  );
  return new Date(utc).toISOString();
}

function operationalDayKey(value, timePolicy = {}) {
  const policy = resolveTimePolicy(timePolicy);
  const shifted = new Date(
    zonedWallClock(value, policy).getTime() - policy.cutoffHour * 60 * 60 * 1000,
  );
  return shifted.toISOString().slice(0, 10);
}

function dayPeriod(dayKey, timePolicy = {}) {
  const policy = resolveTimePolicy(timePolicy);
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid dayKey: ${dayKey}`);
  const startAt = new Date(
    start.getTime()
      - policy.timezoneOffsetMinutes * 60 * 1000
      + policy.cutoffHour * 60 * 60 * 1000,
  );
  return {
    key: dayKey,
    startAt: startAt.toISOString(),
    endAt: new Date(startAt.getTime() + DAY_MS - 1).toISOString(),
  };
}

function weekKeyForDay(dayKey) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid dayKey: ${dayKey}`);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function weekPeriod(weekKey, timePolicy = {}) {
  const start = dayPeriod(weekKey, timePolicy);
  return {
    key: weekKey,
    startAt: start.startAt,
    endAt: new Date(new Date(start.startAt).getTime() + 7 * DAY_MS - 1).toISOString(),
  };
}

function addDays(dayKey, amount) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid dayKey: ${dayKey}`);
  date.setUTCDate(date.getUTCDate() + Number(amount || 0));
  return date.toISOString().slice(0, 10);
}

function shouldSettleDay(dayKey, {
  now = Date.now(),
  lastSourceAt = null,
  // Whether the conversation as a whole is still active at settlement time.
  // This is intentionally separate from the target day's own latest source.
  globalLastSourceAt = null,
  timePolicy = {},
  timezoneOffsetMinutes = undefined,
  cutoffHour = undefined,
  forceHour = undefined,
  quietMinutes = undefined,
} = {}) {
  const policy = resolveTimePolicy({
    ...(timePolicy?.time || timePolicy),
    ...(timezoneOffsetMinutes == null ? {} : { timezoneOffsetMinutes }),
    ...(cutoffHour == null ? {} : { cutoffHour }),
    ...(forceHour == null ? {} : { forceHour }),
    ...(quietMinutes == null ? {} : { quietMinutes }),
  });
  const period = dayPeriod(dayKey, policy);
  const normalAt = new Date(period.endAt).getTime() + 1;
  const forceAt = normalAt + (policy.forceHour - policy.cutoffHour) * 60 * 60 * 1000;
  const nowMs = asDate(now).getTime();
  if (nowMs < normalAt) {
    return { eligible: false, forced: false, carryover: false, reason: 'before-boundary' };
  }
  const quietMs = policy.quietMinutes * 60 * 1000;
  let sceneRecent = false;
  if (lastSourceAt) sceneRecent = nowMs - asDate(lastSourceAt).getTime() < quietMs;
  let conversationOngoing = sceneRecent;
  if (globalLastSourceAt) {
    conversationOngoing = nowMs - asDate(globalLastSourceAt).getTime() < quietMs;
  }
  if (nowMs >= forceAt) {
    return {
      eligible: true,
      forced: true,
      carryover: conversationOngoing,
      reason: `${String(policy.forceHour).padStart(2, '0')}:00-force`,
    };
  }
  if (sceneRecent) {
    return { eligible: false, forced: false, carryover: false, reason: 'scene-recent' };
  }
  return {
    eligible: true,
    forced: false,
    carryover: false,
    reason: `${String(policy.cutoffHour).padStart(2, '0')}:00-settle`,
  };
}

module.exports = {
  DAY_MS,
  addDays,
  asDate,
  dayPeriod,
  operationalDayKey,
  resolveTimePolicy,
  shouldSettleDay,
  weekKeyForDay,
  weekPeriod,
  zonedPartsToIso,
  zonedWallClock,
};
