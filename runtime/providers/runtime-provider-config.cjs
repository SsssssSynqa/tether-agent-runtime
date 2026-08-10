'use strict';

// Startup wiring for provider configuration.
//
// This used to be an inline allow-list inside bin/tether.cjs. That shape has a
// failure mode worth naming: a field added to the config schema and honoured by
// the provider module is *silently dropped* here, so unit tests pass, the config
// file reads correctly, and production still runs on stale defaults.
//
// It happened on 2026-08-09. `purposes`, `backgroundTimeoutMs` and `maxAttempts`
// were implemented, validated, documented and unit-tested — and none of them
// reached the running agent. The config said one provider was for background
// work only; the agent answered its owner through that provider anyway, billing
// summarisation credit and speaking with the summarisation model.
//
// Extracted so the wiring itself is testable, and so RUNTIME_PROVIDER_FIELDS can
// be asserted against the fields the provider module actually reads.

const RUNTIME_PROVIDER_FIELDS = Object.freeze([
  'id',
  'label',
  'baseUrl',
  'apiKey',
  'model',
  'foldModel',
  'memoryModel',
  'semanticExtractorModel',
  'semanticVerifierModel',
  'semanticHighRiskModel',
  'imageInput',
  'maxImageParts',
  'embeddingsUrl',
  'embeddingModel',
  'embeddingDimensions',
  'embeddingTimeoutMs',
  'maxTokens',
  'foldMaxTokens',
  'memoryMaxTokens',
  'semanticExtractorMaxTokens',
  'semanticVerifierMaxTokens',
  'semanticHighRiskMaxTokens',
  'headers',
  'timeoutMs',
  'purposes',
  'backgroundTimeoutMs',
  'maxAttempts',
]);

function toRuntimeProviders(configProviders, adapter = 'openai-compatible') {
  return (Array.isArray(configProviders) ? configProviders : [])
    .filter((provider) => provider.adapter === adapter)
    .map((provider) => {
      const runtimeProvider = {};
      for (const field of RUNTIME_PROVIDER_FIELDS) runtimeProvider[field] = provider[field];
      return runtimeProvider;
    });
}

module.exports = { RUNTIME_PROVIDER_FIELDS, toRuntimeProviders };
