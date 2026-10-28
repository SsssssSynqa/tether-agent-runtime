// SPDX-License-Identifier: Apache-2.0
'use strict';

const { createHash } = require('node:crypto');

function groupReplyDeliveryKey(text, replyIndex) {
  const digest = createHash('sha256').update(String(text || '')).digest('hex').slice(0, 24);
  return `group-reply-${digest}:${Number(replyIndex) || 0}`;
}

function selectDurableChunks(finalText, chunks = []) {
  const usable = chunks.filter(chunk => chunk && String(chunk.text || ''))
    .map(chunk => ({ kind: chunk.kind || 'content', text: String(chunk.text) }));
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  return usable.length && normalize(usable.map(chunk => chunk.text).join(' ')) === normalize(finalText)
    ? usable : [{ kind: 'content', text: String(finalText || '') }];
}

// Generation and local history/transcript persistence must finish before the first
// externally visible send. `generate` receives a chunk collector and is expected to
// resolve only after its durable commit. A rejection therefore guarantees zero sends.
async function deliverBufferedTurn({ generate, deliver, getPublicationPlan = null, deliverPublication = null }) {
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
  const durableChunks = selectDurableChunks(finalText, chunks);
  const publicationPlan = getPublicationPlan?.();
  if (publicationPlan != null) {
    if (typeof deliverPublication !== 'function') throw new Error('publication_sender_missing');
    const publication = await deliverPublication(publicationPlan);
    return { finalText: String(finalText || ''), chunks: durableChunks, publication };
  }
  for (let index = 0; index < durableChunks.length; index++) {
    await deliver(durableChunks[index], index);
  }
  return { finalText: String(finalText || ''), chunks: durableChunks };
}

module.exports = { deliverBufferedTurn, groupReplyDeliveryKey, selectDurableChunks };
