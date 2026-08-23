// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function normalizeGatePrefix(prefix) {
  const normalized = String(prefix || '').trim().replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  return normalized || 'bot';
}

function parseTelegramGateCommand(text, prefix) {
  const escaped = normalizeGatePrefix(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').trim().match(
    new RegExp(`^\\/${escaped}_(on|off|all|quiet)(?:@\\w+)?\\s*$`, 'i'),
  );
  return match ? match[1].toLowerCase() : null;
}

function readDynamicGroups(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readDynamicGroupsForWrite(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('dynamic groups state must be a JSON object');
  }
  return parsed;
}

function writeDynamicGroups(filePath, groups) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(groups, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const descriptor = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function dynamicPolicy(previous, title, defaults = {}) {
  const configuredDefaults = defaults && typeof defaults === 'object' ? defaults : {};
  return {
    title,
    enabledAt: previous?.enabledAt || new Date().toISOString(),
    enabled: true,
    mode: previous?.mode === 'all' ? 'all' : 'mention',
    mentionPatterns: Array.isArray(previous?.mentionPatterns)
      ? [...previous.mentionPatterns]
      : [...(configuredDefaults.mentionPatterns || [])],
    ownerAlways: previous?.ownerAlways ?? configuredDefaults.ownerAlways ?? true,
    ignoreBotMessages: previous?.ignoreBotMessages ?? configuredDefaults.ignoreBotMessages ?? false,
    maxConsecutiveBotMessages: previous?.maxConsecutiveBotMessages
      ?? configuredDefaults.maxConsecutiveBotMessages
      ?? 6,
  };
}

function gateCommands(prefix, displayName) {
  const normalized = normalizeGatePrefix(prefix);
  const name = String(displayName || normalized);
  return [
    { command: `${normalized}_on`, description: `让 ${name} 在当前群上线` },
    { command: `${normalized}_off`, description: `让 ${name} 在当前群下线` },
    { command: `${normalized}_all`, description: '当前群全局接收' },
    { command: `${normalized}_quiet`, description: '当前群仅点名响应' },
  ];
}

function sameCommands(actual, expected) {
  return JSON.stringify((actual || []).map(({ command, description }) => ({ command, description })))
    === JSON.stringify(expected);
}

async function ensureGroupGateCommandMenu(api, { prefix, displayName, log = console.log } = {}) {
  const scope = { type: 'all_group_chats' };
  const commands = gateCommands(prefix, displayName);
  const current = await api.call('getMyCommands', { scope });
  if (sameCommands(current?.result, commands)) return false;
  await api.call('setMyCommands', { scope, commands });
  const verified = await api.call('getMyCommands', { scope });
  if (!sameCommands(verified?.result, commands)) {
    throw new Error('Telegram group command menu verification failed');
  }
  log(`[tether] repaired Telegram group gate command menu for /${normalizeGatePrefix(prefix)}_*`);
  return true;
}

async function handleTelegramGateCommand({
  update,
  prefix,
  displayName,
  ownerIds,
  staticGroupPolicies,
  dynamicGroupsPath,
  dynamicDefaults,
  replaceDynamicPolicies,
  api,
  log = console.log,
} = {}) {
  const message = update?.message || update?.edited_message;
  const isGroup = ['group', 'supergroup'].includes(message?.chat?.type);
  const action = parseTelegramGateCommand(message?.text || message?.caption || '', prefix);
  if (!message || !isGroup || !action || message.from?.is_bot === true) return false;

  const chatId = String(message.chat.id);
  const senderId = String(message.from?.id ?? '');
  const reply = async (text) => api.sendMessage({
    chat_id: chatId,
    text,
    reply_parameters: {
      message_id: message.message_id,
      allow_sending_without_reply: true,
    },
  });
  if (!new Set((ownerIds || []).map(String)).has(senderId)) {
    log(`[tether] non-owner attempted /${normalizeGatePrefix(prefix)}_${action} chat=${chatId} from=${senderId}`);
    await reply('这条设置指令需要 Synqa 本人来发哦。').catch(() => {});
    return true;
  }

  const groups = readDynamicGroupsForWrite(dynamicGroupsPath);
  const staticPolicy = staticGroupPolicies.get(chatId) || null;
  const existing = groups[chatId] || null;
  const name = String(displayName || normalizeGatePrefix(prefix));
  if (staticPolicy) {
    const messageText = action === 'on'
      ? `${name} 已经在这个常驻群里，无需重复开门。`
      : `这个群是常驻配置群，/${normalizeGatePrefix(prefix)}_${action} 只管理动态开门。`;
    await reply(messageText).catch(() => {});
    return true;
  }

  if (action === 'off') {
    if (existing) {
      delete groups[chatId];
      writeDynamicGroups(dynamicGroupsPath, groups);
      replaceDynamicPolicies(groups);
      log(`[tether] dynamic group disabled chat=${chatId}`);
      await reply(`${name} 已在本群下线。`).catch(() => {});
    } else {
      await reply(`${name} 当前没有在这个群动态上线。`).catch(() => {});
    }
    return true;
  }

  const policy = dynamicPolicy(existing, message.chat?.title || chatId, dynamicDefaults);
  if (action === 'all') policy.mode = 'all';
  if (action === 'quiet') policy.mode = 'mention';
  groups[chatId] = policy;
  writeDynamicGroups(dynamicGroupsPath, groups);
  replaceDynamicPolicies(groups);
  log(`[tether] dynamic group ${action} chat=${chatId} mode=${policy.mode}`);
  const modeText = action === 'all'
    ? `${name} 全局接收已开启，这个群的每条消息都会进入同一条主会话。`
    : action === 'quiet'
      ? `${name} 已切到安静模式——只有 Synqa、点名或回复我的消息才会触发回应。`
      : `${name} 已在本群上线，默认仅点名响应。`;
  await reply(modeText).catch(() => {});
  return true;
}

module.exports = {
  ensureGroupGateCommandMenu,
  gateCommands,
  handleTelegramGateCommand,
  normalizeGatePrefix,
  parseTelegramGateCommand,
  readDynamicGroups,
  writeDynamicGroups,
};
