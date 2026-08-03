// SPDX-License-Identifier: Apache-2.0
'use strict';

function createPerKeySequencer() {
  const tails = new Map();

  function run(key, operation) {
    const normalizedKey = String(key);
    const previous = tails.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const settledTail = current.then(() => undefined, () => undefined);
    tails.set(normalizedKey, settledTail);
    settledTail.then(() => {
      if (tails.get(normalizedKey) === settledTail) tails.delete(normalizedKey);
    });
    return current;
  }

  return {
    run,
    pendingKeys: () => [...tails.keys()],
  };
}

module.exports = { createPerKeySequencer };
