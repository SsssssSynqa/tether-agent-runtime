// SPDX-License-Identifier: Apache-2.0
'use strict';

function normalizeIdentityPolicy(config = {}) {
  const entities = new Map((config.entities || []).map((entity) => [String(entity.entityId), {
    ...entity,
    entityId: String(entity.entityId),
  }]));
  const telegramEntityIds = new Map();
  for (const entity of entities.values()) {
    for (const telegramId of entity.telegramUserIds || []) {
      telegramEntityIds.set(String(telegramId), entity.entityId);
    }
  }
  for (const ownerId of config.owner?.telegramUserIds || []) {
    telegramEntityIds.set(String(ownerId), String(config.owner.entityId));
  }
  return {
    ownerEntityId: String(config.owner?.entityId || ''),
    agentEntityId: String(config.agent?.id || ''),
    canonicalOwnerName: String(config.addressPolicy?.canonicalOwnerName || config.owner?.displayName || 'Owner'),
    disallowedOwnerNames: [...new Set((config.addressPolicy?.disallowedOwnerNames || []).map(String).filter(Boolean))],
    preservedEntityNames: new Set((config.addressPolicy?.preservedEntityNames || []).map(String)),
    entities,
    telegramEntityIds,
  };
}

function entityForTelegramSender(senderId, policy) {
  return policy.telegramEntityIds.get(String(senderId)) || null;
}

function outsideQuotedSegments(text, transform) {
  const value = String(text || '');
  const quotePairs = new Map([['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]);
  let result = '';
  let plain = '';
  let close = null;
  for (const character of value) {
    if (!close && quotePairs.has(character)) {
      result += transform(plain) + character;
      plain = '';
      close = quotePairs.get(character);
      continue;
    }
    if (close && character === close) {
      result += plain + character;
      plain = '';
      close = null;
      continue;
    }
    plain += character;
  }
  return result + (close ? plain : transform(plain));
}

function normalizeOwnerAddress(text, policy) {
  return outsideQuotedSegments(text, (segment) => {
    let result = segment;
    for (const name of policy.disallowedOwnerNames) {
      if (policy.preservedEntityNames.has(name)) continue;
      result = result.split(name).join(policy.canonicalOwnerName);
    }
    return result;
  });
}

function assertAttribution({ sourceSenderEntityId, claimedSpeakerEntityId, evidenceRole = null } = {}) {
  if (
    sourceSenderEntityId
    && claimedSpeakerEntityId
    && String(sourceSenderEntityId) !== String(claimedSpeakerEntityId)
    && evidenceRole !== 'quoted_statement'
  ) {
    const error = new Error('Claimed speaker differs from the source sender');
    error.code = 'TETHER_ATTRIBUTION_MISMATCH';
    throw error;
  }
  return true;
}

module.exports = {
  assertAttribution,
  entityForTelegramSender,
  normalizeIdentityPolicy,
  normalizeOwnerAddress,
  outsideQuotedSegments,
};
