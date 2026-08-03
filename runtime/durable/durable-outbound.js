// SPDX-License-Identifier: Apache-2.0
'use strict';

const { createHash } = require('node:crypto');

function groupReplyDeliveryKey(text, replyIndex) {
  const digest = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24);
  return `group-reply-${digest}:${Number(replyIndex) || 0}`;
}

// Generation and local history/transcript persistence must finish before the first
// externally visible send. `generate` receives a chunk collector and is expected to
// resolve only after its durable commit. A rejection therefore guarantees zero sends.
async function deliverBufferedTurn({ generate, deliver }) {
  const chunks = [];
  const finalText = await generate((chunk) => {
    if (!chunk || !String(chunk.text || '')) return;
    chunks.push({ kind: chunk.kind || 'content', text: String(chunk.text) });
  });
  // 2026-07-18：engine 侧契约纠正（如私聊 {"replies":[]} 被掰回自然语言）发生在
  // 流式块已缓冲之后、且纠正轮不流式——此时 chunks 是被驳回的旧文本，finalText
  // 才是最终裁定。两者内容不一致就丢弃流式块，以 finalText 单块发送。
  // 比较用空白归一化：chunk emitter 按自然段切块并 trim 每段（正常流拼接后
  // 空白必然与原文不同、字符内容相同），严格相等会把所有正常长回复误判成
  // 改写、退化成超长单块。
  const normalizeForCompare = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const streamedNormalized = normalizeForCompare(chunks.map((chunk) => chunk.text).join(' '));
  const contractRewrote = chunks.length > 0 && streamedNormalized !== normalizeForCompare(finalText);
  const durableChunks = chunks.length && !contractRewrote
    ? chunks
    : [{ kind: 'content', text: String(finalText || '') }];
  for (let index = 0; index < durableChunks.length; index++) {
    await deliver(durableChunks[index], index);
  }
  return { finalText: String(finalText || ''), chunks: durableChunks };
}

module.exports = { deliverBufferedTurn, groupReplyDeliveryKey };
