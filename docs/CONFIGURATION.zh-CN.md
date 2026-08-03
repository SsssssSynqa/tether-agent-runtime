# 配置

English documentation: [CONFIGURATION.md](CONFIGURATION.md).

[`config.example.json`](../config.example.json) 是规范参考。Tether 读取一份公开 JSON 配置，合并一份被忽略的本机覆盖层，以公开配置所在目录解析路径，再从环境变量解析密钥。

## 合并与路径规则

加载顺序：

1. 传给 CLI 的配置路径（默认 `./config.json`）；
2. 同目录的 `config.private.json`（如果存在）；
3. 设置 `TETHER_PRIVATE_CONFIG` 时，用它指定的路径替代默认覆盖层；
4. 供应商与 Telegram 凭据从各自命名的环境变量解析。

对象递归合并，数组整体替换。因此覆盖层中的 `providers` 或 `entities` 数组，必须重复列出所有仍需生效的条目。

下面这些路径都以公开配置文件所在目录为基准解析：

- `storage.root`；
- `persona.policyFile`；
- `tools.workspaceRoots[*].path`；
- `telegram.rateLimitStateDir`；
- `telegram.attachmentDirectory`。

## 身份、实体与人格策略

```json
{
  "agent": { "id": "example-agent", "displayName": "Example Agent" },
  "owner": {
    "entityId": "example-owner",
    "displayName": "Example Owner",
    "telegramUserIds": ["OWNER_TELEGRAM_ID"]
  },
  "persona": { "policyFile": "./persona-policy.private.md" },
  "entities": [
    { "entityId": "example-owner", "canonicalDisplayName": "Example Owner", "type": "person" },
    { "entityId": "example-agent", "canonicalDisplayName": "Example Agent", "type": "ai" }
  ]
}
```

请使用稳定、不透明的 ID，绝不要把一个 ID 回收给另一个人或 Agent。显示名、别名、Telegram ID 和 bot 名只是解析元数据，不是身份键。`session.json` 与存储标记都绑定 `agent.id`。

`persona.policyFile` 应当保持不被跟踪；`persona.inlinePolicy` 仅用于合成或嵌入配置。行为策略写在这里，被记住的事实进入可追溯记忆。

`addressPolicy` 声明：

- `canonicalOwnerName`；
- 普通卡片叙述中禁止使用的 `disallowedOwnerNames`；
- 可选的 `semanticDisallowedOwnerNames`；
- `preservedEntityNames`。

规范化会保留来源可核对的引语与明确命名事件，不做盲目的 split/join 替换。

## 连续性存储

```json
{
  "storage": { "root": "/srv/tether/state" },
  "runtime": {
    "allowInitialSessionCreate": true,
    "maintenanceIntervalMs": 30000,
    "maintenanceActiveDelayMs": 250,
    "maintenanceErrorBaseDelayMs": 30000,
    "maintenanceErrorMaxDelayMs": 3600000
  }
}
```

`storage.root` 中包含 session anchor、存储版本标记、健康状态、Telegram offset/inbox/附件、因果与工具日志，以及完整 `memory/` 树。请放在源码仓库之外，并使用最小权限。

`allowInitialSessionCreate` 只授权在空权威根中创建第一个锚点，不是替换丢失或失败 session 的许可。既有无版本数据必须在 runtime 与 supervisor 都停止时运行 `tether-ops migrate`。

维护时间控制进程内记忆 worker：

- `maintenanceIntervalMs`：无工作时的检查周期；
- `maintenanceActiveDelayMs`：有工作继续处理时的延迟，可为零；
- `maintenanceErrorBaseDelayMs` / `maintenanceErrorMaxDelayMs`：指数错误退避边界。

标准分层 CLI 使用下方 `memory` 里的水位。`TetherRuntime` 作为库与旧 `AppendOnlyMemory` 嵌入时仍接受 `rawTailMessages`、`summaryLimit`、`cardLimit`，但它们不是标准分层记忆的控制项。

## 分层记忆

```json
{
  "memory": {
    "activeSoftTokenWatermark": 36000,
    "activeTargetTokenWatermark": 24000,
    "roundHardLimit": 120,
    "minimumRawTailRounds": 8,
    "summaryHistoryLimit": 64,
    "contextTokenBudget": 180000,
    "recentWeekCount": 4,
    "time": {
      "timezoneOffsetMinutes": 0,
      "cutoffHour": 6,
      "forceHour": 12,
      "quietMinutes": 45,
      "displayLabel": "configured local time"
    },
    "cards": { "enabled": true, "policy": "lossless" },
    "semantic": {
      "mode": "cards",
      "manifestMaxRecords": 50,
      "manifestMaxBytes": 8388608,
      "embeddings": { "enabled": false }
    }
  }
}
```

