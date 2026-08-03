'use strict';

const { normalizeMemoryPolicy } = require('./memory-policy.js');
const {
  cardHasNormalizedAddressPolicy,
} = require('./memory-card-address.js');
const {
  addDays,
  operationalDayKey,
  weekKeyForDay,
} = require('./memory-time.js');

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function aggregateProvenance(items) {
  return {
    trustZones: unique(items.flatMap((item) => item?.provenance?.trustZones || [])).sort(),
    chatIds: unique(items.flatMap((item) => item?.provenance?.chatIds || [])).sort(),
    senderIds: unique(items.flatMap((item) => item?.provenance?.senderIds || [])).sort(),
  };
}

function latestCardMap(cards) {
  const result = new Map();
  for (const card of cards || []) {
    const key = `${card.cardType}:${card.period?.key}`;
    const prior = result.get(key);
    if (!prior || Number(card.version) > Number(prior.version)) result.set(key, card);
  }
  return result;
}

function compileMemoryContext({
  cards = [],
  sources = [],
  knownSourceIds = [],
  now = Date.now(),
  tokenBudget = 60_000,
  reservedTokens = 0,
  estimateTokens = (text) => Math.ceil(String(text || '').length / 2),
  recentWeekCount = 4,
  memoryPolicy = {},
  normalizeLegacyOwnerAddressForContext = (text) => String(text || ''),
} = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const today = operationalDayKey(now, policy.time);
  const currentWeek = weekKeyForDay(today);
  const cardMap = latestCardMap(cards);
  const cardById = new Map((cards || []).filter((card) => card?.id).map((card) => [card.id, card]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const knownSourceIdSet = new Set((knownSourceIds || []).map(String).filter(Boolean));
  const blocks = [];
  const coveredSourceIds = new Set();

  function expandCardSourceIds(sourceIds, seen = new Set()) {
    const expanded = [];
    for (const id of sourceIds || []) {
      if (seen.has(id)) continue;
      const sourceCard = cardById.get(id);
      if (!sourceCard) {
        expanded.push(id);
        continue;
      }
      seen.add(id);
      expanded.push(...expandCardSourceIds(sourceCard.sourceIds || [], seen));
    }
    return unique(expanded);
  }

  function addCardBlock(label, card) {
    if (!card) return false;
    const expandedSourceIds = expandCardSourceIds(card.sourceIds || []);
    blocks.push({
      kind: 'card',
      cardType: card.cardType,
      label,
      id: card.id,
      periodKey: card.period.key,
      directSourceIds: card.sourceIds || [],
      sourceIds: expandedSourceIds,
      // 新卡已逐处完成称谓规范，并把有来源证据的真实引语/命名事件作为
      // 显式例外固化；这里不能再用 legacy 全局替换把永久历史改掉。旧卡没有
      // 该写入契约，继续走保守视图归一，避免把历史昵称重新当成当前称呼。
      text: cardHasNormalizedAddressPolicy(card, { memoryPolicy: policy })
        ? String(card.content || '')
        : normalizeLegacyOwnerAddressForContext(card.content),
      provenance: card.provenance || {},
    });
    for (const id of expandedSourceIds) coveredSourceIds.add(id);
    return true;
  }

  function addSourceFallback(label, selected, period = {}) {
    const uncovered = selected.filter((source) => !coveredSourceIds.has(source.id));
    if (!uncovered.length) return false;
    blocks.push({
      kind: 'source-fallback',
      cardType: period.cardType || null,
      label,
      id: `fallback:${label}`,
      periodKey: period.periodKey || null,
      sourceIds: uncovered.map((source) => source.id),
      text: normalizeLegacyOwnerAddressForContext(
        uncovered.map((source) => source.text).join('\n\n'),
      ),
      provenance: aggregateProvenance(uncovered),
    });
    for (const source of uncovered) coveredSourceIds.add(source.id);
    return true;
  }

  // 最近四个已完成自然周：优先周卡；缺卡就退回该周的日卡，再缺就携带原摘要。
  for (let offset = recentWeekCount; offset >= 1; offset--) {
    const weekKey = addDays(currentWeek, -7 * offset);
    const hasWeekCard = addCardBlock(`周卡 ${weekKey}`, cardMap.get(`week:${weekKey}`));
    if (!hasWeekCard) {
      for (let day = 0; day < 7; day++) {
        const dayKey = addDays(weekKey, day);
        addCardBlock(`日卡 ${dayKey}`, cardMap.get(`day:${dayKey}`));
      }
    }
    // 已有卡后仍检查 raw coverage：迟到来源或卡片生成失败后的新增来源必须原样
    // 补入，不能因为“这个 period 有一张卡”就被 continue 静默漏掉。
    addSourceFallback(
      `${hasWeekCard ? '周卡补遗' : '周缺卡原摘要'} ${weekKey}`,
      sources.filter((source) => weekKeyForDay(source.dayKey) === weekKey),
      { cardType: 'week', periodKey: weekKey },
    );
  }

  // 本周周一到昨天：每日必须无缺口。日卡失败/未生成时退回当天全量来源。
  for (let dayKey = currentWeek; dayKey < today; dayKey = addDays(dayKey, 1)) {
    const hasDayCard = addCardBlock(`本周日卡 ${dayKey}`, cardMap.get(`day:${dayKey}`));
    addSourceFallback(
      `${hasDayCard ? '日卡补遗' : 'card_pending'} ${dayKey}`,
      sources.filter((source) => source.dayKey === dayKey),
      { cardType: 'day', periodKey: dayKey },
    );
  }

  // 当天所有已完成分段摘要全量携带；尚未折叠 round 由 ask() 的 active rounds
  // 原文层继续提供，不能在这里再复制一次。
  // dayKey 落在未来的来源（上游写坏的时间戳）一并并入今天：上面三段循环都
  // 只覆盖 [4 周前的周一, today]，而 _settleDay 只结算 dayKey < today，
  // 它会从上下文和卡片两边同时消失，且因为没进 requiredSourceIds 连 missing
  // 都不会报——是一条完全静默的漏洞。
  const futureDatedSources = sources.filter((source) => source.dayKey > today);
  addSourceFallback(
    `今天分段摘要 ${today}`,
    sources.filter(
      (source) => (source.dayKey === today || source.dayKey > today) && source.kind === 'summary',
    ),
    { cardType: 'day', periodKey: today },
  );

  const body = blocks
    .map((block) => `【${block.label}｜source=${block.sourceIds.join(',')}】\n${block.text}`)
    .join('\n\n');
  const memoryTokens = body ? estimateTokens(body) : 0;
  const totalTokens = memoryTokens + Math.max(0, Number(reservedTokens) || 0);
  const requiredSourceIds = unique(blocks.flatMap((block) => block.sourceIds));
  const archivedRequiredIds = requiredSourceIds.filter(
    (id) => !sourceById.has(id) && knownSourceIdSet.has(id),
  );
  const missingRequiredIds = requiredSourceIds.filter(
    (id) => !sourceById.has(id)
      && !knownSourceIdSet.has(id)
      && !String(id).startsWith('memory-card:'),
  );
  return {
    text: body,
    // 完整正文块只在当轮内存中交给统一 compile manifest；legacy
    // manifest 仍只保存来源与覆盖元数据，避免在两个 journal 里重复正文。
    blocks: blocks.map((block) => ({
      kind: block.kind,
      cardType: block.cardType,
      label: block.label,
      id: block.id,
      periodKey: block.periodKey,
      text: block.text,
      tokenEstimate: estimateTokens(block.text),
      sourceIds: [...block.sourceIds],
      provenance: block.provenance,
    })),
    manifest: {
      schema: 2,
      compiledAt: new Date().toISOString(),
      today,
      currentWeek,
      blockCount: blocks.length,
      blocks: blocks.map((block) => ({
        kind: block.kind,
        cardType: block.cardType,
        label: block.label,
        id: block.id,
        periodKey: block.periodKey,
        directSourceIds: block.directSourceIds || block.sourceIds,
        sourceIds: block.sourceIds,
        tokenEstimate: estimateTokens(block.text),
        provenance: block.provenance,
      })),
      sourceIds: requiredSourceIds,
      archivedRequiredIds,
      missingRequiredIds,
      // 时间戳异常的来源单列，方便一眼看出「有东西的日期是坏的」
      futureDatedSourceIds: futureDatedSources.map((source) => source.id),
      memoryTokens,
      reservedTokens: Math.max(0, Number(reservedTokens) || 0),
      totalTokens,
      tokenBudget,
      overBudget: totalTokens > tokenBudget,
    },
  };
}

module.exports = {
  aggregateProvenance,
  compileMemoryContext,
  latestCardMap,
};
