// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'

import { getJson, loadConsole } from '../src/api.js'
import {
  formatCount,
  normalizeLocale,
  preferredLocale,
  statusLabel,
  t,
  translationKeySets,
} from '../src/i18n.js'
import {
  buildMonthCalendar,
  calendarMonths,
  cardsForLayer,
  contextBlocks,
  currentMonthKey,
  monthKeyForPeriod,
  recordIdentity,
  resolveCalendarSelection,
  statusTone,
} from '../src/model.js'
import {
  appMarkup,
  calendarMarkup,
  errorMarkup,
  escapeHtml,
  formatPeriodLabel,
} from '../src/view.js'

function consoleData(cards = []) {
  return {
    status: {
      counts: {},
      integrity: { healthy: true },
      configured: {},
      embedding: {
        enabled: true,
        indexed_documents: 2,
        total_documents: 3,
        missing_documents: 1,
        stored_vectors: 2,
      },
    },
    cards: { items: cards },
    semantic: {
      counts: {}, claims: [], events: [], projections: [], reviews: [], queue: [], vectors: [],
    },
    context: { blocks: [] },
    sources: { count: 0, items: [] },
    integrity: { healthy: true, issue_count: 0, issues: {} },
  }
}

test('card layers remain separate and newest first', () => {
  const cards = [
    { id: 'day:old', layer: 'day', period_key: '2026-01-01' },
    { id: 'week:one', layer: 'week', period_key: '2025-12-29' },
    { id: 'day:new', layer: 'day', period_key: '2026-01-02' },
  ]
  assert.deepEqual(cardsForLayer(cards, 'day').map((item) => item.id), ['day:new', 'day:old'])
})

test('locale preference is browser-aware, normalized, and overridden by a saved choice', () => {
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-CN')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('fr-FR'), null)
  assert.equal(preferredLocale({ languages: ['fr-FR', 'zh-TW'] }), 'zh-CN')
  assert.equal(preferredLocale({ stored: 'en-GB', languages: ['zh-CN'] }), 'en')
  assert.equal(preferredLocale({ stored: 'fr', languages: ['de'] }), 'en')
})

test('English and Simplified Chinese expose the same translation contract', () => {
  const keys = translationKeySets()
  assert.deepEqual(keys.en, keys['zh-CN'])
  assert.equal(t('zh-CN', 'nav.cards'), '记忆卡')
  assert.equal(t('en', 'calendar.selected', { date: 'Jan 2', count: '1 day card' }), 'Jan 2 · 1 day card')
  assert.equal(formatCount('zh-CN', 2, 'fold'), '2 次折叠')
  assert.equal(statusLabel('zh-CN', 'human-review'), '人工复核')
  assert.equal(statusLabel('zh-CN', 'complete'), '已完成')
  assert.equal(statusLabel('zh-CN', 'needs_human_review'), '需要人工复核')
  assert.equal(statusLabel('zh-CN', 'partial_review_pending'), '部分复核排队中')
  assert.equal(statusLabel('en', 'custom-state'), 'custom-state')
})

test('calendar models use period_key directly, keep layers separate, and start on Monday', () => {
  const cards = [
    { id: 'day:jan-5:a', layer: 'day', period_key: '2026-01-05' },
    { id: 'day:jan-5:b', layer: 'day', period_key: '2026-01-05' },
    { id: 'day:jan-31', layer: 'day', period_key: '2026-01-31' },
    { id: 'day:feb-2', layer: 'day', period_key: '2026-02-02' },
    { id: 'week:jan-26', layer: 'week', period_key: '2026-01-26' },
    { id: 'fold:jan-5', layer: 'fold', period_key: '2026-01-05' },
    { id: 'invalid', layer: 'day', period_key: '2026-02-29' },
  ]
  assert.deepEqual(calendarMonths(cards, 'day'), ['2026-01', '2026-02'])
  assert.deepEqual(calendarMonths(cards, 'week'), ['2026-01'])
  assert.equal(monthKeyForPeriod('2026-01-05'), '2026-01')
  assert.equal(monthKeyForPeriod('2026-02-29'), null)

  const calendar = buildMonthCalendar('2026-01', cards, 'day', '2026-01-05')
  assert.equal(calendar.cells.length, 35)
  assert.deepEqual(calendar.cells.slice(0, 3).map((cell) => cell.kind), ['blank', 'blank', 'blank'])
  assert.equal(calendar.cells[3].periodKey, '2026-01-01')
  assert.equal(calendar.cells.find((cell) => cell.periodKey === '2026-01-05').recordCount, 2)
  assert.equal(calendar.cells.find((cell) => cell.periodKey === '2026-01-05').selected, true)
  assert.equal(calendar.recordCount, 3)
})

test('calendar selection defaults within the active data month and preserves exact-period records', () => {
  const cards = [
    { id: 'one', layer: 'day', period_key: '2026-01-02', time: '08:00' },
    { id: 'two', layer: 'day', period_key: '2026-01-02', time: '09:00' },
    { id: 'three', layer: 'day', period_key: '2026-01-29' },
    { id: 'four', layer: 'day', period_key: '2026-02-03' },
  ]
  const january = resolveCalendarSelection({
    cards,
    layer: 'day',
    activeMonth: '2026-01',
    selectedPeriod: '2026-01-02',
    currentMonth: '2026-01',
  })
  assert.equal(january.activeMonth, '2026-01')
  assert.equal(january.selectedPeriod, '2026-01-02')
  assert.deepEqual(january.records.map((item) => item.id), ['two', 'one'])
  assert.equal(january.shortcutMonth, '2026-01')
  assert.equal(january.shortcutIsCurrent, true)

  const fallback = resolveCalendarSelection({ cards, layer: 'day', activeMonth: '2026-01' })
  assert.equal(fallback.selectedPeriod, '2026-01-29')
  assert.deepEqual(fallback.records.map((item) => item.id), ['three'])
  assert.equal(currentMonthKey('2026-02-28T23:30:00-08:00'), '2026-03')
})

