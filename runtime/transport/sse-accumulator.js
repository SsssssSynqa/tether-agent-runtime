// SPDX-License-Identifier: Apache-2.0
'use strict';
/*
 * sse-accumulator —— 解析 OpenRouter/OpenAI 风格 chat completions 流式响应
 * 纯逻辑，不碰网络/fetch，方便离线测试；真实网络读取在 openrouter-client.js
 * 里逐行喂给这里。
 *
 * OpenAI 兼容流式格式：每行 "data: {json}"，结束是 "data: [DONE]"。
 * delta.content 是文本增量；delta.tool_calls 是工具调用增量，按 index 累积
 * （同一个工具调用的 name/arguments 可能分散在好几个 delta 里）。
 */
function createSseAccumulator({ onContent = () => {} } = {}) {
  let content = '';
  let finishReason = null;
  let usage = null;
  let sawDone = false;   // 2026-07-20：跟踪流是否收到规范收尾（判残用）
  const toolCallsByIndex = new Map();

  function feedLine(rawLine) {
    const line = String(rawLine || '').trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { sawDone = true; return; }
    if (!payload) return;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (_) {
      return; // 畸形行安全忽略，不能让一行坏数据炸掉整个流
    }
    if (parsed.error) throw new Error(parsed.error.message || 'OpenRouter 流式响应报错');
    if (parsed.usage) usage = parsed.usage;

    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta || {};
    // 两者独立处理，不能互斥：部分中转渠道会把「工具调用前的说明文字」和
    // tool_calls 放进同一个 delta，用 else-if 会把那段正文静默丢掉。
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onContent(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        // index 缺失时不能一律落到 0：多个工具调用的 arguments 会被串接成
        // 一段非法 JSON。按 id 分桶兜底，再退化为出现顺序。
        const key = Number.isFinite(Number(tc.index)) ? Number(tc.index)
          : tc.id ? `id:${tc.id}`
            : `seq:${toolCallsByIndex.size}`;
        const entry = toolCallsByIndex.get(key) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.function.name = tc.function.name;
        if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
        toolCallsByIndex.set(key, entry);
      }
    }
  }

  function getResult() {
    // 按 index 数值排序，而不是 Map 的插入序：delta 乱序到达时数组顺序会错。
    // 无 index 的降级桶没有可靠序号，保持插入序排在后面。
    const entries = [...toolCallsByIndex.entries()];
    const toolCalls = [
      ...entries.filter(([key]) => typeof key === 'number').sort((a, b) => a[0] - b[0]),
      ...entries.filter(([key]) => typeof key !== 'number'),
    ].map(([, value]) => value);
    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : null,
      finishReason,
      usage,
      sawDone,
    };
  }

  return { feedLine, getResult };
}

module.exports = { createSseAccumulator };
