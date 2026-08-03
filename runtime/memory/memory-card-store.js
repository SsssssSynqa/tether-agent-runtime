'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeMemoryPolicy } = require('./memory-policy.js');
const {
  isCardStaleFromFiles,
  readCardMarkdown,
  writeCardMarkdown,
} = require('./memory-card-files.js');

function appendFsynced(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

function readJsonl(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch (_) {}
  }
  return entries;
}

function sourceDigest(sourceIds) {
  return createHash('sha256')
    .update([...new Set((sourceIds || []).map(String))].sort().join('\n'))
    .digest('hex')
    .slice(0, 24);
}

class MemoryCardStore {
  constructor({ directory, foldLogDir = null, memoryPolicy = {}, log = console.log } = {}) {
    if (!directory) throw new Error('MemoryCardStore 缺少 directory');
    this.directory = path.resolve(directory);
    this.foldLogDir = foldLogDir ? path.resolve(foldLogDir) : null;
    this.memoryPolicy = normalizeMemoryPolicy(memoryPolicy);
    this.cardsFile = path.join(this.directory, 'cards.jsonl');
    this.coverageFile = path.join(this.directory, 'coverage.jsonl');
    this.hubCandidatesFile = path.join(this.directory, 'hub-candidates.jsonl');
    this.humanOverridesFile = path.join(this.directory, 'human-overrides.jsonl');
    this.log = log;
  }

  humanOverrides() {
    return readJsonl(this.humanOverridesFile)
      .filter((entry) => entry?.type === this.memoryPolicy.records.humanOverrideType);
  }

  latestHumanOverride(cardType, periodKey) {
    let latest = null;
    for (const entry of this.humanOverrides()) {
      if (entry.cardType === cardType && entry.periodKey === periodKey) latest = entry;
    }
    return latest;
  }

  cards() {
    const cards = readJsonl(this.cardsFile).filter((entry) => entry?.type === 'memory-card');
    const latestIndexes = new Map();
    cards.forEach((card, index) => {
      const key = `${card.cardType}:${card.period?.key}`;
      const priorIndex = latestIndexes.get(key);
      if (priorIndex == null || Number(card.version) > Number(cards[priorIndex].version)) {
        latestIndexes.set(key, index);
      }
    });
    for (const index of latestIndexes.values()) {
      const card = cards[index];
      const humanOverride = this.latestHumanOverride(
        card.cardType,
        card.period.key,
      );
      let markdown = readCardMarkdown(
        this.directory,
        card.cardType,
        card.period.key,
        this.memoryPolicy,
      );
      if (
        humanOverride
        && String(markdown?.content || '').trim() !== String(humanOverride.content || '').trim()
      ) {
        try {
          markdown = writeCardMarkdown({
            directory: this.directory,
            memoryPolicy: this.memoryPolicy,
            card: {
              ...card,
              content: humanOverride.content,
            },
            actor: this.memoryPolicy.actors.humanOverride,
            reason: 'reapply-human-override',
          });
        } catch (error) {
          this.log(
            `[memory] 人工覆盖层物化失败 ${card.cardType}:${card.period.key}：${error.message}`,
          );
        }
      } else if (!markdown) {
        try {
          markdown = writeCardMarkdown({
            directory: this.directory,
            memoryPolicy: this.memoryPolicy,
            card: humanOverride
              ? { ...card, content: humanOverride.content }
              : card,
            actor: this.memoryPolicy.actors.materialize,
            reason: 'materialize-jsonl-card',
            onlyIfMissing: true,
          });
        } catch (error) {
          this.log(`[memory] 卡片 Markdown 补写失败 ${card.cardType}:${card.period.key}：${error.message}`);
        }
      }
      if (markdown) {
        cards[index] = {
          ...card,
          content: humanOverride?.content ?? markdown.content,
          filePath: markdown.filePath,
          fileRevision: markdown.revision,
          fileUpdatedAt: markdown.mtime,
          humanOverride: Boolean(humanOverride),
          humanOverrideId: humanOverride?.overrideId || null,
          humanOverrideAt: humanOverride?.createdAt || null,
          humanOverrideBaseCardId: humanOverride?.baseCardId || null,
        };
      }
    }
    return cards;
  }

  coverageEvents() {
    return readJsonl(this.coverageFile).filter((entry) => entry?.type === 'coverage');
  }

  latestCards(cardType = null) {
    const latest = new Map();
    for (const card of this.cards()) {
      if (cardType && card.cardType !== cardType) continue;
      const key = `${card.cardType}:${card.period?.key}`;
      const prior = latest.get(key);
      if (!prior || Number(card.version) > Number(prior.version)) latest.set(key, card);
    }
    return [...latest.values()].sort((a, b) => String(a.period?.startAt).localeCompare(String(b.period?.startAt)));
  }

  latestCard(cardType, periodKey) {
    return this.latestCards(cardType).find((card) => card.period?.key === periodKey) || null;
  }

  isCardStale(card) {
    const latestCoverage = this.latestCoverage(card?.cardType, card?.period?.key);
    if (latestCoverage?.status === 'invalidated') return true;
    return isCardStaleFromFiles({
      directory: this.directory,
      foldLogDir: this.foldLogDir,
      card,
      memoryPolicy: this.memoryPolicy,
    });
  }

  effectiveCards() {
    return this.cards().filter((card) => !this.isCardStale(card));
  }

  latestEffectiveCard(cardType, periodKey) {
    return this.effectiveCards()
      .filter((card) => card.cardType === cardType && card.period?.key === periodKey)
      .sort((left, right) => Number(right.version) - Number(left.version))[0] || null;
  }

