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
  return {
    text: completionTextFromMessage(message),
    providerId: provider.id,
    providerLabel: provider.label || provider.id,
    model,
    purpose,
    finishReason: payload?.choices?.[0]?.finish_reason || null,
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
  const timer = setTimeout(() => controller.abort(), Number(provider.timeoutMs || timeoutMs));
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
    for (const provider of providers) {
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
        if (!completion.ok) throw new Error(completion.message);
        const text = completionTextFromMessage(completion.message);
        if (!text) throw new Error('Provider returned an empty completion');
        return providerResult(provider, completion.model, purpose, completion.payload, completion.message);
      } catch (error) {
        failures.push({ providerId: provider.id, message: error.message });
      }
    }
    const error = new Error('Every configured provider failed');
    error.failures = failures;
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

    while (iteration <= maxIterations) {
      const tools = iteration < maxIterations ? definitions : [];
      const failures = [];
      let completion = null;
      let selectedProvider = null;
      let selectedProviderIndex = -1;
      for (let providerIndex = startProviderIndex; providerIndex < providers.length; providerIndex += 1) {
        const provider = providers[providerIndex];
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
  messagesForProvider,
  modelForPurpose,
  toolRequestHash,
  validatedProviderUrl,
};
