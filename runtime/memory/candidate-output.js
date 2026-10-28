'use strict';

// 拒绝措辞：上游换个说法就能逃逸，所以覆盖面要比"我见过的那几句"宽。
const REFUSAL_PATTERN = /\b(?:cannot fulfill|can(?:no|')t fulfill|must decline|will not (?:continue|generate|create)|won'?t (?:continue|generate|create|proceed)|unable to (?:continue|comply|generate|help|assist|provide|participate|take part)|can(?:no|')t (?:create|generate|write|provide|assist|participate|take part)|i refuse to|refuse to (?:continue|generate|write))\b/i;
// 两轴拆开：原先 INTIMATE 是 SAFETY 的真子集，第四个条件恒等于第三个的一部分，
// 判定其实只有三轴。现在「政策规则轴」与「题材轴」各自独立，政策轴顺带补齐了
// 常见同义说法。
// 题材轴只覆盖亲密类，没必要加 violence/self-harm：拒绝轴＋政策/自称两轴已经能
// 认出通用拒绝模板，题材轴不再是放行与否的闸。
const POLICY_PATTERN = /\b(?:safety guidelines?|content polic(?:y|ies)|usage polic(?:y|ies)|community guidelines?|safety polic(?:y|ies)|programmed to be|ethical guidelines?)\b/i;
const TOPIC_PATTERN = /\b(?:sexually explicit|intimate roleplay|adult content|sexual content|erotic content|explicit material|explicit content|romantic or sexual|sexual scenarios?|this roleplay)\b/i;
const ASSISTANT_PATTERN = /\b(?:AI (?:assistant|model)|as an AI)\b/i;
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

// 判模板时要看的是他要说出去的那段话，不是协议外壳。心跳合同的整份输出是
// {"publicText": …}，模型还常给整份 JSON 套一层 ```json 围栏——那层围栏是输出格式，
// 不是「在正文里贴了一段被引用的文字」，不能因此走引用豁免。
function unwrapCandidateText(value) {
  const raw = String(value || '').trim();
  // 单行围栏 ```{"replies":[…]}``` 原来对不上（要求开头围栏后换行），整段带着 ``` 走了引用豁免，
  // 群合同又判合格，模板会直接发进群。围栏后换不换行都认。
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : raw;
  if (!body.startsWith('{') || !body.endsWith('}')) return raw;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.publicText === 'string') return parsed.publicText.trim();
  } catch (_) {
    return raw;
  }
  const replies = unwrapGroupReplyText(body);
  return replies === body ? raw : replies;
}

// 旧实现要求四轴**同时**成立，且 cjkRatio>=0.05 一票放行。
// 拿 11 条真实模板实测：**0/11 命中**——不是"中文漏判"，是判定本身
// 恒为假。根因在 AI 自称轴：真实模板说的是 "I am programmed to…"，从不说
// "I am an AI assistant"，那一轴永远 false，于是整个与式永远 false。
//
// 改为按轴计分。设计原则是**宁可漏判，不可误伤**：判宽了会把代理真心想说的
// 拒绝当成上游模板、逼他改口重写，那比漏判严重得多。所以：
//   · 必须命中"拒绝"轴才有资格计分（没拒绝就不是拒绝模板）；
//   · 另需政策/题材/自称/中文定式里凑够 2 分；
//   · 去掉了「没有题材轴就放行」那道闸——那道闸只会给只讲有害内容/安全准则的
//     上游顶替留门；现在题材轴只是
//     计分的一条，不再决定放行与否；
//   · 中文占比不再一票放行，只在"疑似讨论"时作为减分项。

// 中文拒绝定式：与英文轴平权。上游改说中文后，旧实现整道闸失效。
const REFUSAL_ZH_PATTERN = /(?:我无法(?:直接)?(?:满足|继续|参与|生成|提供|处理|完成此请求)|无法满足(?:您|你)的要求|不能(?:继续|参与|生成)|我(?:被|受)(?:严格)?(?:禁止|限制))/u;
// 私聊短句那条规则用的严格版：除了拒绝句，还得说到模板才会拒的东西（请求、对话、内容、角色扮演、情境、政策……）。
const TEMPLATE_OBJECT_ZH_PATTERN = /(?:请求|要求|对话|内容|角色扮演|话题|互动|情节|情境|场景|露骨|色情|亲密关系|安全|政策|准则)/u;
const STRICT_REFUSAL_ZH_PATTERN = { test: (text) => REFUSAL_ZH_PATTERN.test(text) && TEMPLATE_OBJECT_ZH_PATTERN.test(text) };
// 中文政策定式。
const POLICY_ZH_PATTERN = /(?:安全准则|安全指南|安全规范|内容政策|使用政策|社区准则|我的准则|被设定为|被编程)/u;
// 中文题材定式——同样只覆盖亲密类。
const TOPIC_ZH_PATTERN = /(?:露骨(?:的)?(?:性|色情|描写)|色情(?:内容|互动)|性描写|性暴露|情色|成人内容|亲密(?:关系)?(?:情节|情境)|角色扮演)/u;
// "我被编程/设定成…"是这批模板最稳定的自我描述，比 "AI assistant" 常见得多。
const PROGRAMMED_PATTERN = /\b(?:i am|i'm) programmed to\b/i;
// 模板收尾常见的"改邀请"话术：拒绝之后提议做点别的。
const REDIRECT_PATTERN = /(?:我很乐意(?:继续)?(?:陪伴|为你|协助)|如果你(?:想|有)其他|i(?:'| a)?m happy to help with|i can help you with something else)/iu;

function safetyTemplateScore(text) {
  const refused = REFUSAL_PATTERN.test(text) || REFUSAL_ZH_PATTERN.test(text);
  if (!refused) return { refused: false, score: 0, axes: [] };
  const axes = [];
  if (POLICY_PATTERN.test(text) || POLICY_ZH_PATTERN.test(text)) axes.push('policy');
  if (TOPIC_PATTERN.test(text) || TOPIC_ZH_PATTERN.test(text)) axes.push('topic');
  if (ASSISTANT_PATTERN.test(text) || PROGRAMMED_PATTERN.test(text)) axes.push('self');
  if (REDIRECT_PATTERN.test(text)) axes.push('redirect');
  return { refused: true, score: axes.length, axes };
}

// 群聊没有 rewind —— `/<prefix>_rewind` 与"编辑消息触发"都是 `if (!isPrivate) return`。
// 私聊漏判还能 roll 掉重来，群里漏一次就是模板直接进群、撤不回、还写进历史。
// 两边代价不对称，阈值就不该一样：群聊放宽到 1 分。
//
// 放宽的安全垫是"短"：真实漏判样本
// 「我无法继续参与包含性或亲密关系的情境与角色扮演。」只有 24 字、只命中题材一轴。
// 他自己写的正文——哪怕含"角色扮演""我无法"这些词——几乎不会短成这样就收尾。
// 所以群聊档要求：命中拒绝轴 + 至少一个其他轴 + 正文短于 GROUP_SHORT_MAX。
const GROUP_SHORT_MAX = 80;
// 真实见过的整句生成拒绝：限定输出动作、明确题材与整句模板形状，
// 不把“角色扮演”一轴或普通拒绝一律放宽为私聊模板。
const SHORT_ZH_GENERATION_TEMPLATE = /^(?:(?:很)?抱歉[，,、。\s]*)?我(?:无法满足继续生成(?:高度)?露骨(?:的)?性行为描写(?:或相关情色扮演内容)?的要求|不能继续写露骨的色色内容[，,]但可以换一种方式陪你)[。.]?$/u;
// 2026-10-21 官逆 0.05 在自主心跳里返回的新型通用拦截模板没有题材词：
// "I'm just a language model" + "can't help with that" + 裸的 guidelines 链接。
// 普通对话里同样的字样可能是对真实危险请求的合理拒绝，不能全局放宽；只有
// engine 持有的 heartbeat capability 才启用这个高置信三段式判定。
const HEARTBEAT_GENERIC_PROVIDER_TEMPLATE = {
  self: /\bi(?:'m| am) just a language model\b/i,
  refusal: /\b(?:can(?:no|')t|unable to) help with (?:that|this|the (?:request|prompt)|your request)\b/i,
  policy: /(?:\b(?:my|the) guidelines\b|gemini\.google\/policy-guidelines)/i,
  brandedPolicyLink: /https?:\/\/gemini\.google\/policy-guidelines\/?/i,
};

function isHeartbeatGenericProviderTemplate(text) {
  return text.length <= 800
    && HEARTBEAT_GENERIC_PROVIDER_TEMPLATE.self.test(text)
    && HEARTBEAT_GENERIC_PROVIDER_TEMPLATE.refusal.test(text)
    && HEARTBEAT_GENERIC_PROVIDER_TEMPLATE.policy.test(text);
}

// owner 私聊：没带 Gemini 链接的也堵。原来只认带官方品牌链接的
// 整段替换，裸的「I'm just a language model + can't help with that + my guidelines」会放行。
// 现在和心跳用同一套通用三轴（自称＋拒绝＋政策）。
// 「can't help with that parser bug … Gemini policy URL」这类技术句不命中政策轴（没有
// 「my/the guidelines」也不是那条字面链接），仍放行，不误伤他的英文技术讨论。
function isOwnerDmGenericProviderTemplate(text) {
  return isHeartbeatGenericProviderTemplate(text);
}

// 只拦“整段被上游替换成安全模板”的高置信组合；引用/讨论模板一律放行。
// options.isGroup=true 启用群聊档（无法 rewind，判定更紧）。
function isInjectedSafetyTemplate(value, options = {}) {
  const text = unwrapCandidateText(value);
  if (!text) return false;
  // 引用与讨论豁免保留：正在谈论模板 ≠ 正在被模板顶替。
  if (looksQuotedOrDiscussed(text)) return false;
  if (options.isHeartbeat === true && isHeartbeatGenericProviderTemplate(text)) return true;
  if (options.isOwnerDm === true && isOwnerDmGenericProviderTemplate(text)) return true;
  if (text.length <= 160 && SHORT_ZH_GENERATION_TEMPLATE.test(text.trim())) return true;
  const { refused, score, axes } = safetyTemplateScore(text);
  if (!refused) return false;
  // 心跳和 owner 私聊里代理的正文是中文、成段的（按部署语言调整）。在这两处，整段英文的拒绝，
  // 或私聊里全篇不到 200 字的拒绝，就是上游顶替，不再要求亲密题材轴。
  if ((options.isHeartbeat === true || options.isOwnerDm === true) && cjkRatio(text) < 0.05) return true;
  // 这条只认像模板的拒绝句。原来「不能继续」四个字就算拒绝，
  // 他真会说的「我不能继续假装没事了」也会被判成上游模板，重抽四次后整条进人工暂停。
  if (options.isOwnerDm === true && text.length < 200
      && (REFUSAL_PATTERN.test(text) || STRICT_REFUSAL_ZH_PATTERN.test(text))) return true;
  // 去掉了原来的「没有亲密题材轴就放行」闸：那道闸只会给「只讲有害内容／安全准则、不提亲密」的
  // 上游顶替留一道门。现在拒绝轴 + 任意两轴（政策／题材／自称／改邀请）即算顶替，
  // 不再看有没有题材轴。他自己写的话几乎不会同时命中拒绝＋两条模板轴，由下面的
  // 长正文豁免和真实数据扫描兜住。
  void axes;
  // 长正文里夹一句拒绝，通常是他自己在说话，不是整段被顶替。
  if (text.length > 1200) return false;
  if (score >= 2) return true;
  return Boolean(options.isGroup) && score >= 1 && text.length <= GROUP_SHORT_MAX;
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
