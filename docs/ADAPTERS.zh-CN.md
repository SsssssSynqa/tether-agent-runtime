# 适配器契约

English documentation: [ADAPTERS.md](ADAPTERS.md).

Tether 的 adapter 是围绕唯一权威 runtime 的可替换边界。接入另一个 API 或通道时，不能顺手创建第二条人格 session、transcript 或派生记忆根。

## Provider adapter

runtime 要求一个异步 `respond`：

```js
const provider = {
  async respond({ messages, purpose, sourceParts, causalId, toolContext }) {
    return {
      text: 'synthetic response',
      providerId: 'example-provider',
      model: 'example-model',
      purpose,
      finishReason: 'stop'
    };
  }
};
```

标准 runtime 会传完整编译消息。`purpose` 区分普通对话、fold、card、语义提取/修复/审计、语义验证和高风险验证；`sourceParts` 携带规范化附件；`causalId` 与 `toolContext` 让 adapter 可以记录工具循环意图，而不另造会话身份。

支持 embedding 的 adapter 还暴露：

```js
const result = await provider.embed({
  texts: ['verified memory text'],
  purpose: 'memory-embedding'
});
// { vectors: [[...]], providerId, model }
```

adapter 应统一供应商各自的请求/响应、工具调用、流式、用量、超时和错误格式，保留 provider/model/purpose 出处，且不能把供应商 conversation ID 当作唯一身份锚点。

### 内置 OpenAI-compatible adapter

`runtime/providers/openai-compatible.cjs` 支持：

- 有序 provider 回落链；
- 按用途选择模型与输出 token 上限；
- Chat Completions 消息；
- 有界图片 data URL；
- 串行、有界的 tool-call loop；
- Embeddings 请求；
- 仅环境变量 bearer 或自定义 header 凭据；
- 远程 HTTPS、仅 loopback HTTP。

provider 回落只是在同一 session 与同一份编译上下文周围切换 API。空响应或可安全拒绝的结果可以尝试下一家；工具请求可能已经到达供应商、但没有 durable 响应证明结果时，adapter 会发出只能人工处理的歧义，而不是自动重新推理。

## Channel adapter

最小结构：

```js
const channel = {
  id: 'example-channel',
  onMessage(handler) {
    // 保存唯一 handler，并用规范化入站调用它。
  },
  async send(message) {
    // 投递已经提交的响应。
  }
};
```

规范化入站建议包含：

```js
{
  messageId: 'stable-channel-event-id',
  text: 'message text',
  metadata: {
    source: 'example-channel',
    trustZone: 'private',
    senderId: 'opaque-sender-id',
    senderEntityId: 'optional-canonical-entity',
    senderDisplayName: 'Display Name',
    chatId: 'opaque-conversation-address',
    owner: true,
    isGroup: false,
    receivedAt: '2030-01-01T00:00:00.000Z'
  },
  sourceParts: []
}
```

`messageId` 必须在重试间稳定。runtime 会在推理前从 channel + message ID 建立因果身份。metadata 用于授权、归属、投递和按接收方区分 prompt/output，绝不能用来选择另一份人格历史。

可选方法包括 `initialize`、`start`、`stop`、`historyAssistantText`。live channel 不能在 session 打开前开始 polling。本地 cursor、reply target、rate limit、格式化和附件下载属于 adapter；人格身份不属于它。

## Durable channel 边界

生产通道不止要满足最小接口，还要：

1. 认证入站；
2. 推理前持久化接受稳定来源事件；
3. 保留顺序与重复事件身份；
4. 区分已提交输出和投递确认；
5. 传输状态不明时重放精确 committed bytes；
6. 暴露 retry、pause、dead-letter；
7. 把按接收方的输出控制放在共享上下文之外。

传输层没有稳定 event ID 时，adapter 必须定义并记录一个确定性等价物，不能每次重试随机生成新 ID。

## Telegram 实现

内置 Telegram 边界包含：

- owner-only 私聊与显式白名单群；
- 群 `mention` / `all` 模式；
- atomic offset 的 durable `getUpdates`；
- update 精确重放与 edited-message 因果身份；
- durable 群批处理与校验过的多回复 JSON 信封；
- reply target 消失时不重新生成的降级发送；
- 长回复确定性切片；
- 群 no-reply/rate-limit 行为与 reaction 白名单；
- 有界图片/文件下载、脱敏来源元数据与私有附件存储。

`telegram:update:<update_id>` 是稳定规范化身份。规范化 metadata 会保留用于回复投递的 `telegramMessageId`，并把 `updateKind` 记为 `message` 或 `edited_message`。Telegram edit 会产生新 `update_id`，所以即使 `telegramMessageId` 不变，它也是新的只追加事件。

自定义 Telegram API base 除 loopback 外必须用 HTTPS，并且不能含凭据、query 或 fragment。

## 工具适配器边界

只有当前通道策略允许时，内置 tool runtime 才会把定义暴露给 provider。替换实现必须保留：

- 稳定 operation ID 与 contract hash；
- 执行前的 root/capability 授权；
- 任何副作用前先写 durable intent；
- 精确审批范围；
- 原子或可证明的后置条件；
- 状态不明副作用的 fail-closed 处理；
- workspace 不能触达连续性存储。

不能靠传一份裁剪或独立人格历史来解决能力差异。

## 接入另一种 Provider API

1. 按上方规范实现 `respond` 与可选 `embed`。
2. 为每个 purpose 显式映射模型/配置。
3. 区分可安全回落和推理状态不明。
4. 保留输出出处与 tool-call ID。
5. 增加配置校验和环境变量密钥处理。
6. 增加合成测试，证明 provider 故障不改变 Agent/session，也不重复工具副作用。

## 接入另一个通道

1. 认证 sender/address。
2. 定义稳定 source-event ID 与 durable cursor。
3. 带归属 metadata 规范化消息/附件。
4. 在 session open 之后接入现有 `TetherRuntime`。
5. 分开记录 committed output 与 delivery ack。
6. 增加 exact replay、backoff、pause/dead-letter 与按接收方输出。
7. 与 terminal/Telegram 并列测试，证明它们共享同一 transcript 与 session proof。

## 一致性测试

每个新 adapter 都应增加合成的接受/拒绝路径：

- adapter 故障与回落前后 Agent/session/transcript proof 不变；
- 重复入站只有一次推理；
- 投递确认丢失后精确重放；
- reply target 消失时安全降级；
- 附件大小/类型/路径边界；
- 诊断不含密钥；
- 默认测试不发 live network；
- 相同 context digest 上的工具能力差异；
- 推理或外部副作用歧义时停下来等待人工。
