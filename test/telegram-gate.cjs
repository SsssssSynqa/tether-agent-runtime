// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensureGroupGateCommandMenu,
  handleTelegramGateCommand,
  parseTelegramGateCommand,
  readDynamicGroups,
} = require('../runtime/channels/telegram-gate.cjs');
const {
  createDurableUpdateHandler,
  createTelegramChannel,
} = require('../runtime/channels/telegram.cjs');

function update(text, overrides = {}) {
  return {
    update_id: overrides.updateId || 1,
    message: {
      message_id: overrides.messageId || 10,
      text,
      chat: {
        id: overrides.chatId || -77,
        title: overrides.title || 'Test group',
        type: overrides.chatType || 'supergroup',
      },
      from: {
        id: overrides.senderId || 11,
        is_bot: overrides.senderIsBot || false,
      },
    },
  };
}

async function main() {
  assert.equal(parseTelegramGateCommand('/syrah_on', 'syrah'), 'on');
  assert.equal(parseTelegramGateCommand('/Syrah_quiet@Syrah_bot', 'syrah'), 'quiet');
  assert.equal(parseTelegramGateCommand('please /syrah_on', 'syrah'), null);
  assert.equal(parseTelegramGateCommand('/syrah_on now', 'syrah'), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-telegram-gate-'));
  const stateFile = path.join(root, 'dynamic-groups.json');
  const sent = [];
  let menu = [];
  const api = {
    async sendMessage(params) { sent.push(structuredClone(params)); return { ok: true }; },
    async call(method, params) {
      if (method === 'getMyCommands') return { result: structuredClone(menu) };
      if (method === 'setMyCommands') { menu = structuredClone(params.commands); return { result: true }; }
      throw new Error(`unexpected API method ${method}`);
    },
  };
  const staticPolicies = new Map([['-99', { mode: 'mention' }]]);
  let liveDynamic = {};
  const run = (incoming) => handleTelegramGateCommand({
    update: incoming,
    prefix: 'syrah',
    displayName: 'Syrah',
    ownerIds: ['11'],
    staticGroupPolicies: staticPolicies,
    dynamicGroupsPath: stateFile,
    dynamicDefaults: {
      mentionPatterns: ['Syrah', '鹰鹰'],
      maxConsecutiveBotMessages: 6,
    },
    replaceDynamicPolicies(groups) { liveDynamic = structuredClone(groups); },
    api,
    log() {},
  });

  assert.equal(await run(update('/syrah_on')), true);
  assert.equal(readDynamicGroups(stateFile)['-77'].mode, 'mention');
  assert.deepEqual(readDynamicGroups(stateFile)['-77'].mentionPatterns, ['Syrah', '鹰鹰']);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(liveDynamic['-77'].maxConsecutiveBotMessages, 6);

  assert.equal(await run(update('/syrah_all')), true);
  assert.equal(readDynamicGroups(stateFile)['-77'].mode, 'all');
  assert.equal(await run(update('/syrah_quiet@Syrah_bot')), true);
  assert.equal(readDynamicGroups(stateFile)['-77'].mode, 'mention');

  const beforeNonOwner = fs.readFileSync(stateFile, 'utf8');
  assert.equal(await run(update('/syrah_all', { senderId: 22 })), true);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeNonOwner);
  assert.match(sent.at(-1).text, /Synqa/);
  assert.equal(await run(update('/syrah_on', { senderIsBot: true })), false);
  assert.equal(await run(update('/syrah_on', { chatType: 'private', chatId: 11 })), false);

  const beforeStatic = fs.readFileSync(stateFile, 'utf8');
  assert.equal(await run(update('/syrah_off', { chatId: -99 })), true);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeStatic);
  assert.match(sent.at(-1).text, /常驻配置群/);

  assert.equal(await run(update('/syrah_off')), true);
  assert.equal(readDynamicGroups(stateFile)['-77'], undefined);

  fs.writeFileSync(stateFile, '{broken', { mode: 0o600 });
  await assert.rejects(run(update('/syrah_on')), /JSON/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{broken');

  assert.equal(await ensureGroupGateCommandMenu(api, {
    prefix: 'syrah',
    displayName: 'Syrah',
    log() {},
  }), true);
  assert.deepEqual(menu.map((item) => item.command), [
    'syrah_on', 'syrah_off', 'syrah_all', 'syrah_quiet',
  ]);
  assert.equal(await ensureGroupGateCommandMenu(api, {
    prefix: 'syrah',
    displayName: 'Syrah',
    log() {},
  }), false);

  const integrationState = path.join(root, 'integration-groups.json');
  let modelTurns = 0;
  const channel = createTelegramChannel({
    api: {
      ...api,
      async call(method, params) {
        if (method === 'getFile') throw new Error('no attachments expected');
        return api.call(method, params);
      },
    },
    ownerIds: ['11'],
    allowedGroups: {},
    gateCommandPrefix: 'syrah',
    gateCommandDisplayName: 'Syrah',
    dynamicGroupsPath: integrationState,
    registerGateCommandMenu: false,
    offsetStore: { read() { return 0; }, write() {} },
  });
  channel.onMessage(async () => { modelTurns += 1; return { ok: true }; });
  assert.deepEqual(await channel.ingestUpdate(update('/syrah_on', { updateId: 20 })), { control: true });
  assert.equal(modelTurns, 0, 'gate command must not reach the model');
  const normal = update('鹰鹰在吗', { updateId: 21 });
  const prepared = await channel.prepareUpdate(normal);
  assert.equal(prepared?.metadata?.chatId, '-77', 'newly authorized group must pass ingress immediately');

  let inboxReceives = 0;
  const durableControl = createDurableUpdateHandler({
    channel,
    inbox: {
      getState() { return null; },
      receive() { inboxReceives += 1; return true; },
    },
    dispatcher: { async processUpdate() {} },
  });
  assert.deepEqual(
    await durableControl(update('/syrah_off', { updateId: 22 })),
    { control: true },
  );
  assert.equal(inboxReceives, 0, 'gate command must be consumed before durable/model ingress');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('telegram gate tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
