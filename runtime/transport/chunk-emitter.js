// SPDX-License-Identifier: Apache-2.0
'use strict';
/*
 * chunk-emitter —— 流式输出的核心纯逻辑（不碰网络）
 *
 * Some persona policies request an explicit 【运行日志】 section at the end.
 * Private replies can be long, so sending them only after completion is both slow and
 * 攒完再发一条 Telegram 消息既要等很久又难读；这个模块把模型吐出来的文字流
 * 切成自然的分段消息，并且把运行日志识别出来单独作为最后一条，不跟正文混在
 * 一起分段（正文按自然段边界\n\n分段实时吐出，日志区整体攒到结束一次性吐出）。
 *
 * 用法：createChunkEmitter(onChunk)，每来一点新文字调 push(delta)，流结束调
 * finish()。onChunk 收到 {kind: 'content', text} 或 {kind: 'log', text}。
 */
const LOG_MARKER = '【运行日志】';

function createChunkEmitter(onChunk) {
  let buffer = '';
  let inLog = false;

  function flushCompleteParagraphs() {
    for (;;) {
      const idx = buffer.indexOf('\n\n');
      if (idx === -1) return;
      const para = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (para) onChunk({ kind: 'content', text: para });
    }
  }

  return {
    push(delta) {
      if (!delta) return;
      buffer += delta;
      if (inLog) return; // 日志区不分段，攒到 finish 统一吐出

      const markerIdx = buffer.indexOf(LOG_MARKER);
      if (markerIdx !== -1) {
        const afterMarker = buffer.slice(markerIdx);
        buffer = buffer.slice(0, markerIdx); // 标记之前的部分照常走自然段切分，不能整块当一条发
        flushCompleteParagraphs();
        const remaining = buffer.trim(); // 标记前最后一段不完整的正文（如果有）
        if (remaining) onChunk({ kind: 'content', text: remaining });
        buffer = afterMarker; // 从标记本身开始，整段归入日志区
        inLog = true;
        return;
      }
      flushCompleteParagraphs();
    },
    finish() {
      const rest = buffer.trim();
      if (!rest) return;
      onChunk({ kind: inLog ? 'log' : 'content', text: rest });
      buffer = '';
    },
  };
}

module.exports = { createChunkEmitter, LOG_MARKER };
