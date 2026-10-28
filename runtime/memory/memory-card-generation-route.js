'use strict';

function normalizeGenerationRoutes(routes) {
  return (Array.isArray(routes) ? routes : [])
    .map((route) => ({
      station: String(route?.station || route?.provider || '').trim(),
      model: String(route?.model || '').trim(),
    }))
    .filter((route) => route.station && route.model);
}

function describeGenerationRoutes(routes) {
  const names = [...new Set(normalizeGenerationRoutes(routes)
    .map((route) => `${route.station}:${route.model}`))];
  return names.length ? names.join(' + ') : 'unknown';
}

function hasFallbackGenerationRoute(routes) {
  return normalizeGenerationRoutes(routes).some((route) => route.station === 'siliconflow');
}

module.exports = { normalizeGenerationRoutes, describeGenerationRoutes, hasFallbackGenerationRoute };
