#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function verifyFileLock(baseDirectory, files) {
  const base = path.resolve(baseDirectory);
  const failures = [];
  const seen = new Set();
  for (const entry of files || []) {
    const relative = String(entry?.path || '');
    if (!relative || path.isAbsolute(relative) || seen.has(relative)) {
      failures.push(`${relative || '<empty>'}: invalid or duplicate lock path`);
      continue;
    }
    seen.add(relative);
    const filePath = path.resolve(base, relative);
    if (!filePath.startsWith(`${base}${path.sep}`)) {
      failures.push(`${relative}: escapes lock root`);
      continue;
    }
    let stat;
    let bytes;
    try {
      stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      bytes = fs.readFileSync(filePath);
    } catch (error) {
      failures.push(`${relative}: ${error.code || error.message}`);
      continue;
    }
    if (!Number.isInteger(entry.size) || entry.size !== stat.size || entry.size !== bytes.length) {
      failures.push(`${relative}: size mismatch`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      failures.push(`${relative}: invalid sha256 field`);
    } else if (sha256(bytes) !== entry.sha256) {
      failures.push(`${relative}: sha256 mismatch`);
    }
  }
  return failures;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function verifyRepository(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const failures = [];
  let checkedFiles = 0;

  const rootLockPath = path.join(root, 'public-export-lock.json');
  const rootLock = readJson(rootLockPath);
  if (rootLock.schemaVersion !== 1 || rootLock.exportPolicy !== 'explicit-allowlist-exact-bytes') {
    failures.push('public-export-lock.json: unsupported schema or policy');
  }
  checkedFiles += Array.isArray(rootLock.files) ? rootLock.files.length : 0;
  failures.push(...verifyFileLock(root, rootLock.files).map((item) => `runtime:${item}`));

  const consoleRoot = path.join(root, 'console');
  const consoleLock = readJson(path.join(consoleRoot, 'export-lock.json'));
  if (consoleLock.schema_version !== 1) failures.push('console/export-lock.json: unsupported schema');
  if (!Number.isInteger(consoleLock.file_count) || consoleLock.file_count !== consoleLock.files?.length) {
    failures.push('console/export-lock.json: file_count mismatch');
  }
  checkedFiles += Array.isArray(consoleLock.files) ? consoleLock.files.length : 0;
  failures.push(...verifyFileLock(consoleRoot, consoleLock.files).map((item) => `console:${item}`));

  return { failures, checkedFiles };
}

function main() {
  const root = path.resolve(__dirname, '..');
  const result = verifyRepository(root);
  if (result.failures.length) {
    console.error(`Public export verification failed:\n- ${result.failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Public export verification: PASS (${result.checkedFiles} runtime+console files)`);
  }
}

if (require.main === module) main();

module.exports = { sha256, verifyFileLock, verifyRepository };
