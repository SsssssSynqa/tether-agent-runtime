// SPDX-License-Identifier: Apache-2.0
/** Generic local-memory selectors shared by Memory Hub and Tether Console. */
export function recordsForLayer(items = [], layer) {
  return items.filter((item) => item?.layer === layer)
}

export function recordsForPeriod(items = [], layer, periodKey) {
  return recordsForLayer(items, layer)
    .filter((item) => item.period_key === periodKey)
    .sort((left, right) => (
      String(right.time || '').localeCompare(String(left.time || ''))
      || String(right.id || '').localeCompare(String(left.id || ''))
    ))
}

export function newestFirst(items = []) {
  return [...items].sort((left, right) => (
    `${right.period_key || ''}${right.time || ''}`.localeCompare(
      `${left.period_key || ''}${left.time || ''}`,
    )
    || String(right.id || '').localeCompare(String(left.id || ''))
  ))
}
