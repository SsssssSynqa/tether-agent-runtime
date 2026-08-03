# 快速上手

English documentation: [GETTING_STARTED.md](GETTING_STARTED.md).

这份指南会启动完整的参考运行时：终端与可选 Telegram 共用一条会话，分层记忆自动维护，本地工具带审批，进程受到监督，另有只读 Console 可检查记忆。

## 1. 前置依赖与离线验证

- Node.js 20 或更新版本；
- Tether Console 需要 Python 3.11 或更新版本；
- Console 前端需要 pnpm 9 或更新版本。

运行时本身没有 npm runtime dependency。在加入凭据前先跑：

```bash
make check
```

它只使用合成临时数据。如果 Console 的依赖也已经安装，再跑完整门禁：

```bash
make check-all
```

## 2. 选三个互相分离的位置

分别为下列内容选择目录：

1. 源码 checkout；
2. 保存连续性权威的 `storage.root`；
3. 每一个工具 workspace 根。

例如：

```text
/opt/tether-agent-runtime/       源码
/srv/tether/state/               storage.root
/srv/tether/workspace/           tools.workspaceRoots[0].path
```

workspace 根不能包含 `storage.root`，`storage.root` 也不能包含 workspace 根。Tether 启动时按物理路径检查，两种重叠都会硬拒绝。这样模型工具就碰不到会话锚点、原始记录、Telegram inbox 或工具日志。三个位置都不应放进公开同步目录；两个数据位置分别需要自己的备份策略。

## 3. 准备本地配置

```bash
cp config.example.json config.json
cp persona-policy.example.md persona-policy.private.md
cp examples/config.private.example.json config.private.json
```

仓库默认会忽略这些本地运行文件。写入任何私密内容前，先用 `git status` 确认它们没有被跟踪。

编辑 `config.json`：

- 设置稳定的 `agent.id` 与 `owner.entityId`；
- 把 `persona.policyFile` 改成 `./persona-policy.private.md`；
- 将 `storage.root` 与 `tools.workspaceRoots` 指向刚才选好的独立目录；
- 设置 provider 的 `baseUrl`、`model`，以及可选的 fold/card/semantic/embedding 模型；
- 允许日卡开始结算前，先检查记忆时间策略；
- 前台运行验证成功前，先让 Telegram 保持关闭。

相对路径都以 `config.json` 所在目录为基准解析。

## 4. 注入凭据

Tether 不会自己加载 `.env`。请从 shell、凭据管理器、容器 secret 或宿主机服务包装器注入：

```bash
export PRIMARY_API_KEY='set-this-locally'
```

`apiKeyEnv` 填的是环境变量名，从来不是密钥值。供应商专用密钥 header 使用 `headerEnv`。内联 API key、普通 header 中的凭据、URL 中的凭据，以及远程明文 HTTP 端点都会被拒绝。

不需要认证的 loopback 开发供应商可以这样声明：

```json
{
  "authentication": "none",
  "baseUrl": "http://127.0.0.1:11434/v1/chat/completions"
}
```

## 5. 先证明一次前台启动

部署初期先直接启动一次子 runtime：

```bash
node bin/tether.cjs ./config.json
```

启动应当完成这些事：

- 在真正空的根目录创建 `storage-version.json`；
- 接入任何通道之前创建或恢复 `session.json`；
- 在 `runtime-health.json` 发布 `ready`；
- 接受终端逐行输入并打印供应商响应；
- 拒绝第二个指向同一根目录的进程。

`runtime.allowInitialSessionCreate: true` 只授权在空权威目录中创建第一个锚点。如果 `session.json` 丢失，而 transcript、卡片、语义、因果、工具或 Telegram 权威仍在，启动会 fail-closed。请恢复锚点，不要靠删除证据强行变绿。

