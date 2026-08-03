// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, overlay) {
  if (!isObject(base) || !isObject(overlay)) return structuredClone(overlay);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = isObject(value) && isObject(merged[key])
      ? mergeConfig(merged[key], value)
      : structuredClone(value);
  }
  return merged;
}

function readJson(filePath, { optional = false } = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    throw new Error(`Cannot read config ${filePath}: ${error.message}`, { cause: error });
  }
}

function isCredentialHeaderName(name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/_/g, '-');
  const compact = normalized.replace(/-/g, '');
  return normalized === 'authorization'
    || normalized === 'proxy-authorization'
    || normalized === 'cookie'
    || normalized === 'set-cookie'
    || compact.includes('apikey')
    || normalized.endsWith('-token')
    || normalized.includes('access-token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('credential');
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function urlCredentialQueryKeys(url) {
  const credentialKey = /^(?:api-?key|x-?api-?key|key|token|access-?token|auth-?token|auth|authorization|secret|client-?secret|password|credential|signature|sig)$/i;
  return [...url.searchParams.keys()].filter((key) => (
    credentialKey.test(key.trim().replace(/[_.]/g, '-'))
  ));
}

function validateConfig(config) {
  const errors = [];
  if (!config.agent?.id) errors.push('agent.id is required');
  if (!config.agent?.displayName) errors.push('agent.displayName is required');
  if (!config.owner?.entityId) errors.push('owner.entityId is required');
  if (!config.owner?.displayName) errors.push('owner.displayName is required');
  if (!config.storage?.root) errors.push('storage.root is required');
  if (Object.hasOwn(config.telegram || {}, 'token')) {
    errors.push('telegram.token is forbidden; use telegram.tokenEnv');
  }
  if (
    config.telegram?.tokenEnv != null
    && !/^[A-Z_][A-Z0-9_]*$/.test(String(config.telegram.tokenEnv))
  ) {
    errors.push('telegram.tokenEnv must be an environment variable name');
  }
  if (config.telegram?.allowedGroups != null && !isObject(config.telegram.allowedGroups)) {
    errors.push('telegram.allowedGroups must be an object');
  }
  for (const [chatId, policy] of Object.entries(config.telegram?.allowedGroups || {})) {
    if (!chatId || !isObject(policy)) {
      errors.push(`telegram.allowedGroups.${chatId || '<empty>'} must be an object`);
      continue;
    }
    if (policy.mode != null && !['all', 'mention'].includes(String(policy.mode))) {
      errors.push(`telegram.allowedGroups.${chatId}.mode must be all or mention`);
    }
    if (policy.mentionPatterns != null && (
      !Array.isArray(policy.mentionPatterns)
      || policy.mentionPatterns.some((value) => !String(value || '').trim())
    )) {
      errors.push(`telegram.allowedGroups.${chatId}.mentionPatterns must be non-empty strings`);
    }
    for (const field of ['enabled', 'ownerAlways', 'ignoreBotMessages']) {
      if (policy[field] != null && typeof policy[field] !== 'boolean') {
        errors.push(`telegram.allowedGroups.${chatId}.${field} must be boolean`);
      }
    }
  }
  for (const field of ['noReplyGroupIds', 'rateLimitedGroupIds']) {
    if (config.telegram?.[field] != null && !Array.isArray(config.telegram[field])) {
      errors.push(`telegram.${field} must be an array`);
    }
  }
  for (const field of [
    'pollRetryDelayMs',
    'retryIntervalMs',
    'maxAttempts',
    'retryBaseMs',
    'retryMaxMs',
    'durableInboxMaxBytes',
    'maxImageBytes',
    'maxFileBytes',
    'maxFilePreviewChars',
    'maxQuotedChars',
    'groupMaxReplies',
    'groupMaxPendingMessages',
  ]) {
    if (
      config.telegram?.[field] != null
      && (!Number.isFinite(Number(config.telegram[field])) || Number(config.telegram[field]) <= 0)
    ) {
      errors.push(`telegram.${field} must be a positive number`);
    }
  }
  if (
    config.telegram?.groupRepairAttempts != null
    && (!Number.isSafeInteger(Number(config.telegram.groupRepairAttempts))
      || Number(config.telegram.groupRepairAttempts) < 0)
  ) {
    errors.push('telegram.groupRepairAttempts must be zero or a positive integer');
  }
  if (
    config.telegram?.groupAllowedReactions != null
    && (!Array.isArray(config.telegram.groupAllowedReactions)
      || config.telegram.groupAllowedReactions.some((value) => !String(value || '').trim()))
  ) {
    errors.push('telegram.groupAllowedReactions must be non-empty strings');
  }
  if (config.telegram?.groupBatchTiming != null && !isObject(config.telegram.groupBatchTiming)) {
    errors.push('telegram.groupBatchTiming must be an object');
  }
  for (const [field, value] of Object.entries(config.telegram?.groupBatchTiming || {})) {
    if (![
      'singleMessageMs',
      'sameSenderIdleMs',
      'sameSenderMaxMs',
      'multiSenderIdleMs',
      'multiSenderMaxMs',
    ].includes(field) || !Number.isFinite(Number(value)) || Number(value) < 0) {
      errors.push(`telegram.groupBatchTiming.${field} must be zero or a positive number`);
    }
  }
  if (
    config.telegram?.pollTimeoutSeconds != null
    && (!Number.isFinite(Number(config.telegram.pollTimeoutSeconds))
      || Number(config.telegram.pollTimeoutSeconds) < 0)
  ) {
    errors.push('telegram.pollTimeoutSeconds must be zero or a positive number');
  }
  if (
    config.telegram?.retryBaseMs != null
    && config.telegram?.retryMaxMs != null
    && Number(config.telegram.retryMaxMs) < Number(config.telegram.retryBaseMs)
  ) {
    errors.push('telegram.retryMaxMs must not be smaller than telegram.retryBaseMs');
  }
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    errors.push('at least one provider is required');
  }
  for (const [index, provider] of (config.providers || []).entries()) {
    if (!provider.id) errors.push(`providers[${index}].id is required`);
    if (!provider.label) errors.push(`providers[${index}].label is required`);
    if (!provider.adapter) errors.push(`providers[${index}].adapter is required`);
    if (!provider.model) errors.push(`providers[${index}].model is required`);
    for (const field of [
      'foldModel',
      'memoryModel',
      'semanticExtractorModel',
      'semanticVerifierModel',
      'semanticHighRiskModel',
      'embeddingModel',
      'embeddingsUrl',
    ]) {
      if (provider[field] != null && !String(provider[field]).trim()) {
        errors.push(`providers[${index}].${field} must be a non-empty string when supplied`);
      }
    }
    if (Object.hasOwn(provider, 'apiKey')) {
      errors.push(`providers[${index}].apiKey is forbidden; use apiKeyEnv`);
    }
    if (provider.headers != null && !isObject(provider.headers)) {
      errors.push(`providers[${index}].headers must be an object`);
    }
    for (const [headerName, headerValue] of Object.entries(provider.headers || {})) {
      if (isCredentialHeaderName(headerName)
        || /^(?:bearer|basic)\s+/i.test(String(headerValue || '').trim())) {
        errors.push(`providers[${index}].headers.${headerName} may contain credentials; use headerEnv`);
      }
    }
    if (provider.headerEnv != null && !isObject(provider.headerEnv)) {
      errors.push(`providers[${index}].headerEnv must be an object`);
    }
    for (const [headerName, envName] of Object.entries(provider.headerEnv || {})) {
      if (!headerName.trim() || !/^[A-Z_][A-Z0-9_]*$/.test(String(envName || ''))) {
        errors.push(`providers[${index}].headerEnv must map header names to environment variable names`);
      }
      if (Object.keys(provider.headers || {}).some((name) => name.toLowerCase() === headerName.toLowerCase())) {
        errors.push(`providers[${index}] duplicates header ${headerName} in headers and headerEnv`);
      }
    }
    if (!provider.apiKeyEnv && provider.authentication !== 'none') {
      errors.push(`providers[${index}] must declare apiKeyEnv or authentication=none`);
    }
    if (provider.adapter === 'openai-compatible' && !provider.baseUrl) {
      errors.push(`providers[${index}].baseUrl is required`);
    }
    if (
      provider.imageInput != null
      && !['data-url', 'metadata-only', 'reject'].includes(String(provider.imageInput))
    ) {
      errors.push(`providers[${index}].imageInput must be data-url, metadata-only, or reject`);
    }
    if (
      provider.maxImageParts != null
      && (!Number.isSafeInteger(Number(provider.maxImageParts)) || Number(provider.maxImageParts) <= 0)
    ) {
      errors.push(`providers[${index}].maxImageParts must be a positive integer`);
    }
    if (Boolean(provider.embeddingModel) !== Boolean(provider.embeddingsUrl)) {
      errors.push(`providers[${index}] must declare embeddingModel and embeddingsUrl together`);
    }
    if (provider.baseUrl) {
      try {
        const parsed = new URL(provider.baseUrl);
        const protocol = parsed.protocol;
        if (!['http:', 'https:'].includes(protocol)) throw new Error('unsupported protocol');
        if (parsed.username || parsed.password) {
          errors.push(`providers[${index}].baseUrl must not contain username or password credentials`);
        }
        const credentialQueryKeys = urlCredentialQueryKeys(parsed);
        if (credentialQueryKeys.length) {
          errors.push(`providers[${index}].baseUrl must not contain credential query parameters: ${credentialQueryKeys.join(', ')}`);
        }
        if (protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
          errors.push(`providers[${index}].baseUrl must use https unless the host is loopback`);
        }
      } catch (_) {
        errors.push(`providers[${index}].baseUrl must use http or https`);
      }
    }
    if (provider.embeddingsUrl) {
      try {
        const parsed = new URL(provider.embeddingsUrl);
        const protocol = parsed.protocol;
        if (!['http:', 'https:'].includes(protocol)) throw new Error('unsupported protocol');
        if (parsed.username || parsed.password) {
          errors.push(`providers[${index}].embeddingsUrl must not contain username or password credentials`);
        }
        const credentialQueryKeys = urlCredentialQueryKeys(parsed);
        if (credentialQueryKeys.length) {
          errors.push(`providers[${index}].embeddingsUrl must not contain credential query parameters: ${credentialQueryKeys.join(', ')}`);
        }
        if (protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
          errors.push(`providers[${index}].embeddingsUrl must use https unless the host is loopback`);
        }
      } catch (_) {
        errors.push(`providers[${index}].embeddingsUrl must use http or https`);
      }
    }
    for (const field of ['embeddingDimensions', 'embeddingTimeoutMs']) {
      if (
        provider[field] != null
        && (!Number.isFinite(Number(provider[field])) || Number(provider[field]) <= 0)
      ) {
        errors.push(`providers[${index}].${field} must be a positive number`);
      }
    }
  }
  const memory = config.memory || {};
  const numericMemoryFields = [
    'historyTokenBudget',
    'roundsBudget',
    'hardTokenCap',
    'activeSoftTokenWatermark',
    'activeTargetTokenWatermark',
    'roundHardLimit',
    'minimumRawTailRounds',
    'summaryHistoryLimit',
    'foldSummaryMaxChars',
    'contextTokenBudget',
    'recentWeekCount',
  ];
  for (const field of numericMemoryFields) {
    if (memory[field] != null && (!Number.isFinite(Number(memory[field])) || Number(memory[field]) <= 0)) {
      errors.push(`memory.${field} must be a positive number`);
    }
  }
  if (
    memory.activeSoftTokenWatermark != null
    && memory.activeTargetTokenWatermark != null
    && Number(memory.activeTargetTokenWatermark) > Number(memory.activeSoftTokenWatermark)
  ) {
    errors.push('memory.activeTargetTokenWatermark must not exceed activeSoftTokenWatermark');
  }
  if (memory.cards?.policy != null && !['pending', 'relational', 'lossless'].includes(memory.cards.policy)) {
    errors.push('memory.cards.policy must be pending, relational, or lossless');
  }
  if (
    memory.semantic?.mode != null
    && !['off', 'shadow', 'cards', 'full'].includes(String(memory.semantic.mode))
  ) {
    errors.push('memory.semantic.mode must be off, shadow, cards, or full');
  }
  for (const field of ['manifestMaxRecords', 'manifestMaxBytes']) {
    if (
      memory.semantic?.[field] != null
      && (!Number.isFinite(Number(memory.semantic[field])) || Number(memory.semantic[field]) <= 0)
    ) {
      errors.push(`memory.semantic.${field} must be a positive number`);
    }
  }
  if (memory.semantic?.embeddings != null && !isObject(memory.semantic.embeddings)) {
    errors.push('memory.semantic.embeddings must be an object');
  }
  const embeddings = isObject(memory.semantic?.embeddings)
    ? memory.semantic.embeddings
    : {};
  if (embeddings.enabled === true && !(config.providers || []).some(
    (provider) => provider.embeddingModel && provider.embeddingsUrl,
  )) {
    errors.push('memory.semantic.embeddings.enabled requires an embedding provider');
  }
  for (const field of [
    'batchSize',
    'topK',
    'maxEmbeddingChars',
    'maxRetrievedChars',
    'maxBytes',
  ]) {
    if (
      embeddings[field] != null
      && (!Number.isFinite(Number(embeddings[field])) || Number(embeddings[field]) <= 0)
    ) {
      errors.push(`memory.semantic.embeddings.${field} must be a positive number`);
    }
  }
  if (
    embeddings.minScore != null
    && (!Number.isFinite(Number(embeddings.minScore))
      || Number(embeddings.minScore) < -1
      || Number(embeddings.minScore) > 1)
  ) {
    errors.push('memory.semantic.embeddings.minScore must be between -1 and 1');
  }
  if (Array.isArray(config.entities)) {
    const entityIds = config.entities.map((entity) => String(entity?.entityId || '').trim());
    if (entityIds.some((entityId) => !entityId)) errors.push('entities entries require entityId');
    if (new Set(entityIds).size !== entityIds.length) errors.push('entities entityId values must be unique');
  } else if (config.entities != null) {
    errors.push('entities must be an array when supplied');
  }
  for (const field of [
    'maintenanceIntervalMs',
    'maintenanceErrorBaseDelayMs',
    'maintenanceErrorMaxDelayMs',
  ]) {
    if (
      config.runtime?.[field] != null
      && (!Number.isFinite(Number(config.runtime[field])) || Number(config.runtime[field]) <= 0)
    ) {
      errors.push(`runtime.${field} must be a positive number`);
    }
  }
  if (
    config.runtime?.maintenanceActiveDelayMs != null
    && (!Number.isFinite(Number(config.runtime.maintenanceActiveDelayMs))
      || Number(config.runtime.maintenanceActiveDelayMs) < 0)
  ) {
    errors.push('runtime.maintenanceActiveDelayMs must be zero or a positive number');
  }
  if (errors.length) throw new Error(`Invalid Tether config:\n- ${errors.join('\n- ')}`);
  return config;
}

