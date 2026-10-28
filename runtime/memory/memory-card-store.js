'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeMemoryPolicy } = require('./memory-policy.js');
const { addDays } = require('./memory-time.js');
const {
  cardMarkdownPath,
  isCardStaleFromFiles,
  monthDayKeys,
  readCardMarkdown,
  renderCardMarkdown,
  sha256,
  writeCardMarkdown,
} = require('./memory-card-files.js');
const { normalizeGenerationRoutes } = require('./memory-card-generation-route.js');

function appendFsynced(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const fd = fs.openSync(filePath, 'a+', 0o600);
  try {
    // 2026-10-03 审计 S19：上一次追加若只写进半行（ENOSPC/断电），下一条记录会和它拼成
    // 同一行，读的时候整行被当坏行跳过——新记录跟着一起丢。追加前看末尾，缺换行就先补一个。
    const { size } = fs.fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const bytes = Buffer.from(`${prefix}${JSON.stringify(entry)}\n`, 'utf8');
    for (let offset = 0; offset < bytes.length;) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new Error('追加写入未前进');
      offset += count;
    }
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
    this.sourceArchiveEvidenceFile = path.join(this.directory, 'source-archive-evidence.jsonl');
    this.log = log;
    this._assertDirectoryLayoutMatches();
  }

  // 2026-10-09：在桥外临时构造（作废/补写卡的一行脚本）时漏传正式 memoryPolicy，会按默认的英文
  // day-cards/week-cards/month-cards 把卡片文件再铺一份（两个实例各多出三套旧副本）。
  // 目录里已经有另一套名字的日卡目录、却没有这次配置的那个，就当场报错，一个文件都不写。
  _assertDirectoryLayoutMatches() {
    const mine = this.memoryPolicy.files.dayDirectory;
    if (!mine || fs.existsSync(path.join(this.directory, mine))) return;
    const other = ['日卡', 'day-cards'].find((name) => name !== mine && fs.existsSync(path.join(this.directory, name)));
    if (other) {
      throw new Error(`卡片目录 ${this.directory} 用的是「${other}」这套目录名，这次的配置却是「${mine}」——`
        + '多半是构造 MemoryCardManager/MemoryCardStore 时漏传了正式的 memoryPolicy，未写入任何文件');
    }
  }

  humanOverrides() {
    return readJsonl(this.humanOverridesFile)
      .filter((entry) => entry?.type === this.memoryPolicy.records.humanOverrideType);
  }

  archivedSourceIds() {
    return [...new Set(
      readJsonl(this.sourceArchiveEvidenceFile)
        .filter((entry) => entry?.type === 'memory-source-archive-evidence')
        .map((entry) => String(entry.sourceId || ''))
        .filter(Boolean),
    )].sort();
  }

  recordArchivedSourceEvidence({
    sourceId,
    cardIds = [],
    actor = 'system:source-archive-reconciliation',
    reason = 'source-no-longer-in-active-source-view',
  } = {}) {
    const id = String(sourceId || '').trim();
    const evidenceCardIds = [...new Set(cardIds.map(String).filter(Boolean))].sort();
    if (!id.startsWith('memory-source:')) throw new Error('archived source evidence 缺少 sourceId');
    if (!evidenceCardIds.length) throw new Error('archived source evidence 缺少 cardIds');
    if (this.archivedSourceIds().includes(id)) return { duplicate: true, sourceId: id };
    const entry = {
      type: 'memory-source-archive-evidence',
      schema: 1,
      sourceId: id,
      cardIds: evidenceCardIds,
      actor,
      reason,
      createdAt: new Date().toISOString(),
    };
    appendFsynced(this.sourceArchiveEvidenceFile, entry);
    return { duplicate: false, ...entry };
  }

  latestHumanOverride(cardType, periodKey) {
    let latest = null;
    for (const entry of this.humanOverrides()) {
      if (entry.cardType === cardType && entry.periodKey === periodKey) latest = entry;
    }
    return latest;
  }

  isTrackedAutomaticMarkdown(card, markdown) {
    if (!markdown?.revision) return false;
    const automaticActors = new Set([
      this.memoryPolicy.actors.automatic,
      this.memoryPolicy.actors.materialize,
    ]);
    return readJsonl(path.join(this.directory, 'file-revisions.jsonl')).some((entry) => (
      entry?.type === this.memoryPolicy.records.fileRevisionType
      && entry.layer === card.cardType
      && entry.periodKey === card.period.key
      && entry.afterHash === markdown.revision
      && automaticActors.has(entry.actor)
    ));
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
      const desiredCard = humanOverride
        ? { ...card, content: humanOverride.content }
        : card;
      const desiredRevision = sha256(renderCardMarkdown(desiredCard, this.memoryPolicy));
      const markdownMatches = markdown?.revision === desiredRevision;
      const staleAutomaticMarkdown = Boolean(
        markdown
        && !humanOverride
        && !markdownMatches
        && this.isTrackedAutomaticMarkdown(card, markdown),
      );
      let materializationAttempted = false;
      let materializationFailed = false;
      let materializationReason = null;
      if (humanOverride && !markdownMatches) {
        materializationAttempted = true;
        materializationReason = 'reapply-human-override';
        try {
          markdown = writeCardMarkdown({
            directory: this.directory,
            memoryPolicy: this.memoryPolicy,
            card: desiredCard,
            actor: this.memoryPolicy.actors.humanOverride,
            reason: materializationReason,
          });
        } catch (error) {
          markdown = null;
          materializationFailed = true;
          this.log(
            `[memory] 人工覆盖层物化失败 ${card.cardType}:${card.period.key}：${error.message}`,
          );
        }
      } else if (!markdown || staleAutomaticMarkdown) {
        materializationAttempted = true;
        materializationReason = staleAutomaticMarkdown
          ? 'repair-stale-automatic-markdown'
          : 'materialize-jsonl-card';
        try {
          markdown = writeCardMarkdown({
            directory: this.directory,
            memoryPolicy: this.memoryPolicy,
            card: desiredCard,
            actor: this.memoryPolicy.actors.materialize,
            reason: materializationReason,
            onlyIfMissing: !staleAutomaticMarkdown,
          });
        } catch (error) {
          markdown = null;
          materializationFailed = true;
          this.log(`[memory] 卡片 Markdown 补写失败 ${card.cardType}:${card.period.key}：${error.message}`);
        }
      }
      if (materializationAttempted && markdown && !materializationFailed) {
        const pendingCoverage = this.latestCoverage(card.cardType, card.period.key);
        if (
          pendingCoverage?.status === 'materialization_pending'
          && pendingCoverage.cardId === card.id
        ) {
          this.recordCoverage({
            cardType: card.cardType,
            period: card.period,
            sourceIds: card.sourceIds,
            status: 'complete',
            cardId: card.id,
            reason: materializationReason,
          });
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
      } else if (humanOverride || materializationFailed) {
        cards[index] = {
          ...card,
          content: humanOverride?.content ?? card.content,
          fileMaterializationPending: true,
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
    const stale = isCardStaleFromFiles({
      directory: this.directory,
      foldLogDir: this.foldLogDir,
      card,
      memoryPolicy: this.memoryPolicy,
    });
    if (!stale || !['week', 'month'].includes(card?.cardType)) return stale;
    return !this._childrenOnlyRematerialized(card);
  }

  // 2026-10-08：文件时间只是「可能改过」的信号。物化修复（卡片 md 渲染格式变了，
  // 按 jsonl 原卡重写一遍）会刷新下级 md 的时间但内容一字没变——10/8 11:43 一次
  // 修复就让 9 月月卡和 9/14 周卡同时被判过期，上下文退回七张日卡、月卡整张消失。
  // 这里只在下级文件内容确实还是本卡当初取材的那一版时放行；人工改过、重新生成
  // 过、折叠日志变过，照旧算过期。
  _childrenOnlyRematerialized(card) {
    const createdAt = Date.parse(card?.createdAt || '');
    if (!Number.isFinite(createdAt) || !card?.period?.key) return false;
    const changedAfterCard = (filePath) => {
      try { return fs.statSync(filePath).mtimeMs > createdAt + 1000; } catch (_) { return false; }
    };
    const weekDays = (weekKey) => Array.from({ length: 7 }, (_, offset) => addDays(weekKey, offset));
    if (card.cardType === 'week' && this.foldLogDir) {
      if (weekDays(card.period.key).some((dayKey) => changedAfterCard(path.join(this.foldLogDir, `${dayKey}.md`)))) {
        return false;
      }
    }
    const material = (card.cardType === 'week' ? weekDays(card.period.key) : monthDayKeys(card.period.key))
      .map((key) => ['day', key]);
    const rawLatest = new Map();
    for (const entry of readJsonl(this.cardsFile)) {
      if (entry?.type !== 'memory-card') continue;
      const key = `${entry.cardType}:${entry.period?.key}`;
      const prior = rawLatest.get(key);
      if (!prior || Number(entry.version) > Number(prior.version)) rawLatest.set(key, entry);
    }
    const builtFrom = new Set((card.sourceIds || []).map(String));
    for (const [childType, key] of material) {
      if (!changedAfterCard(cardMarkdownPath(this.directory, childType, key, this.memoryPolicy))) continue;
      if (this.latestHumanOverride(childType, key)) return false;
      const child = rawLatest.get(`${childType}:${key}`);
      if (!child || !builtFrom.has(String(child.id))) return false;
      const markdown = readCardMarkdown(this.directory, childType, key, this.memoryPolicy);
      if (!markdown || markdown.content !== String(child.content || '').trim()) return false;
    }
    return true;
  }

  effectiveCards() {
    return this.cards().filter((card) => !this.isCardStale(card));
  }

  // 编译用的卡。手动作废重写（keepUntilReplaced）时，新卡写出来之前继续用被作废的那张——
  // 实测一次作废三张日卡，重写的一个小时里那天退回整天原料，记忆块涨到 15 万。
  // 要不要重写仍按 isCardStale 判断，这里只管「这段时间上下文里放什么」。
  contextCards() {
    const effective = this.effectiveCards();
    const kept = new Set(this.coverageEvents()
      .filter((event) => event.status === 'invalidated' && event.keepUntilReplaced && event.cardId)
      .map((event) => event.cardId));
    if (!kept.size) return effective;
    const covered = new Set(effective.map((card) => `${card.cardType}:${card.period?.key}`));
    const extra = [];
    for (const card of this.cards()) {
      if (!kept.has(card.id) || covered.has(`${card.cardType}:${card.period?.key}`)) continue;
      const latest = this.latestCard(card.cardType, card.period?.key);
      if (latest?.id === card.id) extra.push(card);
    }
    return extra.length ? [...effective, ...extra] : effective;
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
    if (!['day', 'week', 'month'].includes(cardType)) throw new Error(`未知 cardType：${cardType}`);
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
    generationRoutes = [],
    userAddressPolicy = null,
    provenance = {},
    carryover = false,
    policy,
    detailedRef = null,
    // 写手挂了退回单版时记下来，写手回来后这张卡要重写。
    degraded = null,
  }) {
    const text = String(content || '').trim();
    if (!['day', 'week', 'month'].includes(cardType)) throw new Error(`未知 cardType：${cardType}`);
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
      && !(previous.degraded && !degraded)
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
      generationRoutes: normalizeGenerationRoutes(generationRoutes),
      contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      ...(userAddressPolicy && typeof userAddressPolicy === 'object'
        ? { userAddressPolicy: structuredClone(userAddressPolicy) }
        : {}),
      provenance,
      carryover: Boolean(carryover),
      policy: policy || null,
      // 2026-10-08：日卡分两版后，卡本体是简要版，这里指向同一次生成的详细版文件。
      ...(detailedRef && typeof detailedRef === 'object' ? { detailedRef: { ...detailedRef } } : {}),
      ...(degraded && typeof degraded === 'object' ? { degraded: { ...degraded } } : {}),
      createdAt: new Date().toISOString(),
      ...(previous ? { supersedes: previous.id } : {}),
    };
    appendFsynced(this.cardsFile, card);
    let materializationError = null;
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
      materializationError = error;
      card.fileMaterializationPending = true;
      this.log(`[memory] 卡片已进 JSONL，但 Markdown 同步失败 ${card.id}：${error.message}`);
    }
    this.recordCoverage({
      cardType,
      period,
      sourceIds: ids,
      status: materializationError ? 'materialization_pending' : 'complete',
      cardId: card.id,
      error: materializationError,
      reason: materializationError ? 'markdown-sync-failed' : null,
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
    keepUntilReplaced = false,
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
      ...(keepUntilReplaced ? { keepUntilReplaced: true } : {}),
      at: new Date().toISOString(),
    };
    const previous = this.latestCoverage(cardType, period.key);
    if (
      previous
      && previous.status === event.status
      && previous.sourceDigest === event.sourceDigest
      && previous.nextRetryAt === event.nextRetryAt
      && Boolean(previous.keepUntilReplaced) === Boolean(event.keepUntilReplaced)
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
