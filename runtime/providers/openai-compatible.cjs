// SPDX-License-Identifier: Apache-2.0
'use strict';

const { isLoopbackHostname, urlCredentialQueryKeys } = require('../config-loader.cjs');

function completionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return '';
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
          const model = purpose === 'fold'
            ? (provider.foldModel || provider.model)
            : purpose === 'memory-card'
              ? (provider.memoryModel || provider.foldModel || provider.model)
              : provider.model;
          const maxTokens = purpose === 'fold'
            ? provider.foldMaxTokens
            : purpose === 'memory-card'
              ? provider.memoryMaxTokens
              : provider.maxTokens;
          const parsedUrl = new URL(provider.baseUrl);
          const protocol = parsedUrl.protocol;
          if (!['http:', 'https:'].includes(protocol)) throw new Error('baseUrl must use http or https');
          if (protocol === 'http:' && !isLoopbackHostname(parsedUrl.hostname)) {
            throw new Error('baseUrl must use https unless the host is loopback');
          }
          if (parsedUrl.username || parsedUrl.password || urlCredentialQueryKeys(parsedUrl).length) {
            throw new Error('baseUrl must not embed credentials');
          }
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
  };
}

module.exports = { completionText, createOpenAICompatibleProvider };