function resolveWithin(baseDirectory, value) {
  return path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
}

function loadTetherConfig(configPath, {
  privateOverlayPath = process.env.TETHER_PRIVATE_CONFIG || null,
  env = process.env,
} = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const baseDirectory = path.dirname(resolvedConfigPath);
  let config = readJson(resolvedConfigPath);
  const overlayPath = privateOverlayPath
    ? resolveWithin(baseDirectory, privateOverlayPath)
    : path.join(baseDirectory, 'config.private.json');
  config = mergeConfig(config, readJson(overlayPath, { optional: true }));
  validateConfig(config);
  config.storage = {
    ...config.storage,
    root: resolveWithin(baseDirectory, config.storage.root),
  };
  if (config.telegram?.rateLimitStateDir) {
    config.telegram.rateLimitStateDir = resolveWithin(
      baseDirectory,
      config.telegram.rateLimitStateDir,
    );
  }
  if (config.telegram?.attachmentDirectory) {
    config.telegram.attachmentDirectory = resolveWithin(
      baseDirectory,
      config.telegram.attachmentDirectory,
    );
  }
  const personaPolicyFile = config.persona?.policyFile
    ? resolveWithin(baseDirectory, config.persona.policyFile)
    : null;
  const personaPrompt = personaPolicyFile
    ? fs.readFileSync(personaPolicyFile, 'utf8')
    : String(config.persona?.inlinePolicy || '');
  config = {
    ...config,
    persona: {
      ...(config.persona || {}),
      policyFile: personaPolicyFile,
      prompt: personaPrompt,
    },
    providers: (config.providers || []).map((provider, index) => {
      const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] || null : null;
      if (provider.apiKeyEnv && !apiKey) {
        throw new Error(`Missing required provider credential env: ${provider.apiKeyEnv} (providers[${index}])`);
      }
      const envHeaders = {};
      for (const [headerName, envName] of Object.entries(provider.headerEnv || {})) {
        const value = env[envName];
        if (!value) {
          throw new Error(`Missing required provider header credential env: ${envName} (providers[${index}])`);
        }
        envHeaders[headerName] = value;
      }
      return { ...provider, headers: { ...(provider.headers || {}), ...envHeaders }, apiKey };
    }),
  };
  return config;
}

module.exports = {
  isCredentialHeaderName,
  isLoopbackHostname,
  loadTetherConfig,
  mergeConfig,
  urlCredentialQueryKeys,
  validateConfig,
};
