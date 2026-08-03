// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'

import { getJson, loadConsole } from '../src/api.js'
import { cardsForLayer, contextBlocks, recordIdentity, statusTone } from '../src/model.js'
import { appMarkup, errorMarkup, escapeHtml } from '../src/view.js'

test('card layers remain separate and newest first', () => {
  const cards = [
    { id: 'day:old', layer: 'day', period_key: '2026-01-01' },
    { id: 'week:one', layer: 'week', period_key: '2025-12-29' },
    { id: 'day:new', layer: 'day', period_key: '2026-01-02' },
  ]
  assert.deepEqual(cardsForLayer(cards, 'day').map((item) => item.id), ['day:new', 'day:old'])
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
  const data = {
    status: { counts: {}, integrity: { healthy: true }, configured: {}, embedding: { enabled: false, stored_vectors: 0 } },
    cards: { items: [{ id: 'day:one', layer: 'day', period_key: '2026-01-01', title: '<script>x</script>', content: '<b>memory</b>' }] },
    semantic: { counts: {}, claims: [], events: [], projections: [], reviews: [], queue: [], vectors: [] },
    context: { blocks: [] },
    sources: { count: 0, items: [] },
    integrity: { healthy: true, issue_count: 0, issues: {} },
  }
  const html = appMarkup(data, { page: 'cards', cardLayer: 'day', semanticKind: 'claims', selectedCard: null })
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.match(html, /&lt;b&gt;memory&lt;\/b&gt;/)
})

test('API helper carries fail-closed payloads', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'memory_store_corrupt', detail: 'claims.jsonl:2' }),
  })
  await assert.rejects(() => getJson('/api/semantic', fetchImpl), (error) => {
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
    '/api/status', '/api/cards', '/api/semantic',
    '/api/context/current', '/api/sources', '/api/integrity',
  ])
  assert.equal(loaded.context.path, '/api/context/current')
})
