# Tether

Tether 是一个 local-first 的 agent 运行时：跨越通道切换、供应商更换、进程崩溃和上下文上限，让同一个身份始终延续。

> **One agent. One session. Every channel. Memory that stays.**<br>
> **一个 Agent，一条连续会话，跨越所有通道，记忆始终留存。**

English documentation: [README.md](README.md).

在 Tether 的架构里，Telegram 和终端是通向同一个 agent 的两扇门——不是两个 bot，不是两份历史，也不是彼此的近似复制。公开的这套内核持有绑定在该身份上的权威会话与只追加的原始历史，并提供可靠投递、语义记忆和适配器这几层原语，让运行时能被扩展，而不越过那条边界。

Tether 从一套生产环境的 agent 运行时中抽取而来。本仓库是一份干净的、合成的、与供应商无关的发行版：不含任何生产对话历史、凭据、身份标识或部署细节。

## Tether 为什么存在

大多数 agent 桥优化的是消息投递。Tether 把投递看作一个更难的问题的最外层：当通道切换、模型供应商故障、进程重启或上下文压缩发生之后——你凭什么证明，回来的这个 agent 仍然连在同一段历史上？

所以 Tether 选择 fail-closed（宁可停住，也不伪造连续性）：

- 会话恢复失败时，不会悄悄造出一个新的人格；
- 上下文压缩失败时，保留最后一份有效上下文和原始记录；
- 投递重试时，重放已提交的那个答案，而不是再问一次模型；
- 派生出来的记忆，没有来源证据就不能变成引语；
- 人工订正以追加方式写入并带上出处，而不是改写历史。

这些规则被独立地写在 [Selfsame Protocol](SELFSAME_PROTOCOL.md) 里。Tether 只是其中一个参考实现；SSP 可以被别的运行时实现。

## 这份公开快照的状态

这是第一份干净快照，是一个**最小可运行内核**，并不代表生产环境里的每个子系统都已经完成通用化。它包含：Selfsame 会话守卫、只追加的记录/摘要/卡片仓库、语义存储与校验器、可靠投递的 spool 原语、终端通道、带持久化 update offset 的 Telegram 长轮询通道、OpenAI 兼容的供应商适配器、合成测试，以及只读的 Memory Console。Telegram 与终端在同一个进程里接入同一个运行时、同一条会话。

自动上下文折叠、日/周卡的抽取调度、模型驱动的语义抽取，以及生产级的进程守护，**不在**这份快照里。那些组件仍然需要把部署与策略上的假设通用化。在通用版本落地之前，运营者需要围绕这里记录的内核不变量自行提供这部分编排。本仓库不会把尚未包含的自动化描述成已交付的行为。

## 包含哪些能力

### 一个 agent，一条会话

- 终端适配器，以及运营者接入的每一个通道适配器，都连到同一条权威运行时会话；公开的 Telegram 工具就是为这条共享边界准备的。
- CLI 会取得唯一一把存储根锁，在接入任何通道之前，恰好一次地打开或显式创建会话锚点；启动之后第一条输入完全可以来自 Telegram。
- 通道、聊天、设备、发送者、供应商、能力档案——这些都不会让人格历史分叉。
- 恢复是 fail-closed 的：无法恢复，或者锚点在任何原始、派生、因果权威旁边缺失，都会变成一个显式的阻塞状态，绝不会是一次看不见的重置。
- 按通道区分工具与输出权限仍然可行，且不需要靠隔离上下文来实现。

### 可靠投递原语

- 用于确认、重试与死信编排的入站/出站持久化状态原语；
- 稳定的因果事件 ID 与幂等的重复处理；
- 投递失败后，精确重放此前已提交的那个响应；
- 按会话的顺序保证，以及有界的恢复行为；
- 处理供应商容量与瞬时故障，且不会把一条消息消费两次。

### 本地分层记忆

- 只追加的原始记录，作为来源权威；
- 非破坏性的上下文压缩，带来源边界；
- 卡片 schema，以及语义断言、事件、投影、证据与复核状态；
- 发言归属、实体、别名与受保护引语的完整性规则；
- 只追加的人工订正；
- 派生出来的索引、向量、manifest 与卡片，都能从来源证据重建；
- 有界的模型上下文，原始/摘要/卡片三者各有独立上限；卡片召回只选取每个逻辑日卡、周卡的最新版本，并把选中的卡片作为 system 上下文注入，同时不删除被取代的旧记录。

### Tether Console

