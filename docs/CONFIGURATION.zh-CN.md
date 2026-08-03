# 配置

English documentation: [CONFIGURATION.md](CONFIGURATION.md).

Tether 使用一份公开的 JSON 配置，外加一份可选的、被 git 忽略的覆盖层。密钥在加载时从环境变量解析。

## 合并顺序

1. 传给 `bin/tether.cjs` 的路径（默认 `./config.json`）。
2. 与该文件同目录的 `config.private.json`（如果存在）。
3. `TETHER_PRIVATE_CONFIG` 指定的文件，它会替换掉默认的覆盖层路径。
4. 每个供应商的 `apiKeyEnv` 解析出来的密钥。

对象递归合并。**数组会整体替换基础数组**，所以私有配置里的 `providers` 数组必须包含所有仍需生效的供应商。

相对形式的 `storage.root` 和 `persona.policyFile`，以公开配置文件所在目录为基准解析。

## Agent 与实体注册表

```json
{
  "agent": { "id": "example-agent", "displayName": "Example Agent" },
  "owner": { "entityId": "example-owner", "displayName": "Example Owner" },
  "entities": [
    { "entityId": "example-owner", "canonicalDisplayName": "Example Owner", "type": "person" },
    { "entityId": "example-agent", "canonicalDisplayName": "Example Agent", "type": "ai" }
  ]
}
```

请使用稳定的、不透明的实体 ID。显示名和别名是呈现层的元数据，**不是身份键**。不要把一个 ID 回收给另一个人或另一个 agent 用。

## 人格策略

`persona.policyFile` 指向一份不进 git 的 Markdown 策略文件。`persona.inlinePolicy` 可用于合成配置或嵌入式配置。加载器会把最终文本作为 system prompt 暴露出去。

公开的人格策略示例里不要放私密历史和个人事实。**策略应当定义行为规则；被记住的事实属于可追溯的记忆层。**

## 称谓策略

`addressPolicy` 声明 owner 的规范显示名、禁用的 owner 别名，以及机械规范化必须保留原样的实体名。**引语文本和命名事件受保护，即便别名映射发生变化也不会被改写。**

## 存储

```json
{
  "storage": { "root": "../private-tether-data" }
}
```

参考 CLI 会写入：

- `session.json` —— 权威会话锚点；
- `memory/transcript.jsonl` —— 只追加的原始消息；
- `memory/summaries.jsonl` —— 带来源消息 ID 的派生摘要；
- `memory/cards/cards.jsonl` —— 带来源消息 ID 的派生卡片。

更外围的记忆层与 Console 层可以使用各自独立的 fold、card、semantic 根目录。请把所有数据根目录放在仓库之外，收紧权限，并按敏感数据来备份。

## 运行时

- `runtime.allowInitialSessionCreate`：仅针对进程边界上的**初次创建**的显式授权。CLI 会在接入通道之前打开会话，并且只在不存在任何原始记录、摘要、卡片或因果日志权威时，才创建锚点。锚点缺失但上述任一权威仍在，或者存储的恢复失败，都保持 fail-closed。
- `runtime.rawTailMessages`：编译进模型上下文的最近原始记录条数上限。默认 `40`；设为 `0` 表示这一层不进上下文，但不会删除来源记录。
- `runtime.summaryLimit`：编译进模型上下文的最新派生摘要条数上限。默认 `20`；`0` 表示略过这一层。
- `runtime.cardLimit`：在只选取每个逻辑 `(cardType, period.key)` 卡片的最新版本之后，编译进模型上下文的日卡/周卡条数上限。默认 `20`；`0` 表示略过这一层。被选中的卡片以 system 上下文注入。

这三个上下文上限都是非负整数计数。它们**只**约束推理输入，不会截断或改写那些只追加的文件。CLI 在其整个生命周期内还会持有 `storage.root/.tether-instance.lock`，因此两个运行时不能并发拥有同一个存储根目录。

## 供应商

初始适配器接受一个有序的 `providers` 数组。支持的字段：

