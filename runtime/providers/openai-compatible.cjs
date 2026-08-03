// SPDX-License-Identifier: Apache-2.0
'use strict';

const { isLoopbackHostname, urlCredentialQueryKeys } = require('../config-loader.cjs');

function completionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return '';
}

function modelForPurpose(provider, purpose) {
  switch (purpose) {
    case 'fold':
      return provider.foldModel || provider.model;
    case 'memory-card':
      return provider.memoryModel || provider.foldModel || provider.model;
    case 'semantic-extract':
    case 'semantic-extract-repair':
    case 'semantic-extract-audit':
      return provider.semanticExtractorModel
        || provider.memoryModel
        || provider.foldModel
        || provider.model;
    case 'semantic-verify':
      return provider.semanticVerifierModel || provider.model;
    case 'semantic-high-risk':
      return provider.semanticHighRiskModel
        || provider.semanticVerifierModel
        || provider.model;
    default:
      return provider.model;
  }
}

function maxTokensForPurpose(provider, purpose) {
  switch (purpose) {
    case 'fold': return provider.foldMaxTokens;
    case 'memory-card': return provider.memoryMaxTokens;
    case 'semantic-extract':
    case 'semantic-extract-repair':
    case 'semantic-extract-audit':
      return provider.semanticExtractorMaxTokens || provider.memoryMaxTokens;
    case 'semantic-verify': return provider.semanticVerifierMaxTokens;
    case 'semantic-high-risk': return provider.semanticHighRiskMaxTokens
      || provider.semanticVerifierMaxTokens;
    default: return provider.maxTokens;
  }
}

function validatedProviderUrl(value, field = 'baseUrl') {
  const parsedUrl = new URL(value);
  const protocol = parsedUrl.protocol;
  if (!['http:', 'https:'].includes(protocol)) throw new Error(`${field} must use http or https`);
  if (protocol === 'http:' && !isLoopbackHostname(parsedUrl.hostname)) {
    throw new Error(`${field} must use https unless the host is loopback`);
  }
  if (parsedUrl.username || parsedUrl.password || urlCredentialQueryKeys(parsedUrl).length) {
    throw new Error(`${field} must not embed credentials`);
  }
  return parsedUrl.href;
}

function createOpenAICompatibleProvider({ providers, fetchImpl = globalThis.fetch, timeoutMs = 120000 } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('Provider chain is empty');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  return {
    async respond({ messages, purpose = 'chat' }) {
      const failures = [];
      for (const provider of providers) {
        try {
          if (!provider.baseUrl || !provider.model) throw new Error('baseUrl and model are required');
          const model = modelForPurpose(provider, purpose);
          const maxTokens = maxTokensForPurpose(provider, purpose);
          validatedProviderUrl(provider.baseUrl);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Number(provider.timeoutMs || timeoutMs));
          timer.unref?.();
          let response;
          try {
            response = await fetchImpl(provider.baseUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
                ...(provider.headers || {}),
              },
              body: JSON.stringify({
                model,
                messages,
                ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
              }),
              signal: controller.signal,
            });
          } finally { clearTimeout(timer); }
          const payload = await response.json();
          if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
          const text = completionText(payload);
          if (!text) throw new Error('Provider returned an empty completion');
          return {
            text,
            providerId: provider.id,
            providerLabel: provider.label || provider.id,
            model,
            purpose,
            finishReason: payload?.choices?.[0]?.finish_reason || null,
          };
        } catch (error) {
          failures.push({ providerId: provider.id, message: error.message });
        }
      }
      const error = new Error('Every configured provider failed');
      error.failures = failures;
      throw error;
    },
    async embed({ texts, purpose = 'memory-embedding' } = {}) {
      const input = (Array.isArray(texts) ? texts : []).map((text) => String(text));
      if (!input.length) throw new Error('Embedding input is empty');
      const failures = [];
      for (const provider of providers) {
        if (!provider.embeddingsUrl || !provider.embeddingModel) continue;
        try {
          validatedProviderUrl(provider.embeddingsUrl, 'embeddingsUrl');
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            Number(provider.embeddingTimeoutMs || provider.timeoutMs || timeoutMs),
          );
          timer.unref?.();
          let response;
          try {
            response = await fetchImpl(provider.embeddingsUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
                ...(provider.headers || {}),
              },
              body: JSON.stringify({
                model: provider.embeddingModel,
                input,
                ...(Number(provider.embeddingDimensions) > 0
                  ? { dimensions: Number(provider.embeddingDimensions) }
                  : {}),
              }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          const payload = await response.json();
          if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
          const rows = Array.isArray(payload?.data)
            ? [...payload.data].sort((left, right) => Number(left.index) - Number(right.index))
            : [];
          if (rows.length !== input.length || rows.some((row) => !Array.isArray(row.embedding))) {
            throw new Error('Embedding provider returned an invalid data array');
          }
          return {
            vectors: rows.map((row) => row.embedding),
            providerId: provider.id,
            providerLabel: provider.label || provider.id,
            model: provider.embeddingModel,
            purpose,
          };
        } catch (error) {
          failures.push({ providerId: provider.id, message: error.message });
        }
      }
      const error = new Error('Every configured embedding provider failed');
      error.failures = failures;
      throw error;
    },
  };
}

module.exports = {
  completionText,
  createOpenAICompatibleProvider,
  maxTokensForPurpose,
  modelForPurpose,
  validatedProviderUrl,
};
