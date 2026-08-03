// SPDX-License-Identifier: Apache-2.0
import { newestFirst, recordsForLayer } from './tether-memory-policy.js'

export const PAGES = ['overview', 'cards', 'semantic', 'context', 'integrity']
export const CARD_LAYERS = ['day', 'week', 'fold']
export const SEMANTIC_KINDS = ['claims', 'events', 'projections', 'reviews', 'queue', 'vectors']

export function cardsForLayer(cards = [], layer = 'day') {
  return newestFirst(recordsForLayer(cards, layer))
}

export function semanticItems(data = {}, kind = 'claims') {
  return Array.isArray(data[kind]) ? data[kind] : []
}

export function contextBlocks(context = {}) {
  return Array.isArray(context.blocks) ? context.blocks : []
}

export function recordIdentity(record = {}, kind = '') {
  const fields = {
    claims: ['claimId', 'content'],
    events: ['eventId', 'title'],
    projections: ['projectionId', 'title'],
    reviews: ['reviewId', 'packetId'],
    queue: ['packetId', 'status'],
    vectors: ['recordId', 'title'],
  }[kind] || ['id', 'title']
  return fields.map((field) => record[field]).find(Boolean) || 'Unnamed record'
}

export function statusTone(status = {}) {
  if (status.integrity?.healthy === false) return 'attention'
  if (status.configured && Object.values(status.configured).some((item) => !item.exists)) return 'attention'
  if (Number(status.counts?.queue_retry || 0) > 0 || Number(status.counts?.queue_human_review || 0) > 0) return 'attention'
  if (status.embedding?.enabled && Number(status.embedding?.missing_documents || 0) > 0) return 'attention'
  return 'healthy'
}