### 活跃上下文

- `activeSoftTokenWatermark`：估算 token 超过此值后开始折叠；
- `activeTargetTokenWatermark`：折叠目标，不得高于软水位；
- `roundHardLimit`：轮次数安全硬顶；
- `minimumRawTailRounds`：活跃历史里至少保留的最近原始轮次；
- `summaryHistoryLimit`：活跃 `history.json` 保留的独立摘要数；更旧摘要进入只追加归档；
- `foldSummaryMaxChars`：可选的 fold 候选长度上限，默认 `1500`；
- `contextTokenBudget`：卡片/语义编译共享预算；
- `recentWeekCount`：周卡与周投影考虑的已结束周数量。

旧兼容字段 `historyTokenBudget`、`roundsBudget`、`hardTokenCap` 仍能被 `ConversationHistory` 读取；新部署优先使用 active watermarks 与 hard round limit。

### 运行日策略

- `timezoneOffsetMinutes`：相对 UTC 的固定偏移，范围 `-840..840`；
- `cutoffHour`：本地记忆日换日小时；
- `quietMinutes`：自然结算前需要的静默时长；
- `forceHour`：最晚强制结算边界，按运行日时间线计，不能早于 `cutoffHour`；
- `displayLabel`：生成上下文中展示的时间标签。

固定偏移是为了确定性。处于夏令时地区、又在意本地墙钟对齐的运营者，需要在时区偏移变化时自行更新它。

### 卡片

`cards.enabled: false` 会关闭自动卡片生成，但不会删除旧卡。`cards.policy` 可选：

- `pending`：只把 coverage 记为 pending，不请求模型生成；
- `relational`：保留关系意义、边界、变化与修复，不复述无必要的亲密动作细节；
- `lossless`：不按内容降级，保留足以恢复因果与偏好边界的具体事实。

### 语义模式

- `off`：关闭；
- `shadow`：可以派生和检查，但不注入；
- `cards`：注入已验证的语义卡片/投影；
- `full`：再允许已验证语义 fold 参与活跃折叠。

`manifestMaxRecords` 与 `manifestMaxBytes` 限制 compile-manifest 日志。语义队列、断言、事件、投影、packet review 与 patch 仍然是彼此独立、保留出处的记录。

### Embeddings

启用 `memory.semantic.embeddings.enabled: true` 时，至少一个 provider 必须同时配置 `embeddingsUrl` 与 `embeddingModel`。

- `batchSize`（默认 `32`）；
- `topK`（默认 `6`）；
- `minScore`（默认 `0.25`，范围 `-1..1`）；
- `maxEmbeddingChars`（每个文档默认 `12000`）；
- `maxRetrievedChars`（召回文本总量默认 `2000`）；
- `maxBytes`（日志硬顶默认 `67108864`）。

向量故障会退回普通分层卡片。启用或更换 embedding 后，离线运行 `tether-memory backfill-vectors`。

## 供应商

`providers` 是有序回落链。内置适配器目前要求 `adapter: "openai-compatible"` 和完整的 Chat Completions URL。

| 字段 | 含义 |
|---|---|
| `id`, `label` | 稳定机器 ID 与运营者可读标签 |
| `baseUrl`, `model` | Chat Completions 端点与默认模型 |
| `apiKeyEnv` | 内置 bearer 认证使用的环境变量 |
| `authentication: "none"` | 为无认证端点或自定义 header 认证关闭内置 bearer |
| `headers` | 只能放非密钥静态 header |
| `headerEnv` | 把密钥 header 名映射到环境变量名 |
| `timeoutMs` | 单供应商请求超时 |
| `foldModel`, `memoryModel` | 可选的 fold 与日/周卡模型 |
| `semanticExtractorModel` | 可选的提取/修复/审计模型 |
| `semanticVerifierModel` | 可选验证模型 |
| `semanticHighRiskModel` | 可选高风险验证模型 |
| `maxTokens` 与各类 `*MaxTokens` | 可选的用途级输出上限 |
| `imageInput` | `data-url`、`metadata-only` 或 `reject` |
| `maxImageParts` | 单次供应商请求最多图片数 |
| `embeddingsUrl`, `embeddingModel` | embedding 必须成对配置 |
| `embeddingDimensions`, `embeddingTimeoutMs` | 可选的 embedding 控制项 |

