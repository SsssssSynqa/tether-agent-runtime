# Changelog

All notable changes to Tether are documented here. Versions follow semantic versioning.

## [0.2.0] - 2026-08-23

This release closes the gap between Tether's durable core and the operational behavior required by a continuously running Telegram agent.

### Added

- Persistent global provider circuit breaker. After a configurable number of distinct causal requests exhaust every eligible provider, Tether stops provider calls while continuing to receive and durably preserve Telegram updates. Recovery is explicit and offline; clearing the circuit never replays messages automatically.
- Owner-visible bridge status notifications and a private-turn failure notice, so terminal provider and runtime failures no longer become silent Telegram outages.
- Telegram typing heartbeats, per-sender group rate limits, and consecutive-bot-message caps.
- Configurable first-run backlog handling, timestamped runtime logs, and a startup capability banner.
- A recovery confirmation window for stale runtime heartbeats, reducing false restarts after host sleep or temporary scheduling stalls while retaining restart behavior for persistent hangs.

### Fixed

- Telegram delivery retries now cover transient send failures instead of treating inference success as delivery success.
- Runtime failure logs preserve the original error message and stack for diagnosis.
- Outbound diagnostics redact credential-shaped values before they reach chat or logs.
- Group batches remain ordered after a failed earlier batch.
- Sleep/wake pauses no longer count as Telegram poll stalls.

### Operations

- Added `tether-ops circuit-status` and offline `tether-ops circuit-clear`.
- Added provider-circuit regression coverage and refreshed the exact-byte public export lock.
- Documented a mechanism-by-mechanism public-extraction audit, with owner notifications treated as a first-class operational path.

## [0.1.0] - 2026-08-03

- First public release of the Tether reference runtime: one continuous session across terminal and Telegram, durable causal delivery, layered memory, local tools, supervised recovery, and the read-only Tether Console.

---

## 中文摘要

### 0.2.0 · 2026-08-23

- 接通持久化全局 provider 断路器：可配数量的不同 causal 请求均耗尽全部可用 provider 后，停止新 provider 调用，但 Telegram 仍继续收件和持久化；恢复必须离线人工清闸，清闸不会自动重放消息。
- 补全 owner 状态通知、私聊失败提示、Telegram 发送重试、typing 心跳、群发送者限流和 bot 连发上限。
- 修复首启积压处理、出站凭据遮蔽、错误 message/stack 丢失、休眠唤醒误报 poll stall，并给旧心跳增加恢复确认窗，减少误重启。
- 新增 `tether-ops circuit-status` / `circuit-clear`，补 provider 断路器离线回归，刷新公开导出锁。

### 0.1.0 · 2026-08-03

- Tether 首个公开版本：终端与 Telegram 共用同一连续 session，包含 durable causal 投递、分层记忆、本地工具、supervisor 恢复和只读 Tether Console。
