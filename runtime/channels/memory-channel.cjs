// SPDX-License-Identifier: Apache-2.0
'use strict';

function createMemoryChannel(id) {
  let handler = null;
  const sent = [];
  return {
    id: String(id),
    sent,
    onMessage(next) { handler = next; },
    async send(message) { sent.push(structuredClone(message)); },
    async receive(message) {
      if (!handler) throw new Error('Channel is not attached');
      return handler(structuredClone(message));
    },
  };
}

module.exports = { createMemoryChannel };
