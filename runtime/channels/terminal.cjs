// SPDX-License-Identifier: Apache-2.0
'use strict';

const readline = require('node:readline');
const crypto = require('node:crypto');

function createTerminalChannel({ id = 'terminal', input = process.stdin, output = process.stdout } = {}) {
  let handler = null;
  return {
    id,
    onMessage(next) { handler = next; },
    async send(message) { output.write(`${message.text}\n`); },
    start({ allowCreateSession = false } = {}) {
      if (!handler) throw new Error('Terminal channel is not attached');
      const interface_ = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });
      interface_.on('line', (text) => {
        handler({
          messageId: `${id}:${crypto.randomUUID()}`,
          text,
          allowCreateSession,
          metadata: { channel: 'terminal' },
        }).catch((error) => output.write(`[error] ${error.message}\n`));
        allowCreateSession = false;
      });
      return interface_;
    },
  };
}

module.exports = { createTerminalChannel };
