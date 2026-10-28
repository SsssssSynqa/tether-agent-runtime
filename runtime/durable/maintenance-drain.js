// SPDX-License-Identifier: Apache-2.0
'use strict';

// Process-local bookkeeping only. Never consumes a durable queue or cancels work.
function createTaskDrain() {
  const active = new Set();
  function track(value) {
    const task = Promise.resolve(value);
    active.add(task);
    task.then(() => active.delete(task), () => active.delete(task));
    return task;
  }
  async function drain() {
    while (active.size) await Promise.allSettled([...active]);
  }
  return { track, drain, get size() { return active.size; } };
}
const waitUntil = async predicate => {
  while (!predicate()) await new Promise(resolve => setTimeout(resolve, 25));
};
module.exports = { createTaskDrain, waitUntil };
