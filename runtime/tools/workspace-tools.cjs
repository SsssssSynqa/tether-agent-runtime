// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ToolJournal, sha256 } = require('./tool-journal.cjs');

const TOOL_SPECS = Object.freeze({
  list_workspace_directory: {
    capability: 'read',
    description: 'List one directory inside a configured workspace root.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Configured workspace root identifier.' },
        path: { type: 'string', description: 'Relative directory path. Use "." for the root.' },
      },
      required: ['root', 'path'],
      additionalProperties: false,
    },
  },
  read_workspace_file: {
    capability: 'read',
    description: 'Read one UTF-8 text file inside a configured workspace root.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Configured workspace root identifier.' },
        path: { type: 'string', description: 'Relative file path.' },
      },
      required: ['root', 'path'],
      additionalProperties: false,
    },
  },
  write_workspace_file: {
    capability: 'write',
    description: 'Atomically create or replace one UTF-8 text file inside a configured workspace root.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Configured workspace root identifier.' },
        path: { type: 'string', description: 'Relative file path.' },
        content: { type: 'string', description: 'Complete UTF-8 file content.' },
      },
      required: ['root', 'path', 'content'],
      additionalProperties: false,
    },
  },
});

const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.gnupg|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|private(?:\..*)?|keychain(?:\..*)?|.*[._-](?:credentials?|secrets?|tokens?|private)(?:[._-].*|$)|.*\.(?:pem|key|p12|pfx))$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeRelativePath(value, { allowRoot = false } = {}) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (raw.includes('\0') || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw toolError('TETHER_TOOL_PATH_INVALID', 'Path must be relative to a configured workspace root');
  }
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw toolError('TETHER_TOOL_PATH_INVALID', 'Path traversal is not allowed');
  }
  if (!parts.length) {
    if (allowRoot) return '.';
    throw toolError('TETHER_TOOL_PATH_INVALID', 'A file path is required');
  }
  if (parts.some((part) => part.startsWith('.') || SENSITIVE_NAME.test(part))) {
    throw toolError('TETHER_TOOL_PATH_SENSITIVE', 'Hidden and credential-like paths are not available to tools');
  }
  return parts.join('/');
}

function toolError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function ensureNoSymlinkComponents(root, relativePath, { allowMissing = false } = {}) {
  const parts = relativePath === '.' ? [] : relativePath.split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw toolError('TETHER_TOOL_PATH_SYMLINK', 'Symbolic links are not available to tools');
    }
  }
}

function normalizedArguments(toolName, rawArguments) {
  if (!Object.hasOwn(TOOL_SPECS, toolName)) {
    throw toolError('TETHER_TOOL_UNKNOWN', 'Unknown workspace tool');
  }
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    throw toolError('TETHER_TOOL_ARGUMENTS_INVALID', 'Tool arguments must be an object');
  }
  const allowed = toolName === 'write_workspace_file'
    ? new Set(['root', 'path', 'content'])
    : new Set(['root', 'path']);
  if (Object.keys(rawArguments).some((key) => !allowed.has(key))) {
    throw toolError('TETHER_TOOL_ARGUMENTS_INVALID', 'Tool arguments contain an unknown field');
  }
  const root = String(rawArguments.root || '').trim();
  if (!root) throw toolError('TETHER_TOOL_ARGUMENTS_INVALID', 'A workspace root identifier is required');
  const relativePath = safeRelativePath(rawArguments.path, {
    allowRoot: toolName === 'list_workspace_directory',
  });
  if (toolName === 'write_workspace_file') {
    if (typeof rawArguments.content !== 'string') {
      throw toolError('TETHER_TOOL_ARGUMENTS_INVALID', 'File content must be a string');
    }
    return { root, path: relativePath, content: rawArguments.content };
  }
  return { root, path: relativePath };
}

function scopeForContext(context = {}) {
  if (context.isGroup === true || String(context.trustZone || '').startsWith('group:')) {
    return 'telegramGroup';
  }
  const channelId = String(context.channelId || context.channel || '');
  if (channelId === 'telegram' || channelId.startsWith('telegram:')) return 'telegramPrivate';
  if (channelId === 'terminal' || channelId.startsWith('terminal:')) return 'terminal';
  return 'default';
}

