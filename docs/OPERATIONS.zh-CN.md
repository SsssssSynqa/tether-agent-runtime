# 运维与恢复

English documentation: [OPERATIONS.md](OPERATIONS.md).

这份 runbook 明确区分“可以对在线 runtime 执行的只读命令”和“必须进入离线边界的命令”。请把路径替换成本机、不进 git 的值；不要把凭据粘进准备公开的命令历史。

## 进程拓扑

推荐拓扑：

```text
launchd / systemd / container restart policy
└── bin/tether-supervisor.cjs config.json
    └── bin/tether.cjs config.json
```

宿主机管理器负责开机启动 supervisor，并且可以另设一层有界重启策略；Tether supervisor 自己负责子进程 readiness、心跳、重启退避、jitter 与 crash-loop 预算。不要让宿主机管理器再启动第二个 `tether.cjs`，也不要让它无限重置已经耗尽预算的 crash loop。

runtime 持有 `.tether-instance.lock`，supervisor 持有 `.tether-supervisor.lock`。子进程会校验 supervisor lock 里的父进程 PID/token。只有记录的进程确实不在时才回收 stale lock；损坏的 lock 一律 fail-closed。

合成 service 示例：

- [macOS launchd](../examples/com.example.tether.plist)
- [Linux systemd](../examples/tether.service)

## 在线安全的检查命令

下列命令不修改持久化状态，可以在线运行：

```bash
node bin/tether-ops.cjs status ./config.json
node bin/tether-ops.cjs dead-letters ./config.json
node bin/tether-ops.cjs inspect <update-id> ./config.json
node bin/tether-tools.cjs approvals ./config.json
node bin/tether-tools.cjs operations ./config.json
```

`status` 报告存储 schema、最新 runtime-health 判定与 Telegram durable-inbox 计数。时间戳与队列数量只是当下快照，不是永久事实。

工具审批也有跨进程持久化同步，可以在线处理：

```bash
node bin/tether-tools.cjs approve <approval-id> ./config.json
node bin/tether-tools.cjs deny <approval-id> ./config.json
```

## 离线边界

以下操作只能在 supervisor 与子 runtime 都停止之后运行：

- 存储迁移；
- 从活数据根创建备份；
- 恢复；
- 任何死信/requeue 状态修改；
- 语义重建入队；
- 向量回填与离线 memory status。

它们先取得 supervisor lock，再取得 runtime lock。只要任一进程还活着——哪怕 supervisor 只是处于等待重启子进程的 backoff——命令都会报 `TETHER_INSTANCE_LOCKED`。

请通过真正拥有服务的 service manager 停止它，并确认它不会马上重启。绝不要通过删除 lock 文件绕过检查。

## 正常启动检查表

1. 挂载/解锁私有存储与 workspace 卷。
2. 检查 owner、受限权限、剩余空间，以及 workspace 与 `storage.root` 的物理路径确实互不包含。
3. 从外部 secret 来源注入 provider 与 Telegram 凭据。
4. 启动 `tether-supervisor`。
5. 运行 `tether-ops status`，确认 storage 为 `current`、runtime health 判定为可继续、预期 session 已恢复。
6. 在依赖 Telegram 前，先用终端或合成的已授权通道验证一轮。
7. 需要时在 loopback 启动只读 Console。

进程绿色、provider 能回复，都不等于连续性成立。存储标记、session anchor、transcript proof 与 resume 结果必须一致。

## 存储迁移

当前存储 schema 是 v1。真正空的根会自动初始化；非空但缺少 `storage-version.json` 的根被视为 v0，显式认领之前不能启动。

1. 停掉 supervisor 与 runtime。
2. 在 `storage.root` 外创建文件系统级副本或快照。内置 backup 命令刻意拒绝无版本存储，因此迁移前副本必须使用运营者控制的离线复制机制。
3. 确认副本包含 `session.json`、完整 `memory/`、Telegram inbox/offset，以及当时存在的其它权威。
4. 运行：

   ```bash
   node bin/tether-ops.cjs migrate ./config.json
   ```

