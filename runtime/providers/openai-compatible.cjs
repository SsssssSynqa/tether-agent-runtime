// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('node:crypto');
const { isLoopbackHostname, urlCredentialQueryKeys } = require('../config-loader.cjs');
const { canonicalJson } = require('../tools/workspace-tools.cjs');

function completionTextFromMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return '';
}

function completionText(payload) {
  return completionTextFromMessage(payload?.choices?.[0]?.message);
}

// A provider may declare `purposes` to restrict what it is used for. Two groups:
//   "chat"       - replying to the owner (the agent's voice)
//   "background" - fold, memory cards, semantic extraction/verification
// Omitting `purposes` keeps a provider eligible for everything, so existing
// configs are unaffected. Declaring it lets background work run on a separate
// account from the agent's voice — added 2026-08-09 so billing for summarisation
// can be kept off the conversational key.
const BACKGROUND_PURPOSES = new Set([
  'fold',
  'memory-card',
  'memory-embedding',
  'semantic-extract',
  'semantic-extract-repair',
  'semantic-extract-audit',
  'semantic-verify',
  'semantic-high-risk',
]);

function purposeGroup(purpose) {
  return BACKGROUND_PURPOSES.has(purpose) ? 'background' : 'chat';
}

// Chat and background work have very different latency profiles: a reply is
// interactive and should fail fast, while a fold digests tens of thousands of
// characters and legitimately runs for a minute or more. Sharing one timeout
// forces a bad trade — set it low and every fold aborts after the model already
// did (and billed) the work; set it high and a stuck reply hangs the channel.
// Background gets 2x by default; override per provider with backgroundTimeoutMs.
function timeoutForPurpose(provider, purpose, fallback) {
  const base = Number(provider.timeoutMs || fallback);
  if (purposeGroup(purpose) !== 'background') return base;
  return Number(provider.backgroundTimeoutMs) || base * 2;
}

function providersForPurpose(providers, purpose) {
  const group = purposeGroup(purpose);
  return providers.filter(
    (provider) => !Array.isArray(provider.purposes)
      || provider.purposes.length === 0
      || provider.purposes.includes(group),
  );
}

