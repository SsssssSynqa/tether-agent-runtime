// SPDX-License-Identifier: Apache-2.0
export async function getJson(path, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(path, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.detail || payload.error || `HTTP ${response.status}`)
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload
}

export async function loadConsole(fetchImpl = globalThis.fetch) {
  // Relative paths so the Console can be mounted at any sub-path
  // (e.g. embedded under another local dashboard), not only at "/".
  const paths = [
    'api/status',
    'api/cards',
    'api/semantic',
    'api/context/current',
    'api/sources',
    'api/integrity',
  ]
  const [status, cards, semantic, context, sources, integrity] = await Promise.all(
    paths.map((path) => getJson(path, fetchImpl)),
  )
  return { status, cards, semantic, context, sources, integrity }
}
