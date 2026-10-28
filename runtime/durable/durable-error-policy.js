// SPDX-License-Identifier: Apache-2.0
'use strict';

const DEFAULT_PROVIDER_RETRY_AFTER_MS = 5 * 60 * 1000;

const PROVIDER_BALANCE = /(?:insufficient (?:account )?balance|account balance.{0,20}(?:insufficient|too low)|预扣费额度失败|用户剩余额度|(?:账户|账号|余额).{0,12}(?:不足|耗尽)|余额(?:不足|耗尽))/i;
const PROVIDER_QUOTA = /(?:quota (?:exhausted|exceeded|limit)|(?:配额|调用额度|api\s*额度).{0,12}(?:用尽|耗尽|不足|超限|超出))/i;
// 补「暂无可用服务容量」「所有服务账号均已不可用」两句站点文案，它们是站点没容量，
// 不是这条消息的问题；原来按普通失败处理，白白烧掉重试次数后进 failed / 死信。
// 再补三句站点没容量的文案（WAA Worker 暂不可用、All available accounts exhausted、auth_unavailable）。
const PROVIDER_UNAVAILABLE = /(?:无可用渠道|no available (?:provider|channel)|all (?:providers|channels).{0,24}(?:failed|unavailable)|distributor.{0,32}(?:failed|unavailable|empty)|渠道.{0,12}(?:不可用|全部失败|耗尽)|暂无可用(?:服务)?容量|所有服务账号.{0,6}不可用|no (?:available )?capacity|capacity.{0,16}(?:unavailable|exhausted)|worker.{0,8}暂不可用|all available accounts? (?:are )?exhausted|auth_unavailable)/i;

function providerCapacityCategory(error) {
  const message = String(error?.message || error || '');
  if (PROVIDER_BALANCE.test(message)) return 'provider_balance';
  if (PROVIDER_QUOTA.test(message)) return 'provider_quota';
  if (PROVIDER_UNAVAILABLE.test(message)) return 'provider_unavailable';
  return null;
}

function classifyDurableError(error) {
  if (error?.deliveryOutcome === 'unknown' || error?.deliveryUnknown) {
    if (error?.holdDeliveryUnknown === true) {
      return { action: 'delivery-held', category: 'telegram_delivery_unknown_held' };
    }
    return {
      action: 'delivery-unknown',
      category: 'telegram_delivery_unknown',
      retryAfterMs: Number(error?.retryAfterMs) || DEFAULT_PROVIDER_RETRY_AFTER_MS,
    };
  }
  if (['TETHER_INFERENCE_AMBIGUOUS', 'TETHER_DELIVERY_AMBIGUOUS'].includes(error?.code)) {
    return { action: 'operator-pause', category: 'causal_ambiguity' };
  }
  if (error?.manualRetryOnly) return { action: 'operator-pause', category: 'manual_retry_only' };
  if (error?.circuitOpen || error?.pauseRetry) {
    return {
      action: 'pause',
      category: error?.circuitOpen ? 'circuit_open' : 'explicit_pause',
      retryAfterMs: error?.retryAfterMs,
    };
  }
  if (Number(error?.retryAfter) > 0 || Number(error?.status) === 429) {
    return {
      action: 'pause',
      category: 'telegram_rate_limit',
      retryAfterMs: Math.max(1000, Number(error?.retryAfter) * 1000 || DEFAULT_PROVIDER_RETRY_AFTER_MS),
    };
  }
  const providerCategory = providerCapacityCategory(error);
  if (providerCategory) {
    return {
      action: 'pause',
      category: providerCategory,
      retryAfterMs: Number(error?.retryAfterMs) || DEFAULT_PROVIDER_RETRY_AFTER_MS,
    };
  }
  return { action: 'fail', category: 'ordinary_failure' };
}

function applyDurableFailure(inbox, updateId, error) {
  const policy = classifyDurableError(error);
  if (policy.action === 'delivery-held') return inbox.markDeliveryHeld(updateId, error);
  if (policy.action === 'operator-pause') return inbox.markOperatorPaused(updateId, error);
  if (policy.action === 'delivery-unknown') {
    return inbox.markDeliveryUnknown(updateId, error, policy.retryAfterMs);
  }
  if (policy.action === 'pause') return inbox.markPaused(updateId, error, policy.retryAfterMs);
  return inbox.markFailed(updateId, error);
}

module.exports = {
  DEFAULT_PROVIDER_RETRY_AFTER_MS,
  applyDurableFailure,
  classifyDurableError,
  providerCapacityCategory,
};
