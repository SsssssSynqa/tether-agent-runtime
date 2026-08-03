# 快速上手

English documentation: [GETTING_STARTED.md](GETTING_STARTED.md).

本指南启动公开参考运行时，接入终端；启用之后，也接入实时的 Telegram 长轮询。两个通道连的是同一个 `TetherRuntime` 和同一个 `SelfsameSession`——**永远不要为每个通道各起一个人格运行时**。

## 1. 安装前置依赖

- Node.js 20 或更新版本
- Python 3.11 或更新版本（如果要用 Tether Console）
- pnpm 9 或更新版本（如果要开发 Console 前端）

运行时没有任何 npm 运行时依赖。先把离线检查跑一遍：

```bash
npm test
npm run verify:export
node scripts/probe-selfsame-protocol.cjs
scripts/check-public-snapshot
```

## 2. 准备不进 git 的配置

```bash
cp config.example.json config.json
cp persona-policy.example.md persona-policy.private.md
cp examples/config.private.example.json config.private.json
```

`config.json`、`config.private.json` 和 `persona-policy.private.md` 是本地运行文件。在往里放凭据或私密人格材料之前，**先确认它们确实没有被 git 跟踪**。

改好供应商 URL 和模型。密钥放在 `apiKeyEnv` 指定的那个环境变量里：

```bash
export PRIMARY_API_KEY='set-this-locally'
```

代码不会自动解析 `.env`；请用 shell、凭据管理器、容器密钥或进程管理器注入。供应商凭据只走环境变量：`provider.apiKey` 会被拒绝，每个需要认证的供应商都必须声明 `apiKeyEnv`。供应商专有的密钥 header 用 `headerEnv`，它把 header 名映射到环境变量名。不要把凭据放进 `baseUrl` 或普通 `headers`；远程供应商 URL 必须用 HTTPS，HTTP 只保留给 loopback 的开发端点。

把 `storage.root` 设成源码目录之外的一个私有目录。Tether 会在那里创建 `session.json` 和 `memory/` 子树，并在操作系统支持的地方使用受限的文件权限。

## 3. 先弄清楚第一次会话是怎么创建的

`runtime.allowInitialSessionCreate: true` 是一个显式授权：**只有当数据根目录里不存在任何既有权威时**，才允许创建初始的权威会话。一旦 `session.json` 存在，恢复它失败就是 fail-closed——运行时不会去调用创建回调、造一个替代品出来。

在更换 agent 身份或会话适配器之前，先备份数据根目录。删掉 `session.json` 不是一次普通的重置，也不该被说成是"延续"。

启动时，参考 CLI 会为 `storage.root` 取得一把单实例锁，并在接入终端或 Telegram 之前**恰好调用一次** `session.open`。当锚点不存在时，`allowInitialSessionCreate: true` 只在原始记录、摘要、卡片和因果日志全都为空的情况下，才允许启动阶段创建它。所以 Telegram 从一开始就可以启用——在这次进程边界的引导之后，第一条输入完全可以来自 Telegram。

如果 `session.json` 丢了，而任何原始、派生或因果权威还在，启动会 fail-closed。请从备份恢复那个权威锚点；**不要**删掉剩下的数据，也不要造一个替代品然后管它叫延续。当第一个实例持有 `.tether-instance.lock` 时，第二个指向同一个 `storage.root` 的运行时同样会失败。

## 4. 启动这条共享的运行时

```bash
node bin/tether.cjs ./config.json
```

或者：

```bash
npm start
```

标准输入里敲的每一行都会成为一条终端通道消息，供应商的回复打印到标准输出。公开的这个 CLI 刻意做得很小；生产级的进程管理和真实凭据，归运营者自己掌握。

## 5. 让 Telegram 接进同一条会话

在 `config.json` 里设置 owner 身份和 telegram 段：

```json
{
  "owner": {
    "entityId": "example-owner",
    "displayName": "Example Owner",
    "telegramUserIds": ["replace-with-owner-id"]
  },
  "telegram": {
    "enabled": true,
    "tokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedGroups": {},
    "noReplyGroupIds": [],
    "rateLimitedGroupIds": [],
    "rateLimitStateDir": "../private-tether-data/telegram-rate-limit"
  }
}
```

把 token 注入到指定的环境变量：

```bash
export TELEGRAM_BOT_TOKEN='set-this-locally'
node bin/tether.cjs ./config.json
```

Telegram 私聊入口仅限 owner。群入口只接受 `telegram.allowedGroups` 里作为 key 存在的 chat ID；空对象等于不允许任何群。通道会在每条被接受的 update 处理完之后，把下一个 Telegram update offset 持久化到 `storage.root` 下的 `telegram-offset.txt`。**把那个文件当作连续性状态，不要随手重置它。**

终端和 Telegram 是在同一个 CLI 进程里接入的。不要为 Telegram 另起一个运行时，也不要用第二份状态文件。如果需要自动重启，请在 Tether 之外配一个进程守护。

导出的适配器辅助模块在这里：

- `runtime/channels/terminal.cjs`
- `runtime/channels/telegram.cjs`
- `runtime/providers/openai-compatible.cjs`

离线测试套件演示了两个通道重新打开同一条会话，且不允许产生替代品。

## 6. 启动 Tether Console

按 `console/backend/README.md` 装好 Console 后端的开发依赖，然后：

```bash
cd console/backend
PYTHONPATH=. python -m tether_console
```

默认监听 `http://127.0.0.1:8431`。把 `TETHER_MEMORY_ROOT` 指向运行时的记忆根目录，或者按 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md) 里说明的方式，分别配置 fold、card 和 semantic 各自的根目录。

Console 是只读的。除非你有意配置了一层独立的认证访问，否则请让它一直待在 loopback 上。
