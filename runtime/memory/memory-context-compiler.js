'use strict';

const { normalizeMemoryPolicy } = require('./memory-policy.js');
const {
  cardHasNormalizedAddressPolicy,
} = require('./memory-card-address.js');
const {
  addDays,
  operationalDayKey,
  weekKeyForDay,
  zonedWallClock,
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
  carriedSourceIds = [],
  memoryPolicy = {},
  normalizeLegacyOwnerAddressForContext = (text) => String(text || ''),
  // (dayKey) => 当天事件卡目录文本；事件卡走独立进程时由程序挂在日卡末尾（2026-10-08）。
  dayEventDirectory = null,
  // { sourceIds, text }：今天临时简要版（2026-10-09）。被它覆盖的今天折叠不再原样带。
  todayBrief = null,
} = {}) {
  const policy = normalizeMemoryPolicy(memoryPolicy);
  const today = operationalDayKey(now, policy.time);
  const currentWeek = weekKeyForDay(today);
  const cardMap = latestCardMap(cards);
  const cardById = new Map((cards || []).filter((card) => card?.id).map((card) => [card.id, card]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const knownSourceIdSet = new Set((knownSourceIds || []).map(String).filter(Boolean));
  const carriedSourceIdSet = new Set((carriedSourceIds || []).map(String).filter(Boolean));
  const blocks = [];
  // active rounds 会在 memory block 后逐轮原样加入 prompt。把它们视为已经覆盖，
  // 防止刚生成的日卡/周卡又把同一批 source 作为摘要重复携带。
  const coveredSourceIds = new Set(carriedSourceIdSet);
  const dedupedCardIds = [];
  const retainedOverlapCardIds = [];

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

  // 日卡按东八区早上换日，「凌晨」可能属于前一张卡：块头写明这张卡管的起止时刻，
  // 让模型分得清「昨晚」是哪个凌晨。
  function periodWindow(card) {
    const fmt = (iso) => {
      const at = new Date(iso);
      if (!iso || Number.isNaN(at.getTime())) return null;
      const local = new Date(at.getTime() + 8 * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${local.getUTCMonth() + 1}/${local.getUTCDate()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
    };
    const from = fmt(card?.period?.startAt), to = fmt(card?.period?.endAt);
    return from && to ? `东八区 ${from} 至 ${to}` : null;
  }

  function addCardBlock(label, card) {
    if (!card) return false;
    const expandedSourceIds = expandCardSourceIds(card.sourceIds || []);
    const overlappingIds = expandedSourceIds.filter((id) => carriedSourceIdSet.has(id));
    const nonCarriedIds = expandedSourceIds.filter((id) => !carriedSourceIdSet.has(id));
    // 卡正文不可按 source 精确切片。只有未被 active tail 携带的来源仍可从原始
    // source 重建、且没有人工覆盖时，才安全跳过整张重复卡并让下方 fallback 只带
    // non-carried 原文。否则保留卡，宁可少量重复也不吞人工修订或归档-only 证据。
    const canRebuildNonCarried = nonCarriedIds.every((id) => sourceById.has(id));
    // 2026-09-02：去重之前先算账。
    //
    // 这段逻辑本意是「卡里有一半内容已经被 active tail 原样带着了，那就别再带一
    // 遍卡，让下面的 fallback 只补没被带的原文」。省 token 是对的方向，但它从来
    // 没有比较过两边到底谁大——而丢掉卡之后，fallback 带的是**原文**，卡是**摘要**。
    //
    // 生产实证（2026-09-02 14:55 东八区那次编译）：
    //   dedupedCardIds: ['memory-card:day:2026-09-01:v1:...']   ← 日卡被整张丢掉
    //   随后 fallback 带上 card_pending 2026-09-01 = **54,207 token** 的原始来源
    // 而那张日卡本身只有几千 token。去重把上下文放大了十几倍，正好和它的目的相反。
    // （标签也在骗人：卡明明在，却打成 card_pending。）
    //
    // 现在只在**真的更省**时才丢卡：把这张卡的体积，和丢掉它之后 fallback 会替
    // 它带的那些原文体积比一比，前者更小就留着卡。
    const cardTokens = estimateTokens(String(card.content || ''));
    const fallbackTokens = nonCarriedIds.reduce((sum, id) => {
      const source = sourceById.get(id);
      return sum + (source ? estimateTokens(String(source.text || '')) : 0);
    }, 0);
    const dedupSaves = fallbackTokens < cardTokens;
    if (overlappingIds.length && canRebuildNonCarried && card.humanOverride !== true && dedupSaves) {
      dedupedCardIds.push(card.id);
      return false;
    }
    if (overlappingIds.length) retainedOverlapCardIds.push(card.id);
    const cardText = cardHasNormalizedAddressPolicy(card, { memoryPolicy: policy })
      ? String(card.content || '')
      : normalizeLegacyOwnerAddressForContext(card.content);
    const directory = card.cardType === 'day' && typeof dayEventDirectory === 'function'
      ? dayEventDirectory(card.period.key)
      : '';
    blocks.push({
      kind: 'card',
      cardType: card.cardType,
      label,
      window: card.cardType === 'day' || card.cardType === 'week' ? periodWindow(card) : null,
      id: card.id,
      periodKey: card.period.key,
      directSourceIds: card.sourceIds || [],
      sourceIds: expandedSourceIds,
      // 新卡已逐处完成称谓规范，并把有来源证据的真实引语/命名事件作为
      // 显式例外固化；这里不能再用 legacy 全局替换把永久历史改掉。旧卡没有
      // 该写入契约，继续走保守视图归一，避免把历史昵称重新当成当前称呼。
      text: directory ? `${cardText}\n\n${directory}` : cardText,
      provenance: card.provenance || {},
    });
    for (const id of expandedSourceIds) coveredSourceIds.add(id);
    return true;
  }

  function addSourceFallback(label, selected, period = {}) {
    const uncovered = selected.filter((source) => !coveredSourceIds.has(source.id));
    if (!uncovered.length) return false;
    // A fold is intentionally mirrored in summaryHistory and the dated fold
    // diary. Their timestamps/IDs can differ by seconds even though the text is
    // byte-for-byte identical, so source-ID dedupe cannot catch the mirror.
    // Keep every source ID/provenance for coverage, but render an exact body
    // once. Different or merely similar summaries are never merged.
    const rendered = [];
    const seenText = new Set();
    const dedupedExactSourceIds = [];
    for (const source of uncovered) {
      const text = String(source.text || '');
      if (seenText.has(text)) {
        dedupedExactSourceIds.push(source.id);
        continue;
      }
      seenText.add(text);
      rendered.push(source);
    }
    blocks.push({
      kind: 'source-fallback',
      cardType: period.cardType || null,
      label,
      id: `fallback:${label}`,
      periodKey: period.periodKey || null,
      sourceIds: uncovered.map((source) => source.id),
      dedupedExactSourceIds,
      text: normalizeLegacyOwnerAddressForContext(
        rendered.map((source) => source.text).join('\n\n'),
      ),
      provenance: aggregateProvenance(uncovered),
    });
    for (const source of uncovered) coveredSourceIds.add(source.id);
    return true;
  }

  // 月卡层（PLAN syner-memory-architecture-20260919 §3.3）：最新一张月卡整卡携带，
  // 提供更早历史的压缩视图。窗口内周一归属该月的周不再重复带周卡本体（月卡替掉它们，
  // 预算净变化≈0），raw coverage fallback 照跑——迟到来源仍会原样补入。
  // 只有月卡真的进了 blocks 才允许替周，addCardBlock 因去重丢卡时周卡照常。
  let injectedMonthKey = null;
  {
    let monthCard = null;
    for (const card of cardMap.values()) {
      if (card.cardType !== 'month') continue;
      if (!monthCard || String(card.period.key) > String(monthCard.period.key)) monthCard = card;
    }
    if (monthCard && addCardBlock(`月卡 ${monthCard.period.key}`, monthCard)) {
      injectedMonthKey = String(monthCard.period.key);
    }
  }

  // 最近四个已完成自然周：优先周卡；缺卡就退回该周的日卡，再缺就携带原摘要。
  //
  // 跨月周不能被上个月的月卡吞掉。月卡按「周一所在月」收周卡，
  // 所以 9/28–10/4 这一周整周算进 9 月月卡；原来这里也按周一判断，整周换成月卡，
  // 结果 10/1–10/4 在上下文里只剩 9 月月卡末尾几句，日卡周卡的细节都没带。
  // 现在只有整周七天都落在月卡月份（或更早）时才由月卡替；周日已经跨进下一个
  // 月的周，照常带周卡本体（与月卡末尾有少量重复，宁可重复也不丢当月的细节）。
  // 另外：上周（offset 1）不管跨不跨月，都必带周卡本体，月卡只替更早的周。
  for (let offset = recentWeekCount; offset >= 1; offset--) {
    const weekKey = addDays(currentWeek, -7 * offset);
    const weekEndMonth = addDays(weekKey, 6).slice(0, 7);
    if (offset > 1 && injectedMonthKey && weekKey.slice(0, 7) === injectedMonthKey && weekEndMonth <= injectedMonthKey) {
      addSourceFallback(
        `月卡覆盖周补遗 ${weekKey}`,
        sources.filter((source) => weekKeyForDay(source.dayKey) === weekKey),
        { cardType: 'week', periodKey: weekKey },
      );
      continue;
    }
    const weekCard = cardMap.get(`week:${weekKey}`);
    const hasWeekCard = addCardBlock(`周卡 ${weekKey}`, weekCard);
    if (!hasWeekCard) {
      for (let day = 0; day < 7; day++) {
        const dayKey = addDays(weekKey, day);
        addCardBlock(`日卡 ${dayKey}`, cardMap.get(`day:${dayKey}`));
      }
    }
    // 已有卡后仍检查 raw coverage：迟到来源或卡片生成失败后的新增来源必须原样
    // 补入，不能因为“这个 period 有一张卡”就被 continue 静默漏掉。
    addSourceFallback(
      `${hasWeekCard ? '周卡补遗' : (weekCard ? '周卡去重后原文' : '周缺卡原摘要')} ${weekKey}`,
      sources.filter((source) => weekKeyForDay(source.dayKey) === weekKey),
      { cardType: 'week', periodKey: weekKey },
    );
  }

  // 本周周一到昨天：每日必须无缺口。日卡失败/未生成时退回当天全量来源。
  for (let dayKey = currentWeek; dayKey < today; dayKey = addDays(dayKey, 1)) {
    const dayCard = cardMap.get(`day:${dayKey}`);
    const hasDayCard = addCardBlock(`本周日卡 ${dayKey}`, dayCard);
    // 标签必须说真话：卡不存在 = card_pending；卡存在但被去重丢了 = 日卡去重后原文。
    // 之前两种情况都打成 card_pending，查问题时看不出「卡到底有没有生成」。
    const dayFallbackLabel = hasDayCard
      ? '日卡补遗'
      : (dayCard ? '日卡去重后原文' : 'card_pending');
    addSourceFallback(
      `${dayFallbackLabel} ${dayKey}`,
      sources.filter((source) => source.dayKey === dayKey),
      { cardType: 'day', periodKey: dayKey },
    );
  }

  // 不管什么时候都必带昨天的日卡。周二到周日时昨天已在上面「本周」
  // 循环里；周一时昨天是上周日，上面只带了上周周卡，这里再单独带上它的日卡本体
  // （与周卡有重复，宁可重复）。日卡还没生成就用当天未覆盖的原文补。
  {
    const yesterday = addDays(today, -1);
    if (yesterday < currentWeek) {
      const yesterdayCard = cardMap.get(`day:${yesterday}`);
      const hasYesterdayCard = addCardBlock(`昨天日卡 ${yesterday}`, yesterdayCard);
      addSourceFallback(
        `${hasYesterdayCard ? '日卡补遗' : (yesterdayCard ? '日卡去重后原文' : 'card_pending')} ${yesterday}`,
        sources.filter((source) => source.dayKey === yesterday),
        { cardType: 'day', periodKey: yesterday },
      );
    }
  }

  // 当天所有已完成分段摘要全量携带；尚未折叠 round 由 ask() 的 active rounds
  // 原文层继续提供，不能在这里再复制一次。
  // dayKey 落在未来的来源（上游写坏的时间戳）一并并入今天：上面三段循环都
  // 只覆盖 [4 周前的周一, today]，而 _settleDay 只结算 dayKey < today，
  // 它会从上下文和卡片两边同时消失，且因为没进 requiredSourceIds 连 missing
  // 都不会报——是一条完全静默的漏洞。
  const futureDatedSources = sources.filter((source) => source.dayKey > today);
  if (todayBrief?.text && Array.isArray(todayBrief.sourceIds)) {
    const briefIds = todayBrief.sourceIds.filter((id) => sourceById.has(id) && !coveredSourceIds.has(id));
    if (briefIds.length) {
      blocks.push({
        kind: 'today-brief',
        cardType: 'day',
        label: `今天临时简要版 ${today}`,
        id: `today-brief:${today}`,
        periodKey: today,
        sourceIds: briefIds,
        dedupedExactSourceIds: [],
        text: String(todayBrief.text),
        provenance: aggregateProvenance(briefIds.map((id) => sourceById.get(id))),
      });
      for (const id of briefIds) coveredSourceIds.add(id);
    }
  }
  addSourceFallback(
    `今天分段摘要 ${today}`,
    sources.filter(
      (source) => (source.dayKey === today || source.dayKey > today) && source.kind === 'summary',
    ),
    { cardType: 'day', periodKey: today },
  );

  // 卡头不再抄原料编号。编号是写卡/对账程序用的指纹，代理没有任何工具认它，
  // 一版九张卡就挂了近三万字符的十六进制；编号照旧完整记在 manifest.sourceIds 里。
  const blockText = blocks
    .map((block) => `【${block.label}${block.window ? `（${block.window}）` : ''}】\n${block.text}`)
    .join('\n\n');
  // 2026-10-27：快照只在折叠或卡片任务后重写，换日后到下一次重编之间，下面的「今天」「昨天」
  // 还是旧的那一天（10/27 上午他一直带着「今天=10/26」）。最上面写清这份是几点编的、那时算哪天。
  const compiledWallClock = zonedWallClock(now, policy.time).toISOString();
  const body = blockText
    ? `【这份记忆编于 ${compiledWallClock.slice(5, 10)} ${compiledWallClock.slice(11, 16)}（${policy.time.displayLabel}），`
      + `每天 ${String(policy.time.cutoffHour).padStart(2, '0')}:00 换日，那时算 ${today}；`
      + `下面的「今天」「昨天」都按 ${today} 算】\n\n${blockText}`
    : '';
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
      dedupedExactSourceIds: [...(block.dedupedExactSourceIds || [])],
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
        dedupedExactSourceIds: block.dedupedExactSourceIds || [],
        tokenEstimate: estimateTokens(block.text),
        provenance: block.provenance,
      })),
      sourceIds: requiredSourceIds,
      carriedSourceIds: [...carriedSourceIdSet].sort(),
      dedupedCardIds,
      retainedOverlapCardIds,
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