function sanitizedFailure(error) {
  const known = String(error?.code || '').startsWith('TETHER_TOOL_');
  return {
    ok: false,
    status: 'error',
    error: {
      code: known ? error.code : 'TETHER_TOOL_FAILED',
      message: known ? error.message : 'Workspace operation failed',
    },
  };
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function atomicWrite(filePath, bytes, mode = 0o644) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.tether-write-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, mode);
    syncDirectory(directory);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function fileState(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw toolError('TETHER_TOOL_PATH_SYMLINK', 'Symbolic links are not available to tools');
    }
    if (!stat.isFile()) throw toolError('TETHER_TOOL_NOT_FILE', 'Workspace path is not a regular file');
    const bytes = fs.readFileSync(filePath);
    return { exists: true, sha256: sha256(bytes), size: bytes.length };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, sha256: null, size: 0 };
    throw error;
  }
}

function sameFileState(left, right) {
  return left?.exists === right?.exists
    && left?.sha256 === right?.sha256
    && Number(left?.size || 0) === Number(right?.size || 0);
}

function prepareRoots(workspaceRoots = []) {
  const roots = new Map();
  for (const item of workspaceRoots) {
    const id = String(item.id);
    const configuredPath = path.resolve(item.path);
    const alreadyExists = fs.existsSync(configuredPath);
    fs.mkdirSync(configuredPath, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(configuredPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw toolError('TETHER_TOOL_ROOT_INVALID', `Workspace root ${id} must be a real directory`);
    }
    const realPath = fs.realpathSync(configuredPath);
    if (!alreadyExists) fs.chmodSync(realPath, 0o700);
    roots.set(id, { id, path: realPath });
  }
  return roots;
}

function createWorkspaceToolRuntime({ config = {}, storageRoot, log = () => {} } = {}) {
  const settings = config.tools || {};
  const enabled = settings.enabled === true;
  const authorityRoot = path.resolve(storageRoot || config.storage?.root || '.');
  fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
  const authorityRealPath = fs.realpathSync(authorityRoot);
  const roots = enabled ? prepareRoots(settings.workspaceRoots || []) : new Map();
  for (const root of roots.values()) {
    if (isInside(authorityRealPath, root.path) || isInside(root.path, authorityRealPath)) {
      throw toolError(
        'TETHER_TOOL_ROOT_OVERLAPS_STORAGE',
        'Workspace roots must not contain or be contained by Tether continuity storage',
      );
    }
  }
  const journal = new ToolJournal({
    directory: path.join(authorityRoot, 'tools'),
  });
  const maxReadBytes = Number(settings.maxReadBytes || 512 * 1024);
  const maxWriteBytes = Number(settings.maxWriteBytes || 1024 * 1024);
  const maxDirectoryEntries = Number(settings.maxDirectoryEntries || 200);
  const policies = settings.policies || {};

  function policyFor(toolName, context) {
    const scope = scopeForContext(context);
    const capability = TOOL_SPECS[toolName]?.capability;
    const policy = policies[scope] || policies.default || {};
    return { scope, capability, decision: policy[capability] || 'deny' };
  }

  function definitions(context = {}) {
    if (!enabled) return [];
    const rootIds = [...roots.keys()];
    return Object.entries(TOOL_SPECS)
      .filter(([toolName]) => policyFor(toolName, context).decision !== 'deny')
      .map(([name, spec]) => {
        const parameters = structuredClone(spec.parameters);
        parameters.properties.root.enum = rootIds;
        return {
          type: 'function',
          function: { name, description: spec.description, parameters },
        };
      });
  }

  function contractHash(context = {}) {
    const scope = scopeForContext(context);
    return sha256(canonicalJson({
      schemaVersion: 1,
      enabled,
      scope,
      policy: policies[scope] || policies.default || {},
      limits: { maxReadBytes, maxWriteBytes, maxDirectoryEntries },
      roots: [...roots.values()].map((root) => ({
        id: root.id,
        pathSha256: sha256(root.path),
      })),
    }));
  }

  function targetFor(args, { allowMissing = false } = {}) {
    const root = roots.get(args.root);
    if (!root) throw toolError('TETHER_TOOL_ROOT_UNKNOWN', 'Unknown workspace root identifier');
    const candidate = args.path === '.' ? root.path : path.resolve(root.path, args.path);
    if (!isInside(root.path, candidate)) {
      throw toolError('TETHER_TOOL_PATH_INVALID', 'Path escapes the configured workspace root');
    }
    ensureNoSymlinkComponents(root.path, args.path, { allowMissing });
    return { root, candidate };
  }

  function listDirectory(args) {
    const { root, candidate } = targetFor(args);
    const real = fs.realpathSync(candidate);
    if (!isInside(root.path, real)) throw toolError('TETHER_TOOL_PATH_INVALID', 'Path escapes workspace root');
    const entries = fs.readdirSync(real, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && !SENSITIVE_NAME.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, maxDirectoryEntries)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unavailable',
      }));
    return {
      ok: true,
      status: 'completed',
      root: args.root,
      path: args.path,
      entries,
      truncated: entries.length === maxDirectoryEntries
        && fs.readdirSync(real).filter((name) => !name.startsWith('.') && !SENSITIVE_NAME.test(name)).length > entries.length,
    };
  }

  function readFile(args) {
    const { root, candidate } = targetFor(args);
    const real = fs.realpathSync(candidate);
    if (!isInside(root.path, real)) throw toolError('TETHER_TOOL_PATH_INVALID', 'Path escapes workspace root');
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw toolError('TETHER_TOOL_NOT_FILE', 'Workspace path is not a regular file');
    if (stat.size > maxReadBytes) throw toolError('TETHER_TOOL_FILE_TOO_LARGE', 'File exceeds the configured read limit');
    const bytes = fs.readFileSync(real);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) {
      throw toolError('TETHER_TOOL_NOT_UTF8', 'Only UTF-8 text files can be read');
    }
    return {
      ok: true,
      status: 'completed',
      root: args.root,
      path: args.path,
      content,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  }

  function writeFile(args, prepared) {
    const bytes = Buffer.from(args.content, 'utf8');
    if (bytes.length > maxWriteBytes) {
      throw toolError('TETHER_TOOL_FILE_TOO_LARGE', 'File exceeds the configured write limit');
    }
    const { root, candidate } = targetFor(args, { allowMissing: true });
    const desired = { exists: true, sha256: sha256(bytes), size: bytes.length };
    const current = fileState(candidate);
    const prior = prepared?.details?.prior || current;
    if (prepared) {
      if (sameFileState(current, desired)) {
        return { recovered: true, result: {
          ok: true, status: 'completed', root: args.root, path: args.path,
          bytes: bytes.length, sha256: desired.sha256,
        } };
      }
      if (!sameFileState(current, prior)) {
        throw toolError(
          'TETHER_TOOL_EFFECT_AMBIGUOUS',
          'File changed after a prepared write; operator review is required',
          { manualRetryOnly: true },
        );
      }
    }
    const parentParts = path.dirname(args.path) === '.' ? [] : path.dirname(args.path).split('/');
    let parent = root.path;
    for (const part of parentParts) {
      parent = path.join(parent, part);
      try {
        const stat = fs.lstatSync(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw toolError('TETHER_TOOL_PATH_SYMLINK', 'Workspace parent must be a real directory');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fs.mkdirSync(parent, { mode: 0o700 });
      }
      const real = fs.realpathSync(parent);
      if (!isInside(root.path, real)) {
        throw toolError('TETHER_TOOL_PATH_INVALID', 'Path escapes workspace root');
      }
    }
    ensureNoSymlinkComponents(
      root.path,
      path.dirname(args.path) === '.' ? '.' : path.dirname(args.path),
    );
    const parentReal = fs.realpathSync(path.dirname(candidate));
    if (!isInside(root.path, parentReal)) throw toolError('TETHER_TOOL_PATH_INVALID', 'Path escapes workspace root');
    let targetMode = 0o644;
    try { targetMode = fs.statSync(candidate).mode & 0o777; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    atomicWrite(candidate, bytes, targetMode);
    return { recovered: false, result: {
      ok: true,
      status: 'completed',
      root: args.root,
      path: args.path,
      bytes: bytes.length,
      sha256: desired.sha256,
    } };
  }

  async function execute(call, context = {}) {
    const toolName = String(call?.name || '');
    const toolCallId = String(call?.id || '');
    const causalId = String(context.causalId || '');
    try {
      if (!enabled) throw toolError('TETHER_TOOL_DISABLED', 'Workspace tools are disabled');
      if (!causalId || !toolCallId) {
        throw toolError('TETHER_TOOL_IDENTITY_MISSING', 'Tool call requires causal and call identifiers');
      }
      const args = normalizedArguments(toolName, call.arguments);
      if (!roots.has(args.root)) throw toolError('TETHER_TOOL_ROOT_UNKNOWN', 'Unknown workspace root identifier');
      const policy = policyFor(toolName, context);
      if (policy.decision === 'deny') throw toolError('TETHER_TOOL_DENIED', 'Tool is denied in this channel scope');
      const fingerprint = sha256(canonicalJson({ schemaVersion: 1, scope: policy.scope, toolName, args }));
      const operationKey = `operation:${sha256(canonicalJson({ causalId, toolCallId })).slice(0, 32)}`;
      const existing = journal.operation(operationKey);
      if (existing?.fingerprint && existing.fingerprint !== fingerprint) {
        throw toolError('TETHER_TOOL_OPERATION_MISMATCH', 'Tool call identifier was reused with different arguments');
      }
      if (existing?.state === 'committed') {
        return { ...existing.result, replayed: true };
      }
      if (policy.decision === 'approval') {
        const approvalFingerprint = sha256(canonicalJson({ causalId, toolCallId, fingerprint }));
        const summary = {
          root: args.root,
          path: args.path,
          ...(toolName === 'write_workspace_file' ? {
            bytes: Buffer.byteLength(args.content, 'utf8'),
            sha256: sha256(args.content),
          } : {}),
        };
        const approval = journal.approvalForFingerprint(approvalFingerprint)
          || journal.requestApproval({
            fingerprint: approvalFingerprint,
            toolName,
            scope: policy.scope,
            summary,
          });
        if (approval.state === 'pending') {
          throw toolError(
            'TETHER_TOOL_APPROVAL_REQUIRED',
            `Operator approval is required: ${approval.approvalId}`,
            {
              approvalId: approval.approvalId,
              pauseRetry: true,
              retryAfterMs: 30_000,
            },
          );
        }
        if (approval.state === 'denied') {
          return {
            ok: false,
            status: 'denied',
            error: { code: 'TETHER_TOOL_APPROVAL_DENIED', message: 'Operator denied this exact tool call' },
          };
        }
      }

      if (toolName === 'write_workspace_file') {
        const bytes = Buffer.from(args.content, 'utf8');
        if (bytes.length > maxWriteBytes) {
          throw toolError('TETHER_TOOL_FILE_TOO_LARGE', 'File exceeds the configured write limit');
        }
        const { candidate } = targetFor(args, { allowMissing: true });
        const prepared = existing || journal.prepareOperation({
          operationKey,
          fingerprint,
          causalId,
          toolCallId,
          toolName,
          details: {
            prior: fileState(candidate),
            desired: { exists: true, sha256: sha256(bytes), size: bytes.length },
          },
        });
        const outcome = writeFile(args, prepared);
        const committed = journal.commitOperation(operationKey, outcome.result, {
          recovered: outcome.recovered,
        });
        return { ...committed.result, replayed: outcome.recovered };
      }

      if (existing?.state === 'prepared' && existing.details?.result) {
        const committed = journal.commitOperation(operationKey, existing.details.result, { recovered: true });
        return { ...committed.result, replayed: true };
      }
      const result = toolName === 'list_workspace_directory'
        ? listDirectory(args)
        : readFile(args);
      journal.prepareOperation({
        operationKey,
        fingerprint,
        causalId,
        toolCallId,
        toolName,
        details: { result },
      });
      journal.commitOperation(operationKey, result);
      return result;
    } catch (error) {
      if (error?.code === 'TETHER_TOOL_APPROVAL_REQUIRED'
        || error?.code === 'TETHER_TOOL_EFFECT_AMBIGUOUS') {
        throw error;
      }
      log({ event: 'workspace-tool-rejected', code: error?.code || 'TETHER_TOOL_FAILED', toolName });
      return sanitizedFailure(error);
    }
  }

  return {
    beginTransaction: (...args) => journal.beginTransaction(...args),
    canResume: (causalId) => journal.canResume(causalId),
    contractHash,
    definitions,
    execute,
    journal,
    maxIterations: Number(settings.maxIterations || 5),
    recordTransaction: (...args) => journal.recordTransaction(...args),
    scopeForContext,
    transactionEvents: (causalId) => journal.transactionEvents(causalId),
  };
}

module.exports = {
  TOOL_SPECS,
  canonicalJson,
  createWorkspaceToolRuntime,
  safeRelativePath,
  scopeForContext,
};
