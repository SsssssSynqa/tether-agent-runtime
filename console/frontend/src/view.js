// SPDX-License-Identifier: Apache-2.0
import {
  formatCount,
  formatDateTime,
  formatNumber,
  normalizeLocale,
  statusLabel,
  t,
} from './i18n.js'
import {
  CARD_LAYERS,
  PAGES,
  SEMANTIC_KINDS,
  contextBlocks,
  recordIdentity,
  resolveCalendarSelection,
  semanticItems,
  statusTone,
} from './model.js'

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const weekdays = {
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  'zh-CN': ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
}

function localeOf(stateOrLocale = 'en') {
  const value = typeof stateOrLocale === 'string' ? stateOrLocale : stateOrLocale?.locale
  return normalizeLocale(value) || 'en'
}

function translatedName(locale, prefix, value) {
  const key = `${prefix}.${value}`
  const translated = t(locale, key)
  return translated === key ? String(value || '').replaceAll('_', ' ') : translated
}

function date(locale, value) {
  return formatDateTime(locale, value)
}

function pill(text, tone = '') {
  return `<span class="pill ${escapeHtml(tone)}">${escapeHtml(text)}</span>`
}

function metricCard(label, value, note) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`
}

function countCard(locale, label, value, note) {
  return metricCard(label, formatNumber(locale, value), note)
}

function dateKeyParts(periodKey) {
  const match = String(periodKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null
}

function dateFromParts(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
}

function formatDateKey(locale, periodKey) {
  const parts = dateKeyParts(periodKey)
  if (!parts) return String(periodKey || t(locale, 'common.notRecorded'))
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateFromParts(parts))
}

export function formatPeriodLabel(locale, periodKey, layer = 'day') {
  const activeLocale = localeOf(locale)
  const start = dateKeyParts(periodKey)
  if (!start || layer !== 'week') return formatDateKey(activeLocale, periodKey)
  const end = new Date(dateFromParts(start).getTime() + (6 * 24 * 60 * 60 * 1000))
  return `${formatDateKey(activeLocale, periodKey)} – ${new Intl.DateTimeFormat(activeLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(end)}`
}

function formatMonth(locale, calendar) {
  if (!calendar?.year || !calendar?.month) return calendar?.monthKey || ''
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(calendar.year, calendar.month - 1, 1)))
}

function vectorCoverageCard(locale, embedding = {}) {
  const enabled = embedding.enabled === true
  const value = enabled
    ? `${formatNumber(locale, embedding.indexed_documents)} / ${formatNumber(locale, embedding.total_documents)}`
    : t(locale, 'metric.off')
  const note = enabled
    ? t(locale, 'metric.vectorPending', {
        pending: formatNumber(locale, embedding.missing_documents),
        stored: formatNumber(locale, embedding.stored_vectors),
      })
    : t(locale, 'metric.storedVectors', { count: formatNumber(locale, embedding.stored_vectors) })
  return metricCard(t(locale, 'metric.vectorCoverage'), value, note)
}

function overview(data, state) {
  const locale = localeOf(state)
  const { status, context, integrity } = data
  const counts = status.counts || {}
  const tone = statusTone(status)
  return `<section class="page-grid overview-grid">
    <article class="hero-card">
      <p class="eyebrow">${escapeHtml(t(locale, 'overview.eyebrow'))}</p>
      <h2>${escapeHtml(t(locale, 'overview.title'))}</h2>
      <p>${escapeHtml(t(locale, 'overview.description'))}</p>
      <div class="hero-status">${pill(t(locale, tone === 'healthy' ? 'overview.integrityHealthy' : 'overview.reviewNeeded'), tone)}<span>${escapeHtml(t(locale, 'overview.compiled', { date: date(locale, context.compiled_at) }))}</span></div>
    </article>
    <div class="metric-grid">
      ${countCard(locale, t(locale, 'metric.dayCards'), counts.day_cards, t(locale, 'metric.dayCardsNote'))}
      ${countCard(locale, t(locale, 'metric.weekCards'), counts.week_cards, t(locale, 'metric.weekCardsNote'))}
      ${countCard(locale, t(locale, 'metric.claims'), counts.claims, t(locale, 'metric.supported', { count: formatNumber(locale, counts.supported_claims) }))}
      ${countCard(locale, t(locale, 'metric.events'), counts.events, t(locale, 'metric.accepted', { count: formatNumber(locale, counts.accepted_events) }))}
      ${countCard(locale, t(locale, 'metric.projections'), counts.projections, t(locale, 'metric.active', { count: formatNumber(locale, counts.accepted_projections) }))}
      ${countCard(locale, t(locale, 'metric.semanticQueue'), counts.queue_actionable, t(locale, 'metric.queueNote', { retry: formatNumber(locale, counts.queue_retry), review: formatNumber(locale, counts.queue_human_review) }))}
      ${vectorCoverageCard(locale, status.embedding)}
      ${countCard(locale, t(locale, 'metric.integrityIssues'), integrity.issue_count, integrity.healthy ? t(locale, 'metric.referencesResolve') : t(locale, 'metric.openIntegrity'))}
    </div>
    <article class="manifest-card">
      <div><p class="eyebrow">${escapeHtml(t(locale, 'compile.eyebrow'))}</p><h3>${escapeHtml(context.source || t(locale, 'compile.noManifest'))}</h3></div>
      <dl>
        <div><dt>${escapeHtml(t(locale, 'compile.layout'))}</dt><dd>${escapeHtml(context.context_layout || t(locale, 'common.default'))}</dd></div>
        <div><dt>${escapeHtml(t(locale, 'compile.blocks'))}</dt><dd>${formatNumber(locale, contextBlocks(context).length)}</dd></div>
        <div><dt>${escapeHtml(t(locale, 'compile.memoryTokens'))}</dt><dd>${formatNumber(locale, context.memory_tokens)}</dd></div>
        <div><dt>${escapeHtml(t(locale, 'compile.budget'))}</dt><dd>${formatNumber(locale, context.token_budget)}</dd></div>
      </dl>
    </article>
  </section>`
}

function calendarCount(locale, layer, count) {
  return count ? formatCount(locale, count, layer) : t(locale, 'calendar.noRecords')
}

function calendarCellMarkup(cell, locale, layer) {
  if (cell.kind === 'blank') {
    return `<span class="calendar-blank" role="gridcell" aria-hidden="true"></span>`
  }
  const dateLabel = formatDateKey(locale, cell.periodKey)
  const countLabel = calendarCount(locale, layer, cell.recordCount)
  return `<button
    class="calendar-day ${cell.hasRecords ? 'has-records' : ''} ${cell.selected ? 'selected' : ''}"
    data-calendar-period="${escapeHtml(cell.periodKey)}"
    role="gridcell"
    aria-label="${escapeHtml(t(locale, 'calendar.dateLabel', { date: dateLabel, count: countLabel }))}"
    aria-pressed="${cell.selected ? 'true' : 'false'}"
    ${cell.hasRecords ? '' : 'disabled'}
  ><span>${cell.day}</span>${cell.hasRecords ? `<small>${formatNumber(locale, cell.recordCount)}</small>` : ''}</button>`
}

export function calendarMarkup(calendarState, locale = 'en') {
  const activeLocale = localeOf(locale)
  const { months = [], calendar, records = [], selectedPeriod } = calendarState || {}
  if (!calendar) {
    return `<div class="calendar-empty">${escapeHtml(t(activeLocale, 'calendar.empty'))}</div>`
  }
  const monthIndex = months.indexOf(calendar.monthKey)
  const previous = monthIndex > 0 ? months[monthIndex - 1] : null
  const next = monthIndex >= 0 && monthIndex < months.length - 1 ? months[monthIndex + 1] : null
  const layerLabel = t(activeLocale, `layer.${calendar.layer}`)
  const shortcutLabel = calendarState.shortcutIsCurrent
    ? t(activeLocale, 'calendar.thisMonth')
    : t(activeLocale, 'calendar.latestMonth')
  const selectedLabel = selectedPeriod
    ? t(activeLocale, 'calendar.selected', {
        date: formatPeriodLabel(activeLocale, selectedPeriod, calendar.layer),
        count: calendarCount(activeLocale, calendar.layer, records.length),
      })
    : t(activeLocale, 'calendar.noRecords')
  return `<section class="memory-calendar" aria-label="${escapeHtml(t(activeLocale, 'calendar.label', { layer: layerLabel }))}">
    <header class="calendar-head">
      <div><p class="eyebrow">${escapeHtml(t(activeLocale, 'calendar.label', { layer: layerLabel }))}</p><h3>${escapeHtml(formatMonth(activeLocale, calendar))}</h3></div>
      <div class="calendar-nav" role="group" aria-label="${escapeHtml(t(activeLocale, 'calendar.navigation'))}">
        <button data-calendar-month="${escapeHtml(previous || '')}" aria-label="${escapeHtml(t(activeLocale, 'calendar.previous'))}" ${previous ? '' : 'disabled'}>←</button>
        <button class="calendar-jump" data-calendar-month="${escapeHtml(calendarState.shortcutMonth || '')}" ${calendarState.shortcutMonth ? '' : 'disabled'}>${escapeHtml(shortcutLabel)}</button>
        <button data-calendar-month="${escapeHtml(next || '')}" aria-label="${escapeHtml(t(activeLocale, 'calendar.next'))}" ${next ? '' : 'disabled'}>→</button>
      </div>
    </header>
    <div class="calendar-grid" role="grid">
      ${weekdays[activeLocale].map((weekday) => `<span class="calendar-weekday" role="columnheader">${escapeHtml(weekday)}</span>`).join('')}
      ${calendar.cells.map((cell) => calendarCellMarkup(cell, activeLocale, calendar.layer)).join('')}
    </div>
    <p class="calendar-selection" aria-live="polite">${escapeHtml(selectedLabel)}</p>
  </section>`
}

function recordList(cards, selected, locale, layer, selectedPeriod) {
  return `<div class="record-list" aria-label="${escapeHtml(formatPeriodLabel(locale, selectedPeriod, layer))}">${cards.map((item) => `<button class="record-button ${item.id === selected.id ? 'selected' : ''}" data-card-id="${escapeHtml(item.id)}" aria-pressed="${item.id === selected.id}"><span>${escapeHtml(formatPeriodLabel(locale, item.period_key, item.layer))}${item.time ? ` · ${escapeHtml(item.time)}` : ''}</span><strong>${escapeHtml(item.title || item.id)}</strong><small>${escapeHtml(item.excerpt || '')}</small></button>`).join('')}</div>`
}

function cardDetail(selected, locale) {
  return `<article class="record-detail">
    <div class="detail-head"><div><p class="eyebrow">${escapeHtml(t(locale, `layer.${selected.layer}`))}</p><h3>${escapeHtml(selected.title || selected.id)}</h3></div>${selected.used_in_latest_compile ? pill(t(locale, 'cards.currentLoad'), 'healthy') : ''}</div>
    <div class="record-meta">${pill(statusLabel(locale, selected.status || 'source'))}<span>${escapeHtml(formatCount(locale, selected.source_count ?? 1, 'source'))}</span><span>${escapeHtml(date(locale, selected.updated_at))}</span></div>
    <pre class="memory-copy">${escapeHtml(selected.content || '')}</pre>
    <details><summary>${escapeHtml(t(locale, 'cards.technicalRecord'))}</summary><pre class="json-copy">${escapeHtml(JSON.stringify(selected, null, 2))}</pre></details>
  </article>`
}

function cards(data, state) {
  const locale = localeOf(state)
  state.cardMonths ||= {}
  state.cardPeriods ||= {}
  const calendarState = resolveCalendarSelection({
    cards: data.cards.items || [],
    layer: state.cardLayer,
    activeMonth: state.cardMonths[state.cardLayer],
    selectedPeriod: state.cardPeriods[state.cardLayer],
  })
  state.cardMonths[state.cardLayer] = calendarState.activeMonth
  state.cardPeriods[state.cardLayer] = calendarState.selectedPeriod
  const layerCards = calendarState.records
  if (!layerCards.length) {
    state.selectedCard = null
  } else if (!layerCards.some((item) => item.id === state.selectedCard)) {
    state.selectedCard = layerCards[0].id
  }
  const selected = layerCards.find((item) => item.id === state.selectedCard) || null
  const body = selected
    ? `<div class="split-view"><div class="card-index">${calendarMarkup(calendarState, locale)}${recordList(layerCards, selected, locale, state.cardLayer, calendarState.selectedPeriod)}</div>${cardDetail(selected, locale)}</div>`
    : `<div class="empty-state-stack">${calendarMarkup(calendarState, locale)}<div class="empty"><strong>${escapeHtml(t(locale, 'cards.noRecords'))}</strong><span>${escapeHtml(t(locale, 'cards.noRecordsNote'))}</span></div></div>`
  return `<section><header class="page-head"><div><p class="eyebrow">${escapeHtml(t(locale, 'cards.eyebrow'))}</p><h2>${escapeHtml(t(locale, 'cards.title'))}</h2><p>${escapeHtml(t(locale, 'cards.description'))}</p></div><div class="segmented">${CARD_LAYERS.map((layer) => `<button data-card-layer="${layer}" aria-pressed="${state.cardLayer === layer}" class="${state.cardLayer === layer ? 'active' : ''}">${escapeHtml(t(locale, `layer.${layer}`))}</button>`).join('')}</div></header>${body}</section>`
}

function recordSummary(record, kind, locale) {
  if (kind === 'claims') return record.content || record.objectLiteral || record.claimId
  if (kind === 'events') return record.title || record.eventId
  if (kind === 'projections') return (record.sentences || []).map((item) => item.text).filter(Boolean).join(' ') || record.title
  if (kind === 'queue') {
    const next = record.nextRetryAt ? ` · ${t(locale, 'semantic.next', { date: date(locale, record.nextRetryAt) })}` : ''
    return `${record.queueClass || t(locale, 'semantic.live')} · ${formatCount(locale, record.attempts, 'attempt')}${next}`
  }
  if (kind === 'vectors') {
    return `${record.kind || t(locale, 'semantic.memory')} · ${formatCount(locale, record.dimensions, 'dimension')} · ${record.providerId || t(locale, 'semantic.providerMissing')}${record.model ? ` · ${record.model}` : ''}`
  }
  return `${statusLabel(locale, record.status || 'record')} · ${record.packetId || record.reviewId || ''}`
}

function semantic(data, state) {
  const locale = localeOf(state)
  const records = semanticItems(data.semantic, state.semanticKind)
  return `<section><header class="page-head"><div><p class="eyebrow">${escapeHtml(t(locale, 'semantic.eyebrow'))}</p><h2>${escapeHtml(t(locale, 'semantic.title'))}</h2><p>${escapeHtml(t(locale, 'semantic.description'))}</p></div><div class="segmented">${SEMANTIC_KINDS.map((kind) => `<button data-semantic-kind="${kind}" aria-pressed="${state.semanticKind === kind}" class="${state.semanticKind === kind ? 'active' : ''}">${escapeHtml(t(locale, `kind.${kind}`))} <span>${formatNumber(locale, kind === 'queue' ? data.semantic.counts?.queue_total : data.semantic.counts?.[kind])}</span></button>`).join('')}</div></header>
  <div class="semantic-list">${records.length ? records.map((record) => `<details class="semantic-record"><summary><span>${escapeHtml(recordIdentity(record, state.semanticKind))}</span>${pill(statusLabel(locale, record.verificationStatus || record.status || 'record'))}</summary><p>${escapeHtml(recordSummary(record, state.semanticKind, locale) || '')}</p><pre class="json-copy">${escapeHtml(JSON.stringify(record, null, 2))}</pre></details>`).join('') : `<div class="empty">${escapeHtml(t(locale, 'semantic.noRecords'))}</div>`}</div></section>`
}

function currentContext(data, state) {
  const locale = localeOf(state)
  const blocks = contextBlocks(data.context)
  return `<section><header class="page-head"><div><p class="eyebrow">${escapeHtml(t(locale, 'context.eyebrow'))}</p><h2>${escapeHtml(t(locale, 'context.title'))}</h2><p>${escapeHtml(t(locale, 'context.description'))}</p></div>${data.context.over_budget ? pill(t(locale, 'context.overBudget'), 'attention') : pill(t(locale, 'context.withinBudget'), 'healthy')}</header>
  <article class="context-summary"><dl><div><dt>${escapeHtml(t(locale, 'context.compiled'))}</dt><dd>${escapeHtml(date(locale, data.context.compiled_at))}</dd></div><div><dt>${escapeHtml(t(locale, 'context.source'))}</dt><dd>${escapeHtml(data.context.source || t(locale, 'common.none'))}</dd></div><div><dt>${escapeHtml(t(locale, 'context.layout'))}</dt><dd>${escapeHtml(data.context.context_layout || t(locale, 'common.default'))}</dd></div><div><dt>${escapeHtml(t(locale, 'context.tokens'))}</dt><dd>${formatNumber(locale, data.context.memory_tokens)} / ${formatNumber(locale, data.context.token_budget)}</dd></div></dl></article>
  <div class="block-list">${blocks.length ? blocks.map((block, index) => `<article class="context-block"><div><span>${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(block.title || block.blockId || block.projectionId || block.id || t(locale, 'context.memoryBlock'))}</h3></div><pre class="memory-copy">${escapeHtml(block.text || block.body_markdown || (block.sentences || []).join('\n') || JSON.stringify(block, null, 2))}</pre></article>`).join('') : `<div class="empty"><strong>${escapeHtml(t(locale, 'context.noSnapshot'))}</strong><span>${escapeHtml(t(locale, 'context.noSnapshotNote'))}</span></div>`}</div></section>`
}

function integrity(data, state) {
  const locale = localeOf(state)
  const issues = data.integrity.issues || {}
  const configured = Object.entries(data.status.configured || {})
  return `<section><header class="page-head"><div><p class="eyebrow">${escapeHtml(t(locale, 'integrity.eyebrow'))}</p><h2>${escapeHtml(t(locale, 'integrity.title'))}</h2><p>${escapeHtml(t(locale, 'integrity.description'))}</p></div>${pill(data.integrity.healthy ? t(locale, 'integrity.healthy') : t(locale, 'integrity.issues', { count: formatNumber(locale, data.integrity.issue_count) }), data.integrity.healthy ? 'healthy' : 'attention')}</header>
  <div class="integrity-grid"><article><h3>${escapeHtml(t(locale, 'integrity.configuredFolders'))}</h3><ul class="check-list">${configured.map(([name, item]) => `<li><span class="check ${item.exists ? 'ok' : 'missing'}"></span><div><strong>${escapeHtml(translatedName(locale, 'configured', name))}</strong><small>${escapeHtml(item.alias)}</small></div></li>`).join('')}</ul></article><article><h3>${escapeHtml(t(locale, 'integrity.referenceChecks'))}</h3><ul class="check-list">${Object.entries(issues).map(([name, values]) => `<li><span class="check ${values.length ? 'missing' : 'ok'}"></span><div><strong>${escapeHtml(translatedName(locale, 'issue', name))}</strong><small>${values.length ? escapeHtml(values.join(', ')) : escapeHtml(t(locale, 'integrity.noIssues'))}</small></div></li>`).join('')}</ul></article></div>
  <article class="sources"><div class="section-title"><h3>${escapeHtml(t(locale, 'integrity.knownSources'))}</h3><span>${escapeHtml(t(locale, 'integrity.records', { count: formatNumber(locale, data.sources.count) }))}</span></div><div class="source-list">${(data.sources.items || []).map((item) => `<div><code>${escapeHtml(item.id)}</code>${pill(translatedName(locale, 'source', item.kind))}<span>${escapeHtml(formatCount(locale, item.references?.length, 'reference'))}</span>${item.kind === 'evidence' ? `<span>${escapeHtml(item.quote_present ? t(locale, 'integrity.quoteLocated') : t(locale, 'integrity.quoteMissing'))}</span>` : ''}</div>`).join('') || `<p class="empty">${escapeHtml(t(locale, 'integrity.noSources'))}</p>`}</div></article></section>`
}

const renderers = { overview, cards, semantic, context: currentContext, integrity }

function languageSwitch(locale) {
  return `<div class="language-switch" role="group" aria-label="${escapeHtml(t(locale, 'language.label'))}">
    <button data-locale="zh-CN" aria-pressed="${locale === 'zh-CN'}" class="${locale === 'zh-CN' ? 'active' : ''}">中文</button>
    <button data-locale="en" aria-pressed="${locale === 'en'}" class="${locale === 'en' ? 'active' : ''}">EN</button>
  </div>`
}

export function appMarkup(data, state) {
  const locale = localeOf(state)
  const page = PAGES.includes(state.page) ? state.page : 'overview'
  return `<div class="shell"><aside><a class="brand" href="#overview" aria-label="${escapeHtml(t(locale, 'nav.overview'))}"><span class="tether-mark"></span><div><strong>Tether</strong><small>${escapeHtml(t(locale, 'brand.subtitle'))}</small></div></a><nav aria-label="${escapeHtml(t(locale, 'nav.label'))}">${PAGES.map((item) => `<a href="#${item}" class="${page === item ? 'active' : ''}" ${page === item ? 'aria-current="page"' : ''}>${escapeHtml(t(locale, `nav.${item}`))}</a>`).join('')}</nav><div class="aside-actions">${languageSwitch(locale)}</div><footer><span class="pulse"></span><div><strong>${escapeHtml(t(locale, 'footer.local'))}</strong><small>${escapeHtml(t(locale, 'footer.paths'))}</small></div></footer></aside><main>${renderers[page](data, state)}</main></div>`
}

export function loadingMarkup(locale = 'en') {
  return `<p class="boot">${escapeHtml(t(localeOf(locale), 'app.loading'))}</p>`
}

export function errorMarkup(error, locale = 'en') {
  const activeLocale = localeOf(locale)
  return `<main class="fatal"><span class="tether-mark"></span><p class="eyebrow">${escapeHtml(t(activeLocale, 'error.eyebrow'))}</p><h1>${escapeHtml(t(activeLocale, 'error.title'))}</h1><p>${escapeHtml(error?.message || t(activeLocale, 'error.fallback'))}</p><small>${escapeHtml(t(activeLocale, 'error.note'))}</small></main>`
}
