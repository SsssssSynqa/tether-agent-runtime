// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class SelfsameContinuityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SelfsameContinuityError';
    this.code = 'TETHER_SESSION_CONTINUITY';
    this.details = details;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readState(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

class SelfsameSession {
  constructor({
    stateFile,
    agentId,
    createSession,
    resumeSession,
    canCreateSession = async () => false,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!stateFile || !agentId) throw new Error('SelfsameSession requires stateFile and agentId');
    if (typeof createSession !== 'function' || typeof resumeSession !== 'function') {
      throw new Error('SelfsameSession requires createSession and resumeSession callbacks');
    }
    this.stateFile = path.resolve(stateFile);
    this.agentId = String(agentId);
    this.createSession = createSession;
    this.resumeSession = resumeSession;
    if (typeof canCreateSession !== 'function') {
      throw new Error('SelfsameSession canCreateSession must be a function');
    }
    this.canCreateSession = canCreateSession;
    this.clock = clock;
    this.state = null;
    this.openPromise = null;
  }

  async open({ allowCreate = false } = {}) {
    if (this.state) return this.state;
    if (this.openPromise) return this.openPromise;
    this.openPromise = this._open({ allowCreate }).finally(() => { this.openPromise = null; });
    return this.openPromise;
  }

  async _open({ allowCreate }) {
    let stored;
    try { stored = readState(this.stateFile); } catch (error) {
      throw new SelfsameContinuityError('Stored session anchor could not be read', {
        cause: error.message,
      });
    }
    if (stored !== undefined) {
      const malformed = !stored
        || typeof stored !== 'object'
        || Array.isArray(stored)
        || stored.schemaVersion !== 1
        || typeof stored.agentId !== 'string'
        || !stored.agentId.trim()
        || typeof stored.sessionId !== 'string'
        || !stored.sessionId.trim()
        || typeof stored.createdAt !== 'string'
        || !stored.createdAt.trim()
        || (stored.memoryProof != null
          && (typeof stored.memoryProof !== 'object' || Array.isArray(stored.memoryProof)));
      if (malformed) {
        throw new SelfsameContinuityError('Stored session anchor is malformed; refusing to resume or replace it');
      }
      if (String(stored.agentId) !== this.agentId) {
        throw new SelfsameContinuityError('Stored session belongs to a different agent', {
          expectedAgentId: this.agentId,
          storedAgentId: stored.agentId,
        });
      }
      let resumed = false;
      try { resumed = await this.resumeSession(stored.sessionId, structuredClone(stored)); } catch (error) {
        throw new SelfsameContinuityError('Existing session could not be resumed; refusing silent replacement', {
          sessionId: stored.sessionId,
          cause: error.message,
        });
      }
      if (!resumed) {
        throw new SelfsameContinuityError('Existing session was rejected; refusing silent replacement', {
          sessionId: stored.sessionId,
        });
      }
      this.state = stored;
      return stored;
    }
    if (!allowCreate) {
      throw new SelfsameContinuityError('No session exists and creation was not explicitly approved');
    }
    let creationSafe = false;
    try { creationSafe = await this.canCreateSession(); } catch (error) {
      throw new SelfsameContinuityError('Session creation authority could not be verified', {
        cause: error.message,
      });
    }
    if (!creationSafe) {
      throw new SelfsameContinuityError(
        'Session anchor is missing while durable authority still exists; refusing a silent replacement',
      );
    }
    const sessionId = String(await this.createSession()).trim();
    if (!sessionId) throw new Error('createSession returned an empty session id');
    const createdAt = String(this.clock()).trim();
    if (!createdAt) throw new Error('clock returned an empty session creation timestamp');
    const created = {
      schemaVersion: 1,
      agentId: this.agentId,
      sessionId,
      createdAt,
    };
    atomicWriteJson(this.stateFile, created);
    this.state = created;
    return created;
  }

  checkpoint(memoryProof) {
    if (!this.state) throw new SelfsameContinuityError('Cannot checkpoint a closed session');
    const next = {
      ...this.state,
      memoryProof: structuredClone(memoryProof),
      checkpointedAt: this.clock(),
    };
    atomicWriteJson(this.stateFile, next);
    this.state = next;
    return next;
  }
}

module.exports = { SelfsameContinuityError, SelfsameSession, atomicWriteJson };
