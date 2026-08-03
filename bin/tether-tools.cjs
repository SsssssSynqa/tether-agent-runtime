#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const path = require('node:path');
const { loadTetherConfig } = require('../runtime/config-loader.cjs');
const { ToolJournal } = require('../runtime/tools/tool-journal.cjs');

function usage() {
  return [
    'Usage:',
    '  tether-tools approvals [config.json]',
    '  tether-tools approve <approval-id> [config.json]',
    '  tether-tools deny <approval-id> [config.json]',
    '  tether-tools operations [config.json]',
  ].join('\n');
}

function journalForConfig(configPath) {
  const config = loadTetherConfig(configPath, { resolveCredentials: false });
  return new ToolJournal({ directory: path.join(config.storage.root, 'tools') });
}

function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || '');
  if (!['approvals', 'approve', 'deny', 'operations'].includes(command)) {
    throw new Error(usage());
  }
  const resolvesApproval = command === 'approve' || command === 'deny';
  const approvalId = resolvesApproval ? String(argv[1] || '') : null;
  if (resolvesApproval && !approvalId) throw new Error(usage());
  const configPath = resolvesApproval ? argv[2] || './config.json' : argv[1] || './config.json';
  const journal = journalForConfig(configPath);
  let result;
  if (command === 'approvals') {
    result = journal.listApprovals();
  } else if (command === 'operations') {
    result = journal.listOperations({ limit: 200 });
  } else {
    result = journal.resolveApproval(
      approvalId,
      command === 'approve' ? 'approved' : 'denied',
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { journalForConfig, main, usage };
