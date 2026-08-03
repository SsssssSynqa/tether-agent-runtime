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
  if (!config.storage?.root) errors.push('storage.root is required');
  if (Object.hasOwn(config.telegram || {}, 'token')) {
    errors.push('telegram.token is forbidden; use telegram.tokenEnv');
  }
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    errors.push('at least one provider is required');
  }
  for (const [index, provider] of (config.providers || []).entries()) {
    if (!provider.id) errors.push(`providers[${index}].id is required`);
    if (!provider.label) errors.push(`providers[${index}].label is required`);
    if (!provider.adapter) errors.push(`providers[${index}].adapter is required`);
    if (!provider.model) errors.push(`providers[${index}].model is required`);
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
