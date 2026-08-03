#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.venv']);
const failures = [];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
  }
  return files;
}

for (const file of walk(root)) {
  const source = fs.readFileSync(file, 'utf8');
  const withoutFences = source.replace(/```[\s\S]*?```/g, '');
  for (const match of withoutFences.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (!target) continue;
    let decoded;
    try { decoded = decodeURIComponent(target); } catch { decoded = target; }
    const resolved = path.resolve(path.dirname(file), decoded);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      failures.push(`${path.relative(root, file)}: link escapes repository: ${match[1]}`);
    } else if (!fs.existsSync(resolved)) {
      failures.push(`${path.relative(root, file)}: missing link target: ${match[1]}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`Markdown links: FAIL (${failures.length})\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Markdown links: PASS\n');
}