本地 Console 提供记忆文件夹及其完整性状态的只读视图。它展示来源覆盖、卡片、语义记录、订正、队列与上下文 manifest，同时不会把 UI 的数据库变成第二个事实来源。服务默认只绑定 loopback。

### 供应商与通道适配器的边界

运行时与供应商无关。OpenAI 兼容 API 是最初的适配器形态；其它供应商可以实现同一条边界。远程供应商 URL 必须是 HTTPS，HTTP 仅限 loopback；URL 内嵌凭据以及携带凭据的普通 header 会被拒绝，由 `apiKeyEnv` 与 `headerEnv` 提供仅走环境变量的密钥注入。

CLI 总是接入终端；当 `telegram.enabled` 为 true 时，把实时的 Telegram 长轮询通道接入同一个运行时。Owner ID、群白名单、限流状态与 Telegram token 的环境变量名，都保持为显式配置。Telegram 的 update ID 构成因果消息身份，因此一次消息编辑是一个新事件，而重放同一条 update 仍然是幂等的。

## 仓库结构

```text
runtime/                  Agent 运行时、记忆层，以及通道/供应商适配器
console/backend/          只读的本地文件夹 Console API
console/frontend/         Tether Console 网页界面
examples/                 合成的配置示例
scripts/                  离线一致性检查与公开快照检查
docs/                     架构、配置、隐私与运维文档
SELFSAME_PROTOCOL.md       与供应商、实现均无关的不变量规范
```

## 运行要求

- Node.js 20 或更新版本（运行时与合成一致性探针）
- Python 3.11 或更新版本（Console 后端）
- pnpm 9 或更新版本（Console 前端）

跑本仓库的一致性检查和单元测试，不需要任何真实模型、Telegram 账号、token 或网络访问。

## 快速开始

1. 可以把合成的环境变量模板复制一份作为本地参考，并让真实文件保持不被 git 跟踪。Tether 不会自动加载 `.env`；请通过 shell 或进程管理器注入变量。

   ```bash
   cp examples/.env.example .env
   ```

2. 阅读[配置与适配器设置](docs/CONFIGURATION.md)。把运行时数据放在仓库之外的目录里。

3. 在加入任何凭据之前，先跑一遍零依赖的内核检查：

   ```bash
   make check
   ```

   装好 Console 的开发依赖之后，`make check-all` 还会测试并构建 Console。

4. 按[快速上手](docs/GETTING_STARTED.md)里记录的命令启动运行时并接入终端适配器。

5. 可选：启动本地 Console。

   ```bash
   cd console/backend
   PYTHONPATH=. python -m tether_console
   ```

   默认监听 `http://127.0.0.1:8431`。Console 始终只读，不会编辑权威记忆文件。

## Selfsame Protocol 一致性

协议定义了四个递进的层级：

1. **Identity Continuity**（身份连续性）
2. **Durable Continuity**（可靠连续性）
3. **Verifiable Memory**（可验证记忆）
4. **Recovery-Proven**（恢复已验证）

跑这个完全合成的协议探针：

```bash
node scripts/probe-selfsame-protocol.cjs
```

探针不使用任何私有数据、生产状态、凭据、供应商调用或网络访问。在声称符合某个层级之前，请先读 [SELFSAME_PROTOCOL.md](SELFSAME_PROTOCOL.md)——通过一次探针并不豁免任何规范性要求。

## 隐私模型

Local-first 不等于数据永远不离开这台机器。配置好的通道会收到消息，配置好的模型供应商会收到送去推理的上下文。Tether 自身不需要任何托管遥测，但供应商的数据留存策略、通道隐私、文件系统权限、备份，以及按接收方区分的输出控制，仍然由运营者负责。

在接入真实账号或真实历史之前，请先读 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。永远不要提交 `.env`、原始对话记录、记忆文件夹、数据库文件、通道导出、日志或身份标识。

## 项目政策

- **许可证：** [Apache License 2.0](LICENSE)，第三方材料另有说明的除外。分发时必须保留 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中适用的署名。三个改写过的 bridge 辅助模块含 MIT 授权材料，`CODE_OF_CONDUCT.md` 单独以 `CC-BY-SA-4.0` 授权。
- **贡献指南：** [CONTRIBUTING.md](CONTRIBUTING.md)
- **安全报告：** [SECURITY.md](SECURITY.md)
- **行为准则：** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **名称与标识：** [TRADEMARKS.md](TRADEMARKS.md)

Apache-2.0 含有明确的专利授权条款，但它并不授予"暗示获得 Tether 项目背书或官方关联"的权利。
