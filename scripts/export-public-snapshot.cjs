#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function resolveInside(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`Path must be relative: ${relativePath}`);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes root: ${relativePath}`);
  return resolved;
}

function parseArgs(argv) {
  const check = argv.includes('--check');
  const targetIndex = argv.indexOf('--target');
  const target = targetIndex >= 0 ? argv[targetIndex + 1] : process.env.TETHER_PUBLIC_ROOT;
  if (!target) throw new Error('Usage: export-public-snapshot.cjs --target /path/to/public-repo [--check]');
  return { check, target: path.resolve(target) };
}

function findStaleManagedPaths(priorFiles, currentTargets) {
  const wanted = new Set(currentTargets);
  return (priorFiles || [])
    .map((entry) => String(entry?.path || ''))
    .filter((managedPath) => managedPath && !wanted.has(managedPath))
    .sort();
}

function main() {
  const { check, target } = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(__dirname, '..');
  const manifestPath = path.join(sourceRoot, 'public-export-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.exportPolicy !== 'explicit-allowlist-exact-bytes') {
    throw new Error('Manifest export policy must be explicit-allowlist-exact-bytes');
  }
  const entries = [...manifest.files].sort((left, right) => left.target.localeCompare(right.target));
  const seenTargets = new Set();
  for (const entry of entries) {
    if (seenTargets.has(entry.target)) throw new Error(`Duplicate export target: ${entry.target}`);
    seenTargets.add(entry.target);
  }
  const lockPath = path.join(target, 'public-export-lock.json');
  let priorLock = null;
  try { priorLock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot validate prior public export lock: ${error.message}`);
  }
  const staleManaged = findStaleManagedPaths(priorLock?.files, seenTargets);
  if (staleManaged.length) {
    throw new Error(`Prior managed export paths are no longer allowlisted; remove them deliberately before export: ${staleManaged.join(', ')}`);
  }
  const lockFiles = [];
  for (const entry of entries) {
    const sourcePath = resolveInside(sourceRoot, entry.source);
    const targetPath = resolveInside(target, entry.target);
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Export source must be a regular file: ${entry.source}`);
    }
    const sourceBytes = fs.readFileSync(sourcePath);
    const digest = sha256(sourceBytes);
    if (check) {
      const targetBytes = fs.readFileSync(targetPath);
      if (!sourceBytes.equals(targetBytes)) throw new Error(`Exact-byte mismatch: ${entry.target}`);
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, entry.mode ? Number.parseInt(entry.mode, 8) : 0o644);
      const targetBytes = fs.readFileSync(targetPath);
      if (!sourceBytes.equals(targetBytes) || sha256(targetBytes) !== digest) {
        throw new Error(`Post-copy SHA-256 mismatch: ${entry.target}`);
      }
    }
    lockFiles.push({ path: entry.target, sha256: digest, size: sourceBytes.length });
  }
  const lock = { schemaVersion: 1, exportPolicy: manifest.exportPolicy, files: lockFiles };
  if (check) {
    const actual = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(lock)) throw new Error('public-export-lock.json is stale');
  } else {
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o644 });
  }
  console.log(`Public export ${check ? 'check' : 'copy'}: PASS (${lockFiles.length} exact-byte files)`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { findStaleManagedPaths, main, parseArgs, resolveInside, sha256 };
