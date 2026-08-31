#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function trackedFiles(root, spawnImpl = spawnSync) {
  const result = spawnImpl('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${String(result.stderr || '').trim()}`);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function copyTrackedFixture(sourceRoot, targetRoot, files) {
  for (const relativePath of files) {
    const sourcePath = path.resolve(sourceRoot, relativePath);
    if (!sourcePath.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error(`Tracked path escapes repository: ${relativePath}`);
    }
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Shadow fixture accepts regular tracked files only: ${relativePath}`);
    }
    const targetPath = path.resolve(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, stat.mode & 0o777);
  }
}

function cleanEnvironment(home) {
  const allowed = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CI', 'NODE_OPTIONS'];
  const env = Object.fromEntries(allowed
    .filter((key) => process.env[key] != null)
    .map((key) => [key, process.env[key]]));
  return {
    ...env,
    HOME: home,
    CI: '1',
    NO_COLOR: '1',
    TETHER_SHADOW_FIXTURE: '1',
  };
}

function runShadowTests({ root = path.resolve(__dirname, '..'), spawnImpl = spawnSync } = {}) {
  const sourceRoot = path.resolve(root);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-shadow-'));
  const fixtureHome = path.join(fixtureRoot, '.home');
  fs.mkdirSync(fixtureHome, { recursive: true, mode: 0o700 });
  let result;
  try {
    const files = trackedFiles(sourceRoot, spawnImpl);
    copyTrackedFixture(sourceRoot, fixtureRoot, files);
    result = spawnImpl(process.execPath, [
      path.join(fixtureRoot, 'test', 'provider-circuit.cjs'),
    ], {
      cwd: fixtureRoot,
      env: cleanEnvironment(fixtureHome),
      stdio: 'inherit',
    });
    if (result.status !== 0) return result.status ?? 1;
    for (const relativeTest of [
      'test/telegram-gate.cjs',
      'test/external-recall.cjs',
      'test/offline.cjs',
      'test/layered-runtime.cjs',
    ]) {
      result = spawnImpl(process.execPath, [path.join(fixtureRoot, relativeTest)], {
        cwd: fixtureRoot,
        env: cleanEnvironment(fixtureHome),
        stdio: 'inherit',
      });
      if (result.status !== 0) return result.status ?? 1;
    }
    process.stdout.write(`Tracked-source shadow tests: PASS (${files.length} files)\n`);
    return 0;
  } finally {
    // The path is created by mkdtemp under the OS temp root and is never
    // caller-controlled. Remove only that owned fixture.
    if (fixtureRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tether-shadow-`)) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  try {
    process.exitCode = runShadowTests();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { cleanEnvironment, copyTrackedFixture, runShadowTests, trackedFiles };
