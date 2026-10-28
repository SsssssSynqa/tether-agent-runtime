#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const { loadTetherConfig } = require('../runtime/config-loader.cjs');
const { TetherSupervisor } = require('../runtime/operations/supervisor.cjs');

async function main(argv = process.argv.slice(2)) {
  const configPath = argv[0] || './config.json';
  const config = loadTetherConfig(configPath, { resolveCredentials: false });
  const supervisor = new TetherSupervisor({
    configPath,
    storageRoot: config.storage.root,
    settings: config.supervision || {},
  });
  await supervisor.start();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[tether-supervisor] ${error.code || 'TETHER_SUPERVISOR_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