用途模型回落是确定性的：高风险语义 → verifier → 默认；语义提取 → memory → fold → 默认；记忆卡 → fold → 默认；fold → 默认。

远程 URL 必须使用 HTTPS。只有 `localhost`、`127.0.0.0/8`、`::1` 可以用 HTTP。URL userinfo 与疑似凭据 query 会被拒绝。内联 `apiKey`、普通 header 中的凭据名、以 `Bearer` 或 `Basic` 开头的普通 header 值也会被拒绝。引用的环境变量缺失时启动失败。

适配器按顺序尝试供应商，接受第一个有效非空 completion。供应商回落不会改变 session 或身份。状态不明的工具调用推理会人工暂停，不会自动重复。

## 本地工具

```json
{
  "tools": {
    "enabled": true,
    "maxIterations": 5,
    "maxReadBytes": 524288,
    "maxWriteBytes": 1048576,
    "maxDirectoryEntries": 200,
    "workspaceRoots": [
      { "id": "workspace", "path": "/srv/tether/workspace" }
    ],
    "policies": {
      "terminal": { "read": "allow", "write": "allow" },
      "telegramPrivate": { "read": "allow", "write": "approval" },
      "telegramGroup": { "read": "deny", "write": "deny" },
      "default": { "read": "deny", "write": "deny" }
    }
  }
}
```

root ID 必须匹配 `[a-z][a-z0-9_-]{0,63}` 且唯一。root path 与 `storage.root` 在两个方向上都必须物理分离。符号链接、路径穿越、隐藏组件、疑似凭据名称和越界路径都会被拒绝。

每个已识别通道域里的 read/write 分别选择 `allow`、`approval`、`deny`。缺失的域或能力会沿 `default` 回落，最终默认拒绝。`maxIterations` 限制单次 provider tool loop。

## Telegram

核心字段：

- `enabled`、`tokenEnv`；
- 以 chat ID 为 key 的 `allowedGroups`；
- `pollTimeoutSeconds`、`pollRetryDelayMs`；
- durable retry：`retryIntervalMs`、`maxAttempts`、`retryBaseMs`、`retryMaxMs`、`durableInboxMaxBytes`；
- 附件：`attachmentDirectory`、`maxImageBytes`、`maxFileBytes`、`maxFilePreviewChars`、`maxQuotedChars`；
- 群回复：`groupMaxReplies`、`groupAllowedReactions`、`groupRepairAttempts`、`groupMaxPendingMessages`、`groupBatchTiming`；
- 投递控制：`noReplyGroupIds`、`rateLimitedGroupIds`、`rateLimitStateDir`。

`owner.telegramUserIds` 是私聊白名单。内联 `telegram.token` 被禁止。

每个群条目支持：

- `enabled`；
- `mode`：`mention` 或 `all`；
- `mentionPatterns`：用于 mention 匹配的非空字符串；
- `ownerAlways`；
- `ignoreBotMessages`。

长输出会确定性切成 Telegram 安全片段，只有第一片保留 reply target。update offset、durable inbox、群批次、附件元数据、已提交响应与投递确认都保存在连续性根下。

## 进程监督

```json
{
  "supervision": {
    "heartbeatIntervalMs": 5000,
    "monitorIntervalMs": 5000,
    "heartbeatStaleMs": 30000,
    "readyTimeoutMs": 60000,
    "restartBaseMs": 1000,
    "restartMaxMs": 60000,
    "restartWindowMs": 300000,
    "maxRestartsPerWindow": 8,
    "shutdownGraceMs": 15000
  }
}
```

所有字段都是正整数。`heartbeatStaleMs` 至少等于 heartbeat + monitor interval，`readyTimeoutMs` 必须大于 heartbeat interval，`restartMaxMs` 不能小于 `restartBaseMs`。

这些设置管理的是子 runtime supervisor。宿主机 service manager 可以监督 `tether-supervisor`，但不能另行启动第二个指向同一根目录的子 runtime。

## Tether Console 环境变量

- `TETHER_MEMORY_ROOT`：常规公共 memory 根；
- `TETHER_FOLD_DIR`、`TETHER_CARD_DIR`、`TETHER_SEMANTIC_DIR`：可选的分层覆盖路径；
- `TETHER_CONSOLE_STATIC_DIR`：构建好的前端目录；
- `TETHER_CONSOLE_HOST`：默认 `127.0.0.1`；
- `TETHER_CONSOLE_PORT`：默认 `8431`。

前端开发服务器使用 `127.0.0.1:5187`，把 `/api` 代理到 `127.0.0.1:8431`。除非另加独立的认证与加密访问层，否则保持 loopback。