5. 检查输出与 `storage-version.json`。标记会记录 `migratedFrom: 0`、配置的 Agent ID，以及迁移前整棵树的 SHA-256 fingerprint。
6. 运行 `tether-ops status`，再启动 supervisor。

v0→v1 只认领既有布局，不改写对话数据。未知未来版本、Agent 不匹配、符号链接或特殊文件仍然被阻断。

## 已验证备份

停掉两个进程，然后：

```bash
node bin/tether-ops.cjs backup /absolute/backup-parent ./config.json
```

目标必须在 `storage.root` 外，物理路径也不能与它重叠。命令会创建：

```text
tether-backup-<timestamp>-<root-digest-prefix>/
├── backup-manifest.json
└── data/
```

它只复制普通文件，排除临时 lock/health/restore work；每份副本都 fsync，记录大小与 SHA-256，校验存储版本和 Agent 绑定，核对 session anchor 与 transcript proof，最后把 staging 原子改名成正式目录。

独立校验任意备份：

```bash
node bin/tether-ops.cjs verify-backup /absolute/path/to/tether-backup-...
```

校验会拒绝多余/缺失文件、符号链接、特殊文件、哈希漂移、根摘要漂移、无效 session、Agent 不匹配与 transcript-proof 不匹配。

Tether 备份是可直接读取的目录，**没有加密**。请按部署威胁模型自行加密与传输。

内置 backup 只覆盖 `storage.root`。下面这些位于外部时要单独备份：

- 每个工具 workspace 根；
- 配在 storage 外的 `telegram.attachmentDirectory`；
- 启动 provider/channel 所需的 secrets；
- 运营日志、service 定义与加密密钥。

绝不要只恢复派生记忆，而不恢复它所声称引用的原始证据和订正日志。

## 恢复演练与真实恢复

永远先校验。创建一份临时配置，让 `storage.root` 指向新的空目录，`agent.id` 与备份一致：

```bash
node bin/tether-ops.cjs verify-backup /absolute/path/to/backup
node bin/tether-ops.cjs restore /absolute/path/to/backup ./restore-config.json
node bin/tether-ops.cjs status ./restore-config.json
```

恢复要求：

- 目标根的 supervisor 与 runtime 都已停止；
- 备份与目标在任何方向上都不能互相包含，包括经符号链接解析后；
- 目标必须为空，或者带同一份可续跑 restore receipt，且只含已经核对过的备份文件；
- 已有文件只要冲突就报错，不做猜测性覆盖。

文件通过 fsynced 临时文件复制。`session.json` 最后才写入，避免中断的恢复看起来像完整人格根。`.tether-restore-receipt.json` 依次记录 `prepared` 与 `completed`；重跑同一份已完成恢复是幂等的，来自另一份备份的 receipt 会被拒绝。

真实恢复完成后：

1. 对比输出根摘要与目标备份；
2. 启动 supervisor；
3. 检查 readiness 与恢复后的 session proof；
4. 接收新流量前先检查 queue/dead-letter；
5. 做一轮已授权测试，再确认它追加进恢复后的 transcript。

不要为了让失败恢复能启动而删除 `session.json`。连续性无法证明时，保留现场；任何新人格创建前必须明确记录 lineage break。

## Telegram 死信与暂停 update

在线清点和查看：

```bash
node bin/tether-ops.cjs dead-letters ./config.json
node bin/tether-ops.cjs inspect <update-id> ./config.json
```

随后停掉 supervisor/runtime，再修改状态：

```bash
# 普通最终死信
node bin/tether-ops.cjs requeue <update-id> ./config.json

# 人工解决歧义后的 operator-paused
node bin/tether-ops.cjs resume <update-id> ./config.json

# 显式重试 failed 状态
node bin/tether-ops.cjs requeue-failed <update-id> ./config.json

# 明确确认要重新投递已经 done 的 update
node bin/tether-ops.cjs requeue-done <update-id> --confirm-redeliver ./config.json

# 只有证明原始来源不可恢复后，才关闭 orphan
node bin/tether-ops.cjs archive-orphan <update-id> --confirm-unrecoverable ./config.json
```

