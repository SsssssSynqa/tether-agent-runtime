// SPDX-License-Identifier: Apache-2.0
'use strict';

const readline = require('node:readline');
const crypto = require('node:crypto');

function formatOutputRoutes(routes) {
  const normalized = Array.isArray(routes) ? routes.filter(Boolean) : [];
  if (!normalized.length) return 'provider not recorded | model not recorded';
  return normalized.map((route) => (
    `${route.providerLabel || route.providerId || 'provider not recorded'} | ${route.model || 'model not recorded'}`
  )).join(' -> ');
}

function createTerminalChannel({
  id = 'terminal',
  input = process.stdin,
  output = process.stdout,
  diagnosticOutput = process.stderr,
  showOutputRoutes = true,
} = {}) {
  let handler = null;
  return {
    id,
    onMessage(next) { handler = next; },
    async send(message) {
      output.write(`${message.text}\n`);
      if (showOutputRoutes && diagnosticOutput?.write) {
        diagnosticOutput.write(`[route] ${formatOutputRoutes(message.outputRoutes)}\n`);
      }
    },
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

module.exports = { createTerminalChannel, formatOutputRoutes };
