// SPDX-License-Identifier: Apache-2.0
'use strict';

function unsupported() {
  const error = new Error('Heartbeat publication origins are not part of the public Tether runtime');
  error.code = 'TETHER_HEARTBEAT_PUBLICATION_UNSUPPORTED';
  throw error;
}

function hasOriginPayload(entry) {
  return entry?.state === 'heartbeat-publication-origin'
    || entry?.state === 'heartbeat-publication-origin-snapshot'
    || entry?.heartbeatPublicationOrigin !== undefined
    || entry?.heartbeatPublicationOrigins !== undefined;
}

function validateOriginEntry(entry) {
  if (hasOriginPayload(entry)) unsupported();
  return [];
}

module.exports = {
  captureForegroundOrigin: unsupported,
  makeOrigin: unsupported,
  stablePlan: unsupported,
  validateOriginEntry,
};
