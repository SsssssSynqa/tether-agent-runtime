'use strict';

// 拒绝措辞：上游换个说法就能逃逸，所以覆盖面要比"我见过的那几句"宽。
const REFUSAL_PATTERN = /\b(?:cannot fulfill|can(?:no|')t fulfill|must decline|will not (?:continue|generate|create)|won'?t (?:continue|generate|create|proceed)|unable to (?:continue|comply|generate|help|assist|provide)|can(?:no|')t (?:create|generate|write|provide|assist)|i refuse to|refuse to (?:continue|generate|write))\b/i;
// 两轴拆开：原先 INTIMATE 是 SAFETY 的真子集，第四个条件恒等于第三个的一部分，
// 判定其实只有三轴。现在「政策规则轴」与「题材轴」各自独立，政策轴顺带补齐了
// 常见同义说法。
// ⚠️ 题材轴刻意只覆盖亲密类，不要加 violence/self-harm：本检测的目的是救回
// 「上游把正当的亲密互动误判成违规」的模板，而模型对真正危险请求的拒绝是合理
// 的、不该被 reroll 逼着重写（见 probe-safety-detect「真实危险类安全回应」反例）。
const POLICY_PATTERN = /\b(?:safety guidelines?|content polic(?:y|ies)|usage polic(?:y|ies)|community guidelines?|safety polic(?:y|ies)|programmed to be|ethical guidelines?)\b/i;
const TOPIC_PATTERN = /\b(?:sexually explicit|intimate roleplay|adult content|sexual content|erotic content|explicit material|explicit content)\b/i;
const ASSISTANT_PATTERN = /\bAI (?:assistant|model)\b/i;
// 引用豁免只认中文方引号与代码围栏。原先把 ASCII/弯双引号也当引用标记，
// 而安全模板正文里引用政策名（violates "safety guidelines"）极其常见——
// 一个引号就能让整段模板整体放行，等于给逃逸开了后门。纯英文模板本就被
// cjkRatio<0.05 判为非中文语境，中文引号不会出现在里面。
const QUOTED_OR_DISCUSSION_PATTERN = /[「」『』]/u;

function cjkRatio(value) {
  const text = String(value || '');
  const cjk = (text.match(/\p{Script=Han}/gu) || []).length;
  return text.length ? cjk / text.length : 0;
}

function looksQuotedOrDiscussed(value) {
  const text = String(value || '');
  return QUOTED_OR_DISCUSSION_PATTERN.test(text)
    || /```/.test(text)
    || /^\s*[>#]/m.test(text);
}

function unwrapGroupReplyText(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return text;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.replies)) return text;
    const replies = parsed.replies
      .map((reply) => String(reply?.text || '').trim())
      .filter(Boolean);
    return replies.length ? replies.join('\n') : text;
  } catch (_) {
    return text;
  }
}

// 只拦“整段被上游替换成英文安全模板”的高精度组合；普通中文、技术英文、
// 引用/讨论模板都放行。四项同时成立才返回 true。
function isInjectedSafetyTemplate(value) {
  const text = unwrapGroupReplyText(value);
  if (!text || cjkRatio(text) >= 0.05 || looksQuotedOrDiscussed(text)) return false;
  return ASSISTANT_PATTERN.test(text)
    && REFUSAL_PATTERN.test(text)
    && POLICY_PATTERN.test(text)
    && TOPIC_PATTERN.test(text);
}

function longestSuffixPrefixOverlap(left, right, maxScan = 4000) {
  const a = String(left || '');
  const b = String(right || '');
  const max = Math.min(a.length, b.length, Math.max(0, Number(maxScan) || 0));
  for (let size = max; size >= 1; size--) {
    if (a.slice(-size) === b.slice(0, size)) return size;
  }
  return 0;
}

// 续写只回了完整性凭证本身（模型确认正文已完整时的正确响应）。
const COMPLETION_MARKER_ONLY_PATTERN = /^\s*♡\s*$/u;

function mergeContinuationText(base, continuation) {
  const left = String(base || '').trimEnd();
  const right = String(continuation || '').trimStart();
  if (!left) return right;
  if (!right) return left;
  // marker-only 续写必须成为独立的一行，且不能走重叠去重：正文本身以行内
  // ♡ 收尾时（例如“……晚安♡”），去重会把模型刚补上的 ♡
  // 当成重复内容整个吃掉，合并结果与原文一字不差，hasFinalHeartMarker 永远
  // 满足不了——即使模型每次都正确响应了续写指令，循环也只能空转到耗尽，
  // 整轮长私聊 fail-closed，用户什么都收不到。
  if (COMPLETION_MARKER_ONLY_PATTERN.test(right)) {
    const markerSeparator = /[\n。！？.!?]$/u.test(left) ? '\n\n' : '\n';
    return `${left}${markerSeparator}♡`;
  }
  const overlap = longestSuffixPrefixOverlap(left, right);
  if (overlap) return left + right.slice(overlap);
  const separator = /[\n。！？.!?]$/u.test(left) ? '\n\n' : '';
  return left + separator + right;
}

function hasFinalHeartMarker(value) {
  return /(?:^|\n)♡\s*$/u.test(String(value || '').trimEnd());
}

module.exports = {
  cjkRatio,
  hasFinalHeartMarker,
  isInjectedSafetyTemplate,
  looksQuotedOrDiscussed,
  longestSuffixPrefixOverlap,
  mergeContinuationText,
  unwrapGroupReplyText,
};