function noEligibleProviderError(purpose) {
  const group = purposeGroup(purpose);
  const error = new Error(`No provider is eligible for the ${group} purpose group`);
  error.code = 'TETHER_PROVIDER_PURPOSE_UNAVAILABLE';
  error.purposeGroup = group;
  return error;
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

// Background work must always send an explicit max_tokens. Without one the
// request omits the field entirely (see fetchCompletion), and a reasoning model
// will keep generating until the socket times out — the fold never lands, the
// transcript never shrinks, and the next turn carries even more context. That
// exact chain took an agent offline for a full day on 2026-08-08: foldMaxTokens
// was simply absent from its config, so folds ran 138s against a 180s timeout,
// failed, and the context grew to 235k tokens until upstream moderation refused
// every request. A missing config key must not silently disable a safety bound.
//
// Chat is deliberately exempt: letting the model decide its own reply length is
// the desired behaviour there.
const DEFAULT_MAX_TOKENS_BY_PURPOSE = {
  fold: 8000,
  'memory-card': 8000,
  'semantic-extract': 16000,
  'semantic-extract-repair': 16000,
  'semantic-extract-audit': 16000,
  'semantic-verify': 4000,
  'semantic-high-risk': 4000,
};

function maxTokensForPurpose(provider, purpose) {
  switch (purpose) {
    case 'fold': return provider.foldMaxTokens || DEFAULT_MAX_TOKENS_BY_PURPOSE.fold;
    case 'memory-card': return provider.memoryMaxTokens
      || DEFAULT_MAX_TOKENS_BY_PURPOSE['memory-card'];
    case 'semantic-extract':
    case 'semantic-extract-repair':
    case 'semantic-extract-audit':
      return provider.semanticExtractorMaxTokens
        || provider.memoryMaxTokens
        || DEFAULT_MAX_TOKENS_BY_PURPOSE['semantic-extract'];
    case 'semantic-verify': return provider.semanticVerifierMaxTokens
      || DEFAULT_MAX_TOKENS_BY_PURPOSE['semantic-verify'];
    case 'semantic-high-risk': return provider.semanticHighRiskMaxTokens
      || provider.semanticVerifierMaxTokens
      || DEFAULT_MAX_TOKENS_BY_PURPOSE['semantic-high-risk'];
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

function imagePartsForProvider(sourceParts = [], limit = 4) {
  return (Array.isArray(sourceParts) ? sourceParts : [])
    .filter((part) => part?.type === 'image')
    .slice(0, Math.max(1, Number(limit) || 4))
    .map((part) => {
      const mimeType = String(part.mimeType || '').toLowerCase();
      const data = String(part.data || '');
      if (!/^image\/(?:png|jpe?g|webp|gif)$/.test(mimeType)) {
        throw new Error(`Unsupported provider image MIME type: ${mimeType || 'missing'}`);
      }
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error('Provider image part is not valid base64');
      }
      return {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${data}` },
      };
    });
}

function messagesForProvider(messages, sourceParts, provider) {
  const images = imagePartsForProvider(sourceParts, provider.maxImageParts);
  if (!images.length || provider.imageInput === 'metadata-only' || !provider.imageInput) {
    return structuredClone(messages);
  }
  if (provider.imageInput === 'reject') {
    throw new Error('Provider is configured to reject image input');
  }
  if (provider.imageInput !== 'data-url') {
    throw new Error(`Unknown provider imageInput mode: ${provider.imageInput}`);
  }
  const prepared = messages.map((message) => structuredClone(message));
  const userIndex = prepared.findLastIndex((message) => message.role === 'user');
  if (userIndex < 0) throw new Error('Image input requires a user message');
  const content = prepared[userIndex].content;
  const textParts = Array.isArray(content)
    ? content
    : [{ type: 'text', text: String(content || '') }];
  prepared[userIndex] = { ...prepared[userIndex], content: [...textParts, ...images] };
  return prepared;
}

function providerResult(provider, model, purpose, payload, message) {
  const outputRoute = {
    providerId: String(provider.id),
    providerLabel: String(provider.label || provider.id),
    model: String(model),
  };
  return {
    text: completionTextFromMessage(message),
    providerId: provider.id,
    providerLabel: provider.label || provider.id,
    model,
    purpose,
    finishReason: payload?.choices?.[0]?.finish_reason || null,
    // Only the successful response that contributed the committed text is
    // reported. Failed providers and rejected candidates never enter this list.
    outputRoutes: [outputRoute],
  };
}

function normalizedToolCalls(message, iteration) {
  if (message?.tool_calls == null) return [];
  if (!Array.isArray(message.tool_calls)) throw new Error('Provider returned invalid tool_calls');
  const calls = message.tool_calls.map((call, index) => {
    const name = String(call?.function?.name || '').trim();
    if (!name) throw new Error('Provider tool call is missing a function name');
    const rawArguments = call?.function?.arguments;
    const argsText = typeof rawArguments === 'string'
      ? rawArguments
      : canonicalJson(rawArguments || {});
    const derivedId = `tool_${crypto.createHash('sha256')
      .update(canonicalJson({ iteration, index, name, argsText }))
      .digest('hex').slice(0, 24)}`;
    return {
      id: String(call?.id || derivedId),
      type: 'function',
      function: { name, arguments: argsText },
    };
  });
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new Error('Provider returned duplicate tool call identifiers');
  }
  return calls;
}

function parseToolArguments(call) {
  try {
    const parsed = JSON.parse(String(call.function.arguments || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (_) {
    return null;
  }
}

function sourcePartProofs(sourceParts = []) {
  return (Array.isArray(sourceParts) ? sourceParts : []).map((part) => ({
    type: String(part?.type || ''),
    mimeType: String(part?.mimeType || ''),
    sha256: crypto.createHash('sha256').update(String(part?.data || ''), 'utf8').digest('hex'),
  }));
}

function toolRequestHash({
  messages,
  sourceParts,
  definitions,
  toolContext,
  toolContractHash,
  providers,
  maxIterations,
}) {
  const context = {
    channelId: String(toolContext?.channelId || ''),
    trustZone: String(toolContext?.trustZone || ''),
    isGroup: toolContext?.isGroup === true,
    senderId: String(toolContext?.senderId || ''),
    owner: toolContext?.owner === true,
  };
  const providerContract = providers.map((provider) => ({
    id: String(provider.id || ''),
    model: String(provider.model || ''),
    baseUrl: String(provider.baseUrl || ''),
  }));
  return crypto.createHash('sha256').update(canonicalJson({
    schemaVersion: 1,
    messages,
    sourceParts: sourcePartProofs(sourceParts),
    definitions,
    toolContractHash,
    context,
    providerContract,
    maxIterations,
  })).digest('hex');
}

async function fetchCompletion({
  provider,
  messages,
  purpose,
  sourceParts,
  tools,
  fetchImpl,
  timeoutMs,
}) {
  if (!provider.baseUrl || !provider.model) throw new Error('baseUrl and model are required');
  const model = modelForPurpose(provider, purpose);
  const maxTokens = maxTokensForPurpose(provider, purpose);
  const baseUrl = validatedProviderUrl(provider.baseUrl);
  const providerMessages = messagesForProvider(messages, sourceParts, provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutForPurpose(provider, purpose, timeoutMs));
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        ...(provider.headers || {}),
      },
      body: JSON.stringify({
        model,
        messages: providerMessages,
        ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
        ...(Array.isArray(tools) && tools.length ? {
          tools,
          parallel_tool_calls: false,
        } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: payload?.error?.message || `HTTP ${response.status}`,
    };
  }
  const rawMessage = payload?.choices?.[0]?.message;
  if (!rawMessage || typeof rawMessage !== 'object') throw new Error('Provider returned no message');
  return { ok: true, payload, message: structuredClone(rawMessage), model };
}

// Transient failures deserve a second attempt on the same provider before
// falling through to the next one: a dropped socket or a gateway hiccup costs
// nothing to retry, while switching providers may mean a different model, a
// different account, and (for personas) a different voice. Permanent failures —
// bad credentials, refused content, exhausted balance — are not retried; the
// answer will not change and each attempt still costs money.
const PERMANENT_ERROR_PATTERN =
  /invalid[_ ]?(api[_ ]?key|token)|unauthor|forbidden|insufficient|quota|balance|inappropriate|prohibited|safety|content[_ ]filter|not[_ ]found|unpurchased|access ?denied|(?:daily|weekly|monthly)\s+(?:token\s+)?limit|exceeded.*(?:daily|weekly|monthly).*limit/i;

function isTransientError(error) {
  const message = String(error?.message || '');
  if (PERMANENT_ERROR_PATTERN.test(message)) return false;
  if (/timeout|aborted|fetch failed|ECONNRESET|EPIPE|ETIMEDOUT|socket|network/i.test(message)) return true;
  const status = Number(error?.status);
  if (status >= 500 || status === 429) return true;
  // Gateways sometimes surface upstream hiccups as an opaque code with no detail;
  // treating those as transient is what makes intermittent failures survivable.
  return /^HTTP 5|openai_error|internal[_ ]error|service[_ ]unavailable/i.test(message);
}

function ambiguousInferenceError(causalId, cause) {
  const error = new Error('Provider request may have completed without a durable response; refusing reinference', {
    cause,
  });
  error.code = 'TETHER_TOOL_INFERENCE_AMBIGUOUS';
  error.causalId = causalId;
  error.manualRetryOnly = true;
  return error;
}

function createOpenAICompatibleProvider({
  providers,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  toolRuntime = null,
} = {}) {
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('Provider chain is empty');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  async function respondWithoutTools({ messages, purpose, sourceParts }) {
    const failures = [];
    const eligibleProviders = providersForPurpose(providers, purpose);
    if (!eligibleProviders.length) throw noEligibleProviderError(purpose);
    for (const provider of eligibleProviders) {
      const attempts = Math.max(1, Number(provider.maxAttempts) || 2);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const completion = await fetchCompletion({
            provider,
            messages,
            purpose,
            sourceParts,
            tools: [],
            fetchImpl,
            timeoutMs,
          });
          if (!completion.ok) {
            const error = new Error(completion.message);
            error.status = completion.status;
            throw error;
          }
          const text = completionTextFromMessage(completion.message);
          if (!text) throw new Error('Provider returned an empty completion');
          return providerResult(provider, completion.model, purpose, completion.payload, completion.message);
        } catch (error) {
          const exhausted = attempt >= attempts;
          if (exhausted || !isTransientError(error)) {
            failures.push({
              providerId: provider.id,
              message: error.message,
              ...(attempt > 1 ? { attempts: attempt } : {}),
            });
            break;
          }
        }
      }
    }
    const error = new Error('Every configured provider failed');
    error.failures = failures;
    error.providerFailure = true;
    throw error;
  }

  async function respondWithTools({ messages, purpose, sourceParts, causalId, toolContext }) {
    const context = { ...(toolContext || {}), causalId };
    const definitions = toolRuntime.definitions(context);
    const maxIterations = Math.max(1, Number(toolRuntime.maxIterations || 5));
    const requestHash = toolRequestHash({
      messages,
      sourceParts,
      definitions,
      toolContext: context,
      toolContractHash: toolRuntime.contractHash?.(context) || null,
      providers,
      maxIterations,
    });
    toolRuntime.beginTransaction(causalId, requestHash);
    let events = toolRuntime.transactionEvents(causalId);
    const latest = events.at(-1);
    if (latest?.event === 'request-started') {
      throw ambiguousInferenceError(causalId);
    }
    const durableFinal = [...events].reverse().find((event) => event.event === 'final');
    if (durableFinal?.result) return { ...structuredClone(durableFinal.result), replayed: true };

    const workingMessages = structuredClone(messages);
    for (const event of events) {
      if (event.event === 'provider-step' && event.message) {
        workingMessages.push(structuredClone(event.message));
      } else if (event.event === 'tool-result' && event.message) {
        workingMessages.push(structuredClone(event.message));
      }
    }

    let latestStepIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].event === 'provider-step') { latestStepIndex = index; break; }
    }
    let iteration = 0;
    let startProviderIndex = 0;
    if (latestStepIndex >= 0) {
      const step = events[latestStepIndex];
      const calls = normalizedToolCalls(step.message, step.iteration);
      if (!calls.length) {
        const result = structuredClone(step.result);
        if (!result?.text) throw new Error('Provider returned an empty completion');
        toolRuntime.recordTransaction(causalId, 'final', { result });
        return result;
      }
      if (Number(step.iteration) >= maxIterations) {
        const error = new Error('Provider requested another tool after the configured tool-iteration limit');
        error.code = 'TETHER_TOOL_ITERATION_LIMIT';
        throw error;
      }
      const completedIds = new Set(events.slice(latestStepIndex + 1)
        .filter((event) => event.event === 'tool-result')
        .map((event) => String(event.toolCallId)));
      for (const call of calls) {
        if (completedIds.has(call.id)) continue;
        const args = parseToolArguments(call);
        const result = args == null
          ? {
              ok: false,
              status: 'error',
              error: {
                code: 'TETHER_TOOL_ARGUMENTS_INVALID',
                message: 'Tool arguments were not valid JSON object syntax',
              },
            }
          : await toolRuntime.execute({
              id: call.id,
              name: call.function.name,
              arguments: args,
            }, context);
        const toolMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        };
        workingMessages.push(toolMessage);
        toolRuntime.recordTransaction(causalId, 'tool-result', {
          iteration: Number(step.iteration),
          toolCallId: call.id,
          message: toolMessage,
        });
      }
      iteration = Number(step.iteration) + 1;
      events = toolRuntime.transactionEvents(causalId);
    }

    const lastEvent = events.at(-1);
    if (lastEvent?.event === 'provider-failed') {
      iteration = Number(lastEvent.iteration);
      startProviderIndex = Number(lastEvent.providerIndex) + 1;
    }

    const eligibleIds = new Set(providersForPurpose(providers, purpose).map((p) => p.id));
    if (!eligibleIds.size) throw noEligibleProviderError(purpose);
    while (iteration <= maxIterations) {
      const tools = iteration < maxIterations ? definitions : [];
      const failures = [];
      let completion = null;
      let selectedProvider = null;
      let selectedProviderIndex = -1;
      // Keep the original index space: providerIndex is persisted in the tool
      // transaction journal for resume, so filtering the array would misalign it
      // after a restart. Skip ineligible providers instead of re-indexing.
      for (let providerIndex = startProviderIndex; providerIndex < providers.length; providerIndex += 1) {
        const provider = providers[providerIndex];
        if (!eligibleIds.has(provider.id)) continue;
        try {
          if (!provider.baseUrl || !provider.model) throw new Error('baseUrl and model are required');
          validatedProviderUrl(provider.baseUrl);
          messagesForProvider(workingMessages, sourceParts, provider);
        } catch (error) {
          failures.push({ providerId: provider.id, message: error.message });
          toolRuntime.recordTransaction(causalId, 'provider-failed', {
            iteration,
            providerIndex,
            providerId: provider.id,
            reason: error.message,
          });
          continue;
        }
        toolRuntime.recordTransaction(causalId, 'request-started', {
          iteration,
          providerIndex,
          providerId: provider.id,
        });
        try {
          completion = await fetchCompletion({
            provider,
            messages: workingMessages,
            purpose,
            sourceParts,
            tools,
            fetchImpl,
            timeoutMs,
          });
        } catch (error) {
          throw ambiguousInferenceError(causalId, error);
        }
        if (!completion.ok) {
          failures.push({ providerId: provider.id, message: completion.message });
          toolRuntime.recordTransaction(causalId, 'provider-failed', {
            iteration,
            providerIndex,
            providerId: provider.id,
            status: completion.status,
            reason: completion.message,
          });
          completion = null;
          continue;
        }
        selectedProvider = provider;
        selectedProviderIndex = providerIndex;
        break;
      }
      if (!completion || !selectedProvider) {
        const error = new Error('Every configured provider failed');
        error.failures = failures;
        error.providerFailure = true;
        throw error;
      }

      const toolCalls = normalizedToolCalls(completion.message, iteration);
      const assistantMessage = {
        role: 'assistant',
        content: completion.message.content ?? null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      const result = providerResult(
        selectedProvider,
        completion.model,
        purpose,
        completion.payload,
        assistantMessage,
      );
      toolRuntime.recordTransaction(causalId, 'provider-step', {
        iteration,
        providerIndex: selectedProviderIndex,
        providerId: selectedProvider.id,
        message: assistantMessage,
        result,
      });
      workingMessages.push(assistantMessage);

      if (!toolCalls.length) {
        if (!result.text) throw new Error('Provider returned an empty completion');
        toolRuntime.recordTransaction(causalId, 'final', { result });
        return result;
      }
      if (!tools.length) {
        const error = new Error('Provider requested another tool after the configured tool-iteration limit');
        error.code = 'TETHER_TOOL_ITERATION_LIMIT';
        throw error;
      }
      for (const call of toolCalls) {
        const args = parseToolArguments(call);
        const toolResult = args == null
          ? {
              ok: false,
              status: 'error',
              error: {
                code: 'TETHER_TOOL_ARGUMENTS_INVALID',
                message: 'Tool arguments were not valid JSON object syntax',
              },
            }
          : await toolRuntime.execute({
              id: call.id,
              name: call.function.name,
              arguments: args,
            }, context);
        const toolMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        };
        workingMessages.push(toolMessage);
        toolRuntime.recordTransaction(causalId, 'tool-result', {
          iteration,
          toolCallId: call.id,
          message: toolMessage,
        });
      }
      iteration += 1;
      startProviderIndex = 0;
    }
    throw new Error('Tool loop ended without a final provider response');
  }

  return {
    canResume(causalId) {
      return Boolean(toolRuntime?.canResume(causalId));
    },
    async respond({
      messages,
      purpose = 'chat',
      sourceParts = [],
      causalId = null,
      toolContext = {},
    }) {
      const existingTransaction = causalId && toolRuntime
        ? toolRuntime.transactionEvents(causalId).length > 0
        : false;
      const definitions = purpose === 'chat' && toolRuntime
        ? toolRuntime.definitions({ ...toolContext, causalId })
        : [];
      if (purpose === 'chat' && causalId && toolRuntime
        && (existingTransaction || definitions.length > 0)) {
        return respondWithTools({
          messages,
          purpose,
          sourceParts,
          causalId: String(causalId),
          toolContext,
        });
      }
      return respondWithoutTools({ messages, purpose, sourceParts });
    },
    async embed({ texts, purpose = 'memory-embedding' } = {}) {
      const input = (Array.isArray(texts) ? texts : []).map((text) => String(text));
      if (!input.length) throw new Error('Embedding input is empty');
      const failures = [];
      const eligibleProviders = providersForPurpose(providers, purpose);
      if (!eligibleProviders.length) throw noEligibleProviderError(purpose);
      for (const provider of eligibleProviders) {
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
  messagesForProvider,
  modelForPurpose,
  toolRequestHash,
  validatedProviderUrl,
};
