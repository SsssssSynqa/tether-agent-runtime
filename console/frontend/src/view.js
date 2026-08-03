// SPDX-License-Identifier: Apache-2.0
import {
  CARD_LAYERS,
  PAGES,
  SEMANTIC_KINDS,
  cardsForLayer,
  contextBlocks,
  recordIdentity,
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

const labels = {
  overview: 'Overview', cards: 'Cards', semantic: 'Semantics',
  context: 'Current context', integrity: 'Sources & integrity',
  day: 'Day cards', week: 'Week cards', fold: 'Folds',
  claims: 'Claims', events: 'Events', projections: 'Projections', reviews: 'Reviews', queue: 'Queue', vectors: 'Vectors',
}

function number(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0))
}

function date(value) {
  if (!value) return 'Not recorded'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleString()
}

function pill(text, tone = '') {
  return `<span class="pill ${escapeHtml(tone)}">${escapeHtml(text)}</span>`
}

function countCard(label, value, note) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${number(value)}</strong><small>${escapeHtml(note)}</small></article>`
}

function vectorCoverageCard(embedding = {}) {
  const enabled = embedding.enabled === true
  const value = enabled
    ? `${number(embedding.indexed_documents)} / ${number(embedding.total_documents)}`
    : 'Off'
  const note = enabled
    ? `${number(embedding.missing_documents)} pending · ${number(embedding.stored_vectors)} stored`
    : `${number(embedding.stored_vectors)} stored vectors`
  return `<article class="metric"><span>Vector coverage</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`
}

function overview(data) {
  const { status, context, integrity } = data
  const counts = status.counts || {}
  const tone = statusTone(status)
  return `<section class="page-grid overview-grid">
    <article class="hero-card">
      <p class="eyebrow">LOCAL-FIRST MEMORY RUNTIME</p>
      <h2>One memory, still attached.</h2>
      <p>Tether Console shows what the agent remembers, where each memory came from, and what actually entered the current context. The API is read-only and never returns host filesystem paths.</p>
      <div class="hero-status">${pill(tone === 'healthy' ? 'Integrity healthy' : 'Review needed', tone)}<span>Compiled ${escapeHtml(date(context.compiled_at))}</span></div>
    </article>
    <div class="metric-grid">
      ${countCard('Day cards', counts.day_cards, 'durable daily layer')}
      ${countCard('Week cards', counts.week_cards, 'longer causal arc')}
      ${countCard('Claims', counts.claims, `${number(counts.supported_claims)} supported`)}
      ${countCard('Events', counts.events, `${number(counts.accepted_events)} accepted`)}
      ${countCard('Projections', counts.projections, `${number(counts.accepted_projections)} active`)}
      ${countCard('Semantic queue', counts.queue_actionable, `${number(counts.queue_retry)} retry · ${number(counts.queue_human_review)} human review`)}
      ${vectorCoverageCard(status.embedding)}
      ${countCard('Integrity issues', integrity.issue_count, integrity.healthy ? 'all references resolve' : 'open the integrity view')}
    </div>
    <article class="manifest-card">
      <div><p class="eyebrow">CURRENT COMPILE</p><h3>${escapeHtml(context.source || 'No manifest')}</h3></div>
      <dl>
        <div><dt>Layout</dt><dd>${escapeHtml(context.context_layout || 'default')}</dd></div>
        <div><dt>Blocks</dt><dd>${number(contextBlocks(context).length)}</dd></div>
        <div><dt>Memory tokens</dt><dd>${number(context.memory_tokens)}</dd></div>
        <div><dt>Budget</dt><dd>${number(context.token_budget)}</dd></div>
      </dl>
    </article>
  </section>`
}

function cardList(data, state) {
  const cards = cardsForLayer(data.cards.items || [], state.cardLayer)
  if (!cards.length) return '<div class="empty"><strong>No records in this layer.</strong><span>The console does not manufacture missing cards.</span></div>'
  const selected = cards.find((item) => item.id === state.selectedCard) || cards[0]
  state.selectedCard = selected.id
  return `<div class="split-view">
    <div class="record-list">${cards.map((item) => `<button class="record-button ${item.id === selected.id ? 'selected' : ''}" data-card-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.period_key)}${item.time ? ` · ${escapeHtml(item.time)}` : ''}</span><strong>${escapeHtml(item.title || item.id)}</strong><small>${escapeHtml(item.excerpt || '')}</small></button>`).join('')}</div>
    <article class="record-detail">
      <div class="detail-head"><div><p class="eyebrow">${escapeHtml(labels[selected.layer] || selected.layer)}</p><h3>${escapeHtml(selected.title || selected.id)}</h3></div>${selected.used_in_latest_compile ? pill('Current load', 'healthy') : ''}</div>
      <div class="record-meta">${pill(selected.status || 'source')}<span>${escapeHtml(selected.source_count ?? 1)} source(s)</span><span>${escapeHtml(date(selected.updated_at))}</span></div>
      <pre class="memory-copy">${escapeHtml(selected.content || '')}</pre>
      <details><summary>Technical record</summary><pre class="json-copy">${escapeHtml(JSON.stringify(selected, null, 2))}</pre></details>
    </article>
  </div>`
}

function cards(data, state) {
  return `<section><header class="page-head"><div><p class="eyebrow">LAYERED MEMORY</p><h2>Cards & folds</h2><p>Human-readable memory remains separate from its compile evidence.</p></div><div class="segmented">${CARD_LAYERS.map((layer) => `<button data-card-layer="${layer}" class="${state.cardLayer === layer ? 'active' : ''}">${labels[layer]}</button>`).join('')}</div></header>${cardList(data, state)}</section>`
}

function recordSummary(record, kind) {
  if (kind === 'claims') return record.content || record.objectLiteral || record.claimId
  if (kind === 'events') return record.title || record.eventId
  if (kind === 'projections') return (record.sentences || []).map((item) => item.text).filter(Boolean).join(' ') || record.title
  if (kind === 'queue') return `${record.queueClass || 'live'} · ${number(record.attempts)} attempt(s)${record.nextRetryAt ? ` · next ${date(record.nextRetryAt)}` : ''}`
  if (kind === 'vectors') return `${record.kind || 'memory'} · ${number(record.dimensions)} dimensions · ${record.providerId || 'provider not recorded'}${record.model ? ` · ${record.model}` : ''}`
  return `${record.status || 'review'} · ${record.packetId || record.reviewId || ''}`
}

function semantic(data, state) {
  const records = semanticItems(data.semantic, state.semanticKind)
  return `<section><header class="page-head"><div><p class="eyebrow">VERIFIABLE MEMORY</p><h2>Semantic records</h2><p>Claims, events, projections, reviews, durable extraction work, and vector metadata remain distinct. Numeric embeddings never leave the local store through this API.</p></div><div class="segmented">${SEMANTIC_KINDS.map((kind) => `<button data-semantic-kind="${kind}" class="${state.semanticKind === kind ? 'active' : ''}">${labels[kind]} <span>${number(kind === 'queue' ? data.semantic.counts?.queue_total : data.semantic.counts?.[kind])}</span></button>`).join('')}</div></header>
  <div class="semantic-list">${records.length ? records.map((record) => `<details class="semantic-record"><summary><span>${escapeHtml(recordIdentity(record, state.semanticKind))}</span>${pill(record.verificationStatus || record.status || 'record')}</summary><p>${escapeHtml(recordSummary(record, state.semanticKind) || '')}</p><pre class="json-copy">${escapeHtml(JSON.stringify(record, null, 2))}</pre></details>`).join('') : '<div class="empty">No semantic records.</div>'}</div></section>`
}

function currentContext(data) {
  const blocks = contextBlocks(data.context)
  return `<section><header class="page-head"><div><p class="eyebrow">THE ACTUAL LOAD</p><h2>Current compiled context</h2><p>This is compile evidence—not a guess based on which cards exist.</p></div>${data.context.over_budget ? pill('Over budget', 'attention') : pill('Within budget', 'healthy')}</header>
  <article class="context-summary"><dl><div><dt>Compiled</dt><dd>${escapeHtml(date(data.context.compiled_at))}</dd></div><div><dt>Source</dt><dd>${escapeHtml(data.context.source || 'none')}</dd></div><div><dt>Layout</dt><dd>${escapeHtml(data.context.context_layout || 'default')}</dd></div><div><dt>Tokens</dt><dd>${number(data.context.memory_tokens)} / ${number(data.context.token_budget)}</dd></div></dl></article>
  <div class="block-list">${blocks.length ? blocks.map((block, index) => `<article class="context-block"><div><span>${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(block.title || block.blockId || block.projectionId || block.id || 'Memory block')}</h3></div><pre class="memory-copy">${escapeHtml(block.text || block.body_markdown || (block.sentences || []).join('\n') || JSON.stringify(block, null, 2))}</pre></article>`).join('') : '<div class="empty"><strong>No compiled snapshot.</strong><span>The runtime has not recorded a current context manifest.</span></div>'}</div></section>`
}

function integrity(data) {
  const issues = data.integrity.issues || {}
  const configured = Object.entries(data.status.configured || {})
  return `<section><header class="page-head"><div><p class="eyebrow">PROVENANCE</p><h2>Sources & integrity</h2><p>Every supported memory should remain traceable to a source, and every semantic reference should resolve.</p></div>${pill(data.integrity.healthy ? 'Healthy' : `${data.integrity.issue_count} issue(s)`, data.integrity.healthy ? 'healthy' : 'attention')}</header>
  <div class="integrity-grid"><article><h3>Configured folders</h3><ul class="check-list">${configured.map(([name, item]) => `<li><span class="check ${item.exists ? 'ok' : 'missing'}"></span><div><strong>${escapeHtml(name.replaceAll('_', ' '))}</strong><small>${escapeHtml(item.alias)}</small></div></li>`).join('')}</ul></article><article><h3>Reference checks</h3><ul class="check-list">${Object.entries(issues).map(([name, values]) => `<li><span class="check ${values.length ? 'missing' : 'ok'}"></span><div><strong>${escapeHtml(name.replaceAll('_', ' '))}</strong><small>${values.length ? escapeHtml(values.join(', ')) : 'No issues'}</small></div></li>`).join('')}</ul></article></div>
  <article class="sources"><div class="section-title"><h3>Known sources</h3><span>${number(data.sources.count)} records</span></div><div class="source-list">${(data.sources.items || []).map((item) => `<div><code>${escapeHtml(item.id)}</code>${pill(item.kind)}<span>${number(item.references?.length)} reference(s)</span>${item.kind === 'evidence' ? `<span>${item.quote_present ? 'quote located' : 'quote missing'}</span>` : ''}</div>`).join('') || '<p class="empty">No source references.</p>'}</div></article></section>`
}

const renderers = { overview, cards, semantic, context: currentContext, integrity }

export function appMarkup(data, state) {
  const page = PAGES.includes(state.page) ? state.page : 'overview'
  return `<div class="shell"><aside><a class="brand" href="#overview" aria-label="Tether overview"><span class="tether-mark"></span><div><strong>Tether</strong><small>Memory Console</small></div></a><nav>${PAGES.map((item) => `<a href="#${item}" class="${page === item ? 'active' : ''}">${labels[item]}</a>`).join('')}</nav><footer><span class="pulse"></span><div><strong>Local & read-only</strong><small>No host paths exposed</small></div></footer></aside><main>${renderers[page](data, state)}</main></div>`
}

export function errorMarkup(error) {
  return `<main class="fatal"><span class="tether-mark"></span><p class="eyebrow">TETHER CONSOLE</p><h1>Memory stayed closed.</h1><p>${escapeHtml(error?.message || 'The local memory store could not be read.')}</p><small>Corrupt journals fail closed instead of being silently skipped.</small></main>`
}
