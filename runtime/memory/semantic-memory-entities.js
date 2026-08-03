// SPDX-License-Identifier: Apache-2.0
'use strict';

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function senderIdFromMessage(message = {}) {
  const direct = String(message.senderId || '').trim();
  if (direct) return direct;
  const explicit = String(message.senderEntityId || '');
  const match = explicit.match(/^telegram-user:(\d+)$/);
  return match ? match[1] : '';
}

function telegramIdsForEntity(entity = {}) {
  return unique([
    ...(entity.telegramUserIds || []),
    ...(entity.sourceIds || [])
      .map(String)
      .filter((sourceId) => sourceId.startsWith('telegram:'))
      .map((sourceId) => sourceId.slice('telegram:'.length)),
  ]);
}

function createSemanticEntityResolver({ entities = [] } = {}) {
  const normalizedEntities = (entities || [])
    .filter((entity) => entity?.entityId && !entity?.canonicalEntityId)
    .map((entity) => ({
      ...entity,
      entityId: String(entity.entityId),
      canonicalDisplayName: String(entity.canonicalDisplayName || entity.entityId),
      aliasDisplayNames: unique(entity.aliasDisplayNames),
      botDisplayNames: unique(entity.botDisplayNames),
      telegramUserIds: telegramIdsForEntity(entity),
    }));
  const byId = new Map(normalizedEntities.map((entity) => [entity.entityId, entity]));
  const byTelegramId = new Map();
  const byBotDisplay = new Map();
  for (const entity of normalizedEntities) {
    for (const senderId of entity.telegramUserIds) byTelegramId.set(senderId, entity.entityId);
    for (const displayName of unique([
      entity.canonicalDisplayName,
      ...entity.aliasDisplayNames,
      ...entity.botDisplayNames,
    ])) {
      byBotDisplay.set(displayName.toLocaleLowerCase(), entity.entityId);
    }
  }
  return Object.freeze({
    entities: Object.freeze(normalizedEntities),
    canonicalDisplayName(entityId, fallback = null) {
      return byId.get(String(entityId || ''))?.canonicalDisplayName
        || fallback
        || String(entityId || '');
    },
    canonicalTelegramEntityId(senderId) {
      return byTelegramId.get(String(senderId || '').trim()) || null;
    },
    canonicalEntityIdForMessage(message = {}) {
      const explicit = String(message.senderEntityId || '').trim();
      if (byId.has(explicit)) return explicit;
      const byTelegram = byTelegramId.get(senderIdFromMessage(message));
      if (byTelegram) return byTelegram;
      if (message.senderIsBot === true) {
        const display = String(message.senderDisplayName || message.senderName || '')
          .trim().toLocaleLowerCase();
        if (byBotDisplay.has(display)) return byBotDisplay.get(display);
      }
      return explicit || null;
    },
  });
}

const DEFAULT_SEMANTIC_ENTITY_RESOLVER = createSemanticEntityResolver();
const CANONICAL_ENTITY_NAMES = Object.freeze({});
const KNOWN_TELEGRAM_ENTITY_IDS = Object.freeze({});
const BOT_DISPLAY_PATTERNS = Object.freeze([]);

function semanticEntityResolver(value = null) {
  if (
    value
    && typeof value.canonicalEntityIdForMessage === 'function'
    && typeof value.canonicalTelegramEntityId === 'function'
  ) return value;
  if (Array.isArray(value)) return createSemanticEntityResolver({ entities: value });
  if (Array.isArray(value?.entities)) return createSemanticEntityResolver(value);
  return DEFAULT_SEMANTIC_ENTITY_RESOLVER;
}

function canonicalTelegramEntityId(senderId, resolver = null) {
  return semanticEntityResolver(resolver).canonicalTelegramEntityId(senderId);
}

function canonicalEntityIdForMessage(message = {}, resolver = null) {
  return semanticEntityResolver(resolver).canonicalEntityIdForMessage(message);
}

function canonicalDisplayName(entityId, fallback = null, resolver = null) {
  return semanticEntityResolver(resolver).canonicalDisplayName(entityId, fallback);
}

module.exports = {
  BOT_DISPLAY_PATTERNS,
  CANONICAL_ENTITY_NAMES,
  DEFAULT_SEMANTIC_ENTITY_RESOLVER,
  KNOWN_TELEGRAM_ENTITY_IDS,
  canonicalDisplayName,
  canonicalEntityIdForMessage,
  canonicalTelegramEntityId,
  createSemanticEntityResolver,
  semanticEntityResolver,
  senderIdFromMessage,
  telegramIdsForEntity,
};
