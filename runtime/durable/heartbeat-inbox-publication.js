// SPDX-License-Identifier: Apache-2.0
'use strict';

function unsupported() {
  const error = new Error('Heartbeat publication journals are not part of the public Tether runtime');
  error.code = 'TETHER_HEARTBEAT_PUBLICATION_UNSUPPORTED';
  throw error;
}

function hasPublicationPayload(entry) {
  return ['heartbeat-publication-ready', 'heartbeat-publication-event', 'heartbeat-publication-reconciled']
    .includes(entry?.state)
    || entry?.heartbeatPublication !== undefined
    || entry?.heartbeatPublications !== undefined
    || entry?.heartbeatPublicationReconciliation !== undefined
    || entry?.heartbeatPublicationLegacyPending !== undefined;
}

function validatePublicationEntry(entry) {
  if (hasPublicationPayload(entry)) unsupported();
  return [];
}

class InboxPublicationStore {
  constructor() { unsupported(); }
}

module.exports = {
  InboxPublicationStore,
  nextRecord: unsupported,
  validatePublicationEntry,
};