既有无版本目录会报 `TETHER_STORAGE_MIGRATION_REQUIRED`。停掉所有 Tether 进程，先在外部做一份经过验证的副本，再按[存储迁移](OPERATIONS.zh-CN.md#存储迁移)处理。

前台验证完成后，用 Ctrl-C 干净退出，再启动 supervisor。

## 6. 启动 Tether supervisor

推荐的长期运行命令：

```bash
node bin/tether-supervisor.cjs ./config.json
```

supervisor 持有 `.tether-supervisor.lock`，启动 `bin/tether.cjs`，监测 readiness 与心跳新鲜度；故障后仍用同一个存储/会话重启，并带退避、jitter 和有界 crash-loop 预算。

需要随宿主机开机启动时，让 launchd 或 systemd 指向 supervisor，**不要**直接指向 `bin/tether.cjs`。[`examples/`](../examples/README.md) 里有合成示例。密钥应由宿主机的 secret 机制提供，不要写进并提交 service 文件。

从另一个 shell 检查状态：

```bash
node bin/tether-ops.cjs status ./config.json
```

## 7. 把 Telegram 接到同一条会话

在 `config.json` 里设置 owner ID 与 Telegram：

```json
{
  "owner": {
    "entityId": "example-owner",
    "displayName": "Example Owner",
    "telegramUserIds": ["OWNER_TELEGRAM_ID"]
  },
  "telegram": {
    "enabled": true,
    "tokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedGroups": {
      "GROUP_CHAT_ID": {
        "enabled": true,
        "mode": "mention",
        "mentionPatterns": ["Example Agent"],
        "ownerAlways": true,
        "ignoreBotMessages": true
      }
    }
  }
}
```

然后注入 token，并按宿主机的方式重启 supervisor：

```bash
export TELEGRAM_BOT_TOKEN='set-this-locally'
node bin/tether-supervisor.cjs ./config.json
```

私聊入口仅接受 owner。群 chat ID 必须作为已启用 key 出现在 `allowedGroups` 中。`mode: "mention"` 要求匹配配置好的 mention（`ownerAlways` 命中时除外）；`mode: "all"` 会观察所有被接受的消息，但回复策略仍然可以选择不说话。

Telegram 和终端始终接在同一个 `TetherRuntime`、`SelfsameSession`、transcript、卡片与语义库上。不要创建 Telegram 专用数据根。

适配器还包含：

- durable update 与持久化 `telegram-offset.txt`；
- 崩溃后的精确重放与死信状态；
- 群消息批处理和经过验证的多回复信封；
- 长消息确定性切片；
- 被引用消息消失时，去掉 reply 参数裸发一次；
- 图片下载和普通文件的有界文本预览；
- 显式附件大小限制与私有附件目录。

offset、inbox、附件、session anchor 与 memory 应当被当成同一套连续性备份。

## 8. 审查工具能力

示例配置启用了本地文件工具。使用前逐项检查：

- 每个稳定 workspace root ID 与物理路径；
- 读写字节上限和目录条数上限；
- 每个通道的 `allow`、`approval`、`deny` 策略。

默认示例允许终端读写；Telegram 私聊允许读、写入需要审批；群聊工具全部拒绝。模型没有 shell、网络、删除、重命名或任意二进制写入工具。

runtime 在线时可以列出并处理审批：

```bash
node bin/tether-tools.cjs approvals ./config.json
node bin/tether-tools.cjs approve <approval-id> ./config.json
# 或者
node bin/tether-tools.cjs deny <approval-id> ./config.json
```

普通审批暂停会由 durable Telegram dispatcher 自动重试。外部副作用状态不明时会进入 `operator-paused`；检查操作日志和文件系统之后，再用 `tether-ops resume` 明确恢复对应 update。

## 9. 确认自动记忆维护

记忆维护随 runtime 一起启动，不需要另配 cron。它会自动执行活跃上下文折叠、语义提取/验证、日周卡结算，以及可选的向量维护。

全部 `tether-memory` 命令都是离线操作，会同时取得 supervisor 和 runtime 两把锁。先停掉两个进程：

```bash
node bin/tether-memory.cjs status ./config.json
node bin/tether-memory.cjs rebuild-semantic ./config.json
node bin/tether-memory.cjs backfill-vectors ./config.json
```

`rebuild-semantic` 会幂等地把历史 transcript 轮次加入队列；启用 embedding 或更换向量索引后可运行 `backfill-vectors`。命令成功退出后再启动 supervisor。

## 10. 启动 Tether Console

先用仓库内的合成数据：

```bash
cd console
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
cd frontend
pnpm install
pnpm test
pnpm check
pnpm build
cd ..
cp .env.example .env
set -a; . ./.env; set +a
PYTHONPATH=backend python -m tether_console
```

打开 <http://127.0.0.1:8431>。要检查真实 runtime，在不进 git 的环境文件或 shell 中，把 `TETHER_MEMORY_ROOT` 指向 `<storage.root>/memory`。Console 是只读、loopback-first 的检查界面，不是管理写 API。

## 11. 创建第一份已验证备份

停掉 supervisor 与 runtime，然后运行：

```bash
node bin/tether-ops.cjs backup /path/outside/storage ./config.json
node bin/tether-ops.cjs verify-backup /path/to/tether-backup-...
```

命令会打印实际创建的备份路径与根 SHA-256。备份目录没有加密。恢复演练应使用全新的空目标与临时配置，绝不能覆盖活的数据根。死信、迁移、备份和恢复的精确命令都在[运维与恢复](OPERATIONS.zh-CN.md)中。
