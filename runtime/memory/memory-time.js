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

// 下一个换日时刻（毫秒）。now 正好落在换日那一毫秒时给的是再下一个。
function nextDayBoundaryAt(now = Date.now(), timePolicy = {}) {
  const policy = resolveTimePolicy(timePolicy);
  return new Date(dayPeriod(operationalDayKey(now, policy), policy).endAt).getTime() + 1;
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

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

// 周归属月 = 周一所在月。每周恰好归一个月，跨月周不劈开——月卡由整周组成，
// 与周卡的来源边界完全一致，不产生"半周归两个月"的重复覆盖。
function monthKeyForWeek(weekKey) {
  const key = String(weekKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`Invalid weekKey: ${weekKey}`);
  return key.slice(0, 7);
}

function addMonths(monthKey, amount) {
  if (!MONTH_KEY_RE.test(String(monthKey || ''))) throw new Error(`Invalid monthKey: ${monthKey}`);
  const [year, month] = String(monthKey).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + Number(amount || 0), 1)).toISOString().slice(0, 7);
}

// 周一落在该月内的全部周键，即该月月卡的组成周
function weekKeysForMonth(monthKey) {
  if (!MONTH_KEY_RE.test(String(monthKey || ''))) throw new Error(`Invalid monthKey: ${monthKey}`);
  const firstWeek = weekKeyForDay(`${monthKey}-01`);
  let monday = firstWeek.slice(0, 7) === monthKey ? firstWeek : addDays(firstWeek, 7);
  const result = [];
  while (monday.slice(0, 7) === monthKey) {
    result.push(monday);
    monday = addDays(monday, 7);
  }
  return result;
}

// 自然月窗口（与 dayPeriod 同一 cutoff 语义）：本月 1 号 cutoff 起、下月 1 号 cutoff 前
function monthPeriod(monthKey, timePolicy = {}) {
  if (!MONTH_KEY_RE.test(String(monthKey || ''))) throw new Error(`Invalid monthKey: ${monthKey}`);
  const start = dayPeriod(`${monthKey}-01`, timePolicy);
  const nextStart = dayPeriod(`${addMonths(monthKey, 1)}-01`, timePolicy);
  return {
    key: monthKey,
    startAt: start.startAt,
    endAt: new Date(new Date(nextStart.startAt).getTime() - 1).toISOString(),
  };
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
    // 2026-10-14：场景静默够了、或者到了强制结算点，哪个先到就该回来。调用方要把它排进
    // 持久队列——原来只记一笔 pending，没人回来叫，13 日卡因此晚了三个半小时。
    const wakeAt = Math.min(asDate(lastSourceAt).getTime() + quietMs, forceAt);
    return { eligible: false, forced: false, carryover: false, reason: 'scene-recent', wakeAt };
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
  addMonths,
  asDate,
  dayPeriod,
  monthKeyForWeek,
  monthPeriod,
  nextDayBoundaryAt,
  operationalDayKey,
  resolveTimePolicy,
  shouldSettleDay,
  weekKeyForDay,
  weekKeysForMonth,
  weekPeriod,
  zonedPartsToIso,
  zonedWallClock,
};