  latestCoverage(cardType, periodKey) {
    let latest = null;
    for (const event of this.coverageEvents()) {
      if (event.cardType === cardType && event.period?.key === periodKey) latest = event;
    }
    return latest;
  }

  appendHumanOverride({
    cardType,
    periodKey,
    content,
    baseCardId = null,
    actor = null,
    reason = 'hub-edit',
  } = {}) {
    const text = String(content || '').trim();
    if (!['day', 'week'].includes(cardType)) throw new Error(`未知 cardType：${cardType}`);
    if (!periodKey || !text) throw new Error('human override 缺少 periodKey/content');
    const createdAt = new Date().toISOString();
    const contentSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const override = {
      type: this.memoryPolicy.records.humanOverrideType,
      schema: 1,
      overrideId: `memory-override:${cardType}:${periodKey}:${contentSha256.slice(0, 16)}:${Date.now()}`,
      cardType,
      periodKey,
      baseCardId,
      content: text,
      contentSha256,
      actor: actor || this.memoryPolicy.actors.humanOverride,
      reason,
      createdAt,
    };
    appendFsynced(this.humanOverridesFile, override);
    return override;
  }

  appendCard({
    cardType,
    period,
    sourceIds,
    content,
    userAddressPolicy = null,
    provenance = {},
    carryover = false,
    policy,
  }) {
    const text = String(content || '').trim();
    if (!['day', 'week'].includes(cardType)) throw new Error(`未知 cardType：${cardType}`);
    if (!period?.key || !period.startAt || !period.endAt) throw new Error('card period 不完整');
    if (!text) throw new Error('拒绝写入空 memory card');
    const ids = [...new Set((sourceIds || []).map(String).filter(Boolean))].sort();
    if (!ids.length) throw new Error('memory card 缺少 sourceIds');
    const previous = this.latestCard(cardType, period.key);
    const digest = sourceDigest(ids);
    if (
      previous?.sourceDigest === digest
      && (previous?.policy || null) === (policy || null)
      && !this.isCardStale(previous)
    ) {
      return { duplicate: true, card: previous };
    }
    const version = Number(previous?.version || 0) + 1;
    const card = {
      type: 'memory-card',
      schema: 1,
      id: `memory-card:${cardType}:${period.key}:v${version}:${digest.slice(0, 8)}`,
      cardType,
      version,
      period,
      sourceIds: ids,
      sourceDigest: digest,
      content: text,
      ...(userAddressPolicy && typeof userAddressPolicy === 'object'
        ? { userAddressPolicy: structuredClone(userAddressPolicy) }
        : {}),
      provenance,
      carryover: Boolean(carryover),
      policy: policy || null,
      createdAt: new Date().toISOString(),
      ...(previous ? { supersedes: previous.id } : {}),
    };
    appendFsynced(this.cardsFile, card);
    try {
      const markdown = writeCardMarkdown({
        directory: this.directory,
        memoryPolicy: this.memoryPolicy,
        card,
        actor: this.memoryPolicy.actors.automatic,
        reason: previous ? 'card-new-version' : 'card-generated',
      });
      card.filePath = markdown.filePath;
      card.fileRevision = markdown.revision;
      card.fileUpdatedAt = markdown.mtime;
    } catch (error) {
      this.log(`[memory] 卡片已进 JSONL，但 Markdown 同步失败 ${card.id}：${error.message}`);
    }
    this.recordCoverage({
      cardType,
      period,
      sourceIds: ids,
      status: 'complete',
      cardId: card.id,
    });
    return { duplicate: false, card };
  }

  recordCoverage({
    cardType,
    period,
    sourceIds,
    status,
    cardId = null,
    error = null,
    nextRetryAt = null,
    reason = null,
  }) {
    const ids = [...new Set((sourceIds || []).map(String).filter(Boolean))].sort();
    const event = {
      type: 'coverage',
      schema: 1,
      cardType,
      period,
      sourceIds: ids,
      sourceDigest: sourceDigest(ids),
      status,
      cardId,
      error: error ? String(error).slice(0, 500) : null,
      nextRetryAt,
      reason,
      at: new Date().toISOString(),
    };
    const previous = this.latestCoverage(cardType, period.key);
    if (
      previous
      && previous.status === event.status
      && previous.sourceDigest === event.sourceDigest
      && previous.nextRetryAt === event.nextRetryAt
    ) return previous;
    appendFsynced(this.coverageFile, event);
    return event;
  }

  uncoveredSourceIds(cardType, periodKey, sourceIds) {
    const covered = new Set(this.latestCard(cardType, periodKey)?.sourceIds || []);
    return [...new Set((sourceIds || []).map(String).filter(Boolean))]
      .filter((id) => !covered.has(id))
      .sort();
  }

  appendHubCandidate(card) {
    if (!card?.id || !card?.content) throw new Error('Hub candidate 缺少 card');
    const existing = new Set(readJsonl(this.hubCandidatesFile).map((entry) => entry.cardId));
    if (existing.has(card.id)) return false;
    appendFsynced(this.hubCandidatesFile, {
      type: 'hub-candidate',
      schema: 1,
      cardId: card.id,
      cardType: card.cardType,
      period: card.period,
      content: card.content,
      userAddressPolicy: card.userAddressPolicy || null,
      sourceIds: card.sourceIds,
      provenance: card.provenance,
      reviewStatus: 'candidate',
      createdAt: new Date().toISOString(),
    });
    return true;
  }
}

module.exports = {
  MemoryCardStore,
  appendFsynced,
  readJsonl,
  sourceDigest,
};