requeue 只记录意图。命令退出后重启 supervisor，让普通 durable/causal 路径完成重放。已经存在 committed bytes 时，绝不要人工再问模型造一个“差不多”的回复。

重放旧消息前，检查接收方、时间、因果状态、已提交输出，以及用户现在是否仍期待回复。`requeue-done` 与 `archive-orphan` 之所以需要明确 flag，就是因为后果不能安全推断。

## 工具审批与歧义

配置为 `approval` 的 Telegram 私聊写入会生成 durable approval ID 与定时暂停。批准或拒绝会更新 journal；普通 dispatcher 重试会读取决定。

如果 Tether 无法证明文件写入是否完成——例如实际 digest 既不是预期 before，也不是预期 after——它会抛出 `TETHER_TOOL_EFFECT_AMBIGUOUS`，并把 Telegram update 进入 operator-paused。先检查：

```bash
node bin/tether-tools.cjs operations ./config.json
node bin/tether-ops.cjs inspect <update-id> ./config.json
```

先解决真实文件系统状态，再用 `tether-ops resume`。root 映射或工具契约已经变化时，不要把它当成原操作直接批准/重放。

## 记忆维护与重建

常规维护自动运行。离线命令用于清点或批量修复：

```bash
node bin/tether-memory.cjs status ./config.json
node bin/tether-memory.cjs rebuild-semantic ./config.json
node bin/tether-memory.cjs backfill-vectors ./config.json
```

`status` 报告语义模式/队列/计数、向量覆盖与 transcript proof。`rebuild-semantic` 流式读取 transcript，幂等入队，不会整文件载入内存。`backfill-vectors` 索引当前全部合格的已验证文档，并 compact 过期向量。

记忆策略或模型变化后的建议顺序：

1. 停止进程；
2. 创建并校验备份；
3. 需要重新派生来源时运行 semantic rebuild；
4. 重启，让自动语义队列排空；
5. 语义记录稳定后再停一次，运行 vector backfill；
6. 跑 memory status 并检查 Console；
7. 重启 supervisor。

不能只看文件数量就宣布语义成功。必须检查发言归属、引语证据、实体解析、复核队列与来源覆盖。

## 故障 runbook

### Session resume 失败

1. 让人格推理保持停止。
2. 保留失败根与诊断。
3. 检查存储版本、Agent ID、anchor 结构、transcript proof、权限与 provider/session adapter 兼容性。
4. 能恢复时，从已验证备份恢复完整根。
5. 无法恢复时，需要明确运营决定并记录 lineage break，绝不能把 fresh session 称作“还是那一个”。

### Fold/card/semantic 失败

保留原始来源与上一份有效编译视图。检查有界重试状态和各用途模型配置。无效候选不会生效：卡片失败保留下层来源，向量失败保留卡片，语义失败保留 raw/card context。

### 更换供应商

它是 adapter 变化，不是身份迁移。保持 `agent.id`、`storage.root`、session anchor 与 transcript 不动。先用合成数据测试新端点，新输出保留 provider provenance，再重启同一个 supervisor。

### 增加通道

新 adapter 需要入站认证、稳定因果 ID、durable 投递状态、按接收方输出，并接入现有 runtime。不能为了方便创建通道专属人格历史。

### Supervisor 耗尽 crash-loop 预算

supervisor 会在预算耗尽后停止。检查最新 health record 与已脱敏进程日志，解决根因，再通过宿主机管理器重启。没诊断就提高预算，只是在隐藏循环。

## 定期演练

按明确周期执行：

- 校验最新备份，并恢复到隔离的空目录；
- 核对恢复后的 session proof 与 Agent 绑定；
- 清点 dead letter、operator pause、tool approval 与 semantic review queue；
- 检查向量覆盖和 manifest 大小；
- 检查 storage/workspace 空间与权限；
- 对部署 revision 跑离线仓库测试；
- 确认 Console 仍然只绑定 loopback；
- 按 provider/channel 策略轮换凭据。

恢复能力的证据是成功的隔离恢复与 resume，不是“备份文件存在”。