test('calendar markup localizes navigation while keeping exact week periods', () => {
  const cards = [
    { id: 'week:a', layer: 'week', period_key: '2025-12-29' },
    { id: 'week:b', layer: 'week', period_key: '2025-12-29' },
  ]
  const state = resolveCalendarSelection({
    cards,
    layer: 'week',
    activeMonth: '2025-12',
    currentMonth: '2025-12',
  })
  const html = calendarMarkup(state, 'zh-CN')
  assert.match(html, /周一/)
  assert.match(html, /本月/)
  assert.match(html, /data-calendar-period="2025-12-29"/)
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /<small>2<\/small>/)
  assert.match(formatPeriodLabel('zh-CN', '2025-12-29', 'week'), /2025.*12.*29.*2026.*1.*4/)
})

test('semantic record identity follows each journal contract', () => {
  assert.equal(recordIdentity({ claimId: 'claim:one', content: 'text' }, 'claims'), 'claim:one')
  assert.equal(recordIdentity({ eventId: 'event:one', title: 'Title' }, 'events'), 'event:one')
  assert.equal(recordIdentity({ packetId: 'packet:one' }, 'reviews'), 'packet:one')
  assert.equal(recordIdentity({ packetId: 'packet:queued', status: 'retry' }, 'queue'), 'packet:queued')
  assert.equal(recordIdentity({ recordId: 'claim:one', title: 'Claim vector' }, 'vectors'), 'claim:one')
})

test('context blocks never infer content when the manifest is empty', () => {
  assert.deepEqual(contextBlocks({}), [])
  assert.deepEqual(contextBlocks({ blocks: [{ id: 'one' }] }), [{ id: 'one' }])
})

test('integrity changes the overview tone', () => {
  assert.equal(statusTone({ integrity: { healthy: true }, configured: {} }), 'healthy')
  assert.equal(statusTone({ integrity: { healthy: false }, configured: {} }), 'attention')
  assert.equal(statusTone({ integrity: { healthy: true }, configured: { cards: { exists: false } } }), 'attention')
  assert.equal(statusTone({ integrity: { healthy: true }, configured: {}, counts: { queue_retry: 1 } }), 'attention')
  assert.equal(statusTone({ integrity: { healthy: true }, configured: {}, embedding: { enabled: true, missing_documents: 1 } }), 'attention')
  assert.equal(statusTone({ integrity: { healthy: true }, configured: {}, embedding: { enabled: false, missing_documents: 3 } }), 'healthy')
})

test('HTML rendering escapes memory and error content', () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;')
  assert.doesNotMatch(errorMarkup(new Error('<img src=x>')), /<img src=x>/)
  const data = consoleData([
    { id: 'day:one', layer: 'day', period_key: '2026-01-01', title: '<script>x</script>', content: '<b>memory</b>' },
  ])
  const html = appMarkup(data, { page: 'cards', cardLayer: 'day', semanticKind: 'claims', selectedCard: null })
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.match(html, /&lt;b&gt;memory&lt;\/b&gt;/)
})

test('app UI switches languages without translating or corrupting raw memory', () => {
  const data = consoleData([
    {
      id: 'day:raw',
      layer: 'day',
      period_key: '2026-01-02',
      title: 'Original title',
      content: 'Memory that stays. 原始内容。',
      status: 'completed',
    },
  ])
  const baseState = {
    page: 'cards', cardLayer: 'day', cardMonths: {}, cardPeriods: {}, semanticKind: 'claims', selectedCard: null,
  }
  const english = appMarkup(data, { ...baseState, locale: 'en' })
  const chinese = appMarkup(data, { ...baseState, cardMonths: {}, cardPeriods: {}, locale: 'zh-CN' })
  assert.match(english, />Cards &amp; folds</)
  assert.match(chinese, />卡片与折叠</)
  assert.match(english, /Memory that stays\. 原始内容。/)
  assert.match(chinese, /Memory that stays\. 原始内容。/)
  assert.doesNotMatch(english, />NaN</)
  assert.doesNotMatch(chinese, />NaN</)
})

test('overview renders vector ratios as display text instead of coercing them to NaN', () => {
  const html = appMarkup(consoleData(), {
    page: 'overview', locale: 'en', cardLayer: 'day', cardMonths: {}, cardPeriods: {}, semanticKind: 'claims', selectedCard: null,
  })
  assert.match(html, /<strong>2 \/ 3<\/strong>/)
  assert.doesNotMatch(html, /NaN/)
})

test('API helper carries fail-closed payloads', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'memory_store_corrupt', detail: 'claims.jsonl:2' }),
  })
  await assert.rejects(() => getJson('api/semantic', fetchImpl), (error) => {
    assert.equal(error.status, 503)
    assert.equal(error.payload.error, 'memory_store_corrupt')
    return true
  })
})

test('console load requests every independent evidence view', async () => {
  const seen = []
  const fetchImpl = async (path) => {
    seen.push(path)
    return { ok: true, status: 200, json: async () => ({ path }) }
  }
  const loaded = await loadConsole(fetchImpl)
  assert.deepEqual(seen, [
    'api/status', 'api/cards', 'api/semantic',
    'api/context/current', 'api/sources', 'api/integrity',
  ])
  assert.equal(loaded.context.path, 'api/context/current')
})
