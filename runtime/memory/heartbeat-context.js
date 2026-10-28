// SPDX-License-Identifier: Apache-2.0
'use strict';

// The capability cannot arrive through daemon JSON. Enumerable Symbol keys
// survive internal {...context} copies, but never cross JSON or enter history.
const CAPABILITY = Symbol('engine-owned-heartbeat');
const runtimes = new WeakSet();
function bindHeartbeatContext(context, runtime) {
  if (!runtime || typeof runtime !== 'object' || typeof runtime.runId !== 'string' || !runtime.runId
      || typeof runtime.boundary !== 'function' || !runtime.readSignal) throw new Error('Invalid heartbeat runtime capability');
  runtimes.add(runtime);
  return Object.freeze({ ...context, [CAPABILITY]: runtime });
}
function heartbeatRuntime(context) {
  const runtime = context?.[CAPABILITY];
  return runtime && runtimes.has(runtime) ? runtime : null;
}
function carryHeartbeatContext(from, to) {
  const runtime = heartbeatRuntime(from);
  if (runtime) to[CAPABILITY] = runtime;
  return to;
}
function heartbeatBoundary(context) {
  const runtime = heartbeatRuntime(context);
  const reason = runtime?.boundary();
  if (reason) {
    const error = new Error(`heartbeat stopped: ${reason}`);
    error.code = 'HEARTBEAT_YIELD'; error.stopReason = reason;
    throw error;
  }
  return runtime;
}

// This view is only for heartbeat-tagged rounds. Ordinary user/tool records are
// not migrated, rewritten, or filtered by this feature.
function heartbeatProjection(round) {
  const hb = round?.heartbeat;
  if (!hb || hb.version !== 1 || hb.initiator !== 'engine' || typeof hb.runId !== 'string') return null;
  const lines = [];
  if (hb.publicText) lines.push(hb.publicText);
  for (const draft of hb.publicationTexts || []) lines.push(`写给 ${draft.chatRef} 的稿子：${draft.text}`);
  if (hb.experience?.text) lines.push(`经历：${hb.experience.text}`);
  for (const change of hb.stateDelta || []) lines.push(`驱动 ${change.drive} ${change.delta}：${change.reason}`);
  for (const thought of hb.thoughtTouches || []) lines.push(`念头：${thought.text}`);
  for (const summary of hb.deliverySummaries || []) lines.push(summary);
  return { initiator: 'engine', runId: hb.runId, text: lines.join('\n') || '自主回合记录（本轮没有可读发言）。' };
}

function roundContextMessages(round, renderUser, renderAssistant) {
  const heartbeat = heartbeatProjection(round);
  return heartbeat ? [{ role: 'assistant', content: heartbeat.text }]
    : [{ role: 'user', content: renderUser(round.user) }, { role: 'assistant', content: renderAssistant(round.assistant) + publicationProjection(round) }];
}

function publicationProjection(round) {
  const drafts = (round?.publication?.intents || []).filter(e => !e.current)
    .map(e => `\n写给 ${e.chatRef} 的稿子：${e.text}`).join('');
  const actions = round?.publication?.version === 1 ? round.publication.heartbeatExperience : null;
  if (!actions) return drafts;
  const lines = [];
  if (actions.experience?.text) {
    lines.push(`Agent experience：${actions.experience.text}`);
    const metrics = Object.entries(actions.experience.metrics || {}).map(([key, value]) => `${key}=${value}`);
    if (metrics.length) lines.push(`经历指标：${metrics.join('，')}`);
  }
  for (const change of actions.stateDelta || []) {
    lines.push(`Drive ${change.drive} ${change.delta}; evidence: ${change.fact}; interpretation: ${change.reason}`);
  }
  for (const thought of actions.thoughtTouches || []) lines.push(`Agent thought：${thought.text}`);
  return drafts + (lines.length ? `\n${lines.join('\n')}` : '');
}

module.exports = { bindHeartbeatContext, heartbeatRuntime, carryHeartbeatContext, heartbeatBoundary, heartbeatProjection, roundContextMessages, publicationProjection };
