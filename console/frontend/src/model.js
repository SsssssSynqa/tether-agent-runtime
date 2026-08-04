// SPDX-License-Identifier: Apache-2.0
import { newestFirst, recordsForLayer, recordsForPeriod } from './tether-memory-policy.js'

export const PAGES = ['overview', 'cards', 'semantic', 'context', 'integrity']
export const CARD_LAYERS = ['day', 'week', 'fold']
export const SEMANTIC_KINDS = ['claims', 'events', 'projections', 'reviews', 'queue', 'vectors']

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/

export function cardsForLayer(cards = [], layer = 'day') {
  return newestFirst(recordsForLayer(cards, layer))
}

function parseMonthKey(monthKey) {
  const match = String(monthKey || '').match(MONTH_KEY_RE)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return { year, month }
}

function validPeriodKey(periodKey) {
  const match = String(periodKey || '').match(DATE_KEY_RE)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === periodKey
}

export function monthKeyForPeriod(periodKey) {
  return validPeriodKey(periodKey) ? String(periodKey).slice(0, 7) : null
}

export function calendarMonths(cards = [], layer = 'day') {
  return [...new Set(cardsForLayer(cards, layer)
    .map((item) => monthKeyForPeriod(item.period_key))
    .filter(Boolean))].sort()
}

export function latestPeriodInMonth(cards = [], layer = 'day', monthKey = null) {
  return cardsForLayer(cards, layer)
    .map((item) => String(item.period_key || ''))
    .filter((periodKey) => validPeriodKey(periodKey))
    .filter((periodKey) => !monthKey || monthKeyForPeriod(periodKey) === monthKey)
    .sort()
    .at(-1) || null
}

export function buildMonthCalendar(monthKey, cards = [], layer = 'day', selectedPeriod = null) {
  const parsed = parseMonthKey(monthKey)
  if (!parsed) return { monthKey: null, year: null, month: null, layer, cells: [], recordCount: 0 }
  const countByPeriod = new Map()
  for (const card of recordsForLayer(cards, layer)) {
    const periodKey = String(card.period_key || '')
    if (monthKeyForPeriod(periodKey) !== monthKey) continue
    countByPeriod.set(periodKey, (countByPeriod.get(periodKey) || 0) + 1)
  }
  const firstDay = new Date(Date.UTC(parsed.year, parsed.month - 1, 1))
  const leadingBlanks = (firstDay.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate()
  const cells = Array.from({ length: leadingBlanks }, (_, index) => ({
    kind: 'blank', key: `before-${index}`,
  }))
  for (let day = 1; day <= daysInMonth; day += 1) {
    const periodKey = `${monthKey}-${String(day).padStart(2, '0')}`
    const recordCount = countByPeriod.get(periodKey) || 0
    cells.push({
      kind: 'day',
      key: periodKey,
      day,
      periodKey,
      recordCount,
      hasRecords: recordCount > 0,
      selected: periodKey === selectedPeriod,
    })
  }
  while (cells.length % 7) cells.push({ kind: 'blank', key: `after-${cells.length}` })
  return {
    monthKey,
    year: parsed.year,
    month: parsed.month,
    layer,
    cells,
    recordCount: [...countByPeriod.values()].reduce((sum, count) => sum + count, 0),
  }
}

export function currentMonthKey(now = new Date()) {
  const parsed = now instanceof Date ? now : new Date(now)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 7)
}

export function resolveCalendarSelection({
  cards = [],
  layer = 'day',
  activeMonth = null,
  selectedPeriod = null,
  currentMonth = currentMonthKey(),
} = {}) {
  const months = calendarMonths(cards, layer)
  if (!months.length) {
    return {
      months,
      activeMonth: null,
      selectedPeriod: null,
      records: [],
      calendar: null,
      shortcutMonth: null,
      shortcutIsCurrent: false,
    }
  }
  const effectiveMonth = months.includes(activeMonth) ? activeMonth : months.at(-1)
  const selectedIsAvailable = monthKeyForPeriod(selectedPeriod) === effectiveMonth
    && recordsForPeriod(cards, layer, selectedPeriod).length > 0
  const effectivePeriod = selectedIsAvailable
    ? selectedPeriod
    : latestPeriodInMonth(cards, layer, effectiveMonth)
  const shortcutIsCurrent = Boolean(currentMonth && months.includes(currentMonth))
  return {
    months,
    activeMonth: effectiveMonth,
    selectedPeriod: effectivePeriod,
    records: recordsForPeriod(cards, layer, effectivePeriod),
    calendar: buildMonthCalendar(effectiveMonth, cards, layer, effectivePeriod),
    shortcutMonth: shortcutIsCurrent ? currentMonth : months.at(-1),
    shortcutIsCurrent,
  }
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
