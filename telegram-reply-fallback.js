// SPDX-License-Identifier: Apache-2.0
'use strict';

const MISSING_REPLY_TARGET = /\bmessage to be replied not found\b/i;

function buildReplyParameters(messageId) {
  return {
    message_id: messageId,
    // Telegram can deliver the message normally when the replied-to message was
    // deleted between ingress and egress. Keep the explicit catch below as a
    // compatibility fallback for gateways that still return the legacy 400.
    allow_sending_without_reply: true,
  };
}

function isMissingReplyTargetError(error) {
  const status = Number(error?.status);
  return (!Number.isFinite(status) || status === 400)
    && MISSING_REPLY_TARGET.test(String(error?.message || error || ''));
}

async function sendWithMissingReplyFallback(send, method, params, { log = () => {} } = {}) {
  try {
    return await send(method, params);
  } catch (error) {
    if (!params?.reply_parameters || !isMissingReplyTargetError(error)) throw error;
    const { reply_parameters: _replyParameters, ...bareParams } = params;
    log(`[telegram] ${method} 的引用目标已不存在，去掉 reply_parameters 降级发送一次`);
    return send(method, bareParams);
  }
}

module.exports = {
  buildReplyParameters,
  isMissingReplyTargetError,
  sendWithMissingReplyFallback,
};