- `id`：供应商链中的稳定标识；
- `label`：给运营者看的描述；
- `adapter`：目前是 `openai-compatible`；
- `baseUrl`：完整的 chat-completions 端点。远程端点必须用 HTTPS。纯 HTTP 只对 loopback 主机开放：`localhost`、`127.0.0.0/8` 和 `::1`；
- `apiKeyEnv`：存放内置 bearer 认证所用密钥的环境变量；
- `authentication`：设为 `none` 可关闭内置 bearer 认证——用于无需认证的端点，或认证完全由 `headerEnv` 提供的场合；
- `model`：供应商侧的模型标识；
- `headers`：可选的、非密钥的附加 header；
- `headerEnv`：可选映射，把自定义的密钥 header 名映射到存放其值的环境变量；
- `timeoutMs`：可选的单供应商超时。

供应商 URL 中**不得**含有 URL userinfo（`username:password@host`），也不得含有常见的凭据查询参数，例如 `api_key`、`key`、`token`、`access_token`、`auth`、`authorization`、`secret`、`password`、`signature` 或 `sig`。**即使该 URL 本身用的是 HTTPS，这条规则同样适用。**

内联的 `provider.apiKey` 会被拒绝。在普通 `headers` 里，形似凭据的名字——`Authorization`、`X-API-Key`、`*-Token`、`*Secret*`、`*Password*`、`*Credential*`——同样会被拒绝；以 `Bearer` 或 `Basic` 开头的值也会被拒绝。请把普通的非密钥元数据留在 `headers` 里，所有密钥都从环境解析。需要供应商专有的认证 header 时，这样写：

```json
{
  "headers": {
    "X-Client-Version": "tether-example"
  },
  "headerEnv": {
    "X-Provider-Token": "PROVIDER_TOKEN"
  }
}
```

`headerEnv` 把 HTTP header 名映射到环境变量名，**它本身永远不含凭据值**。被引用的环境变量缺失时启动会失败，同一个 header 名也不能同时出现在 `headers` 和 `headerEnv` 里。内置 bearer 认证用 `apiKeyEnv`。如果某个供应商只靠自定义 header 认证，把 `authentication` 设为 `"none"` 关掉内置 bearer 要求，并在 `headerEnv` 里声明那些密钥 header。适配器按顺序尝试各个供应商，返回第一个非空的补全结果。**切换供应商不会改变 `agent.id`、会话状态或记忆权威。**

公开示例使用保留域名 `.invalid`，因此它永远不可能意外打到一个真实服务上。

## Telegram

配置 schema 保留了这些字段：

- `telegram.enabled`：在共享的 CLI 进程里接入实时长轮询；
- `telegram.tokenEnv`：环境变量名；
- `telegram.allowedGroups`：显式的群配置；
- `telegram.noReplyGroupIds` 与 `telegram.rateLimitedGroupIds`：投递行为；
- `telegram.rateLimitStateDir`：群发送节奏的持久化状态目录。

`owner.telegramUserIds` 定义了 Telegram 私聊中**唯一**被接受的发送者。群 chat ID 是 `telegram.allowedGroups` 的 key；不存在被隐式接受的群。内联的 `telegram.token` 是被禁止的。

启用之后，CLI 会启动实时 `getUpdates` 轮询，并把 Telegram 接入与终端**完全相同**的运行时和会话状态。它会在每条 update 处理完成或被安全忽略之后，把 `telegram-offset.txt` 写到 `storage.root` 下面。**备份和恢复时，请把这个 offset 和会话、原始记忆放在一起。** 适配器会拒绝超过 Telegram 4096 字符原子上限的输出，而不是把一条已提交的响应拆成几次含义不明的投递。

## Tether Console 的环境变量

- `TETHER_MEMORY_ROOT`：公共记忆根目录；
- `TETHER_FOLD_DIR`：可选，覆盖 fold/摘要根目录；
- `TETHER_CARD_DIR`：可选，覆盖卡片根目录；
- `TETHER_SEMANTIC_DIR`：可选，覆盖语义记忆根目录；
- `TETHER_CONSOLE_STATIC_DIR`：构建好的前端目录；
- `TETHER_CONSOLE_HOST`：监听主机，默认 `127.0.0.1`；
- `TETHER_CONSOLE_PORT`：监听端口，默认 `8431`。

前端开发服务器使用 `127.0.0.1:5187`，并把 `/api` 代理到 `127.0.0.1:8431` 的后端。
