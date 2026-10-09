# 独立微信助手：B0 冻结规格

## 版本与入口

已安装 chord / pi-ai / pi-durable 均为 1.1.0；以 package-lock.json 为精确依赖证据。项目 Node >=22.6，SQLite 为 Node 实验 API。恢复测试使用本机 Node，未验证最低版本运行；升级 durable 须重跑硬杀恢复套件。

目标入口：`npm run wechat-assistant -- <command>`（B1 实现）。命令：`login`、`start`、`status`、`doctor`、`backup`、`migrate`。停止通过前台 Ctrl-C，不以历史 PID 杀进程。`login` 与正式 `start` 需明确真实微信授权。

配置：项目根定位 `data/wechat-assistant/config.json`，显式绝对 `--config` 可覆盖；路径相对配置文件解析。字段为 schemaVersion=1、dataDir、workspaceDir、accountId、boundUserId、model.provider、model.modelId、limits、shell.enabled=false。凭据单独存储，不把密钥写入配置/日志。生产模型使用既有 provider 接线；不得隐式回退 faux 或全局 pi 工具。

## 默认边界（部分已生效；未标注项待后续阶段实现并测试）

已生效：`messageBytes`/`inboxPending`（B2 接收背压）、`memoryPromptBytes`（B3 提示注入预算，超预算按整条省略并提示剩余条数，不截断单个事实）。其余项尚未生效。

| 配置 | 默认 | 超限行为 |
|---|---:|---|
| limits.messageBytes | 32768 | 拒绝/隔离并记录原因 |
| limits.attachmentBytes | 20971520 | 停止下载并提示 |
| limits.downloadTimeoutMs | 60000 | 明确下载失败 |
| limits.inboxPending | 100 | 背压，不推进 cursor |
| limits.outboxPending | 1000 | 停止新任务接收，不丢队列 |
| limits.concurrentConversations | 1 | FIFO |
| limits.runTimeoutMs | 600000 | 取消目标任务，保留事实 |
| limits.modelRetries | 2 | unanswered/blocked，禁止无限重试 |
| limits.modelOutputTokens | 4096 | 每次请求设置上限 |
| limits.runModelRequests | 20 | 中止后续模型请求 |
| limits.dailyCostUsd | 5 | 超预算停止新模型调用 |
| limits.memoryPromptBytes | 8192 | 细节改为工具检索 |
| limits.sendAttempts | 5 | 明确未发送失败转 blocked |

预算无法精确预付控制：只有可信定价的 provider 可启用价格预算；未知定价不得把 0 当免费，生产启动阻止或要求显式 token-only 模式。已发生请求可能超支，不能承诺美元硬上限。网络发送未知结果不属于可重试失败。

## Schema 与状态（B2–B5 落地）

所有应用 Documents 以 `wechat.*` 命名，version=1，session scope；首次启动创建 manifest（应用 schemaVersion、必需扩展/工具版本）。不匹配 fail-closed。输入、输出、任务信息按账户隔离，禁止把未授权 sender 写入 conversation。

- Binding：accountId、boundUserId、conversationId、schemaVersion；在 commit 内创建 conversation 并保存映射。
- Inbox：稳定键 hash(accountId/userId/messageId 的 JSON 数组)、payloadHash、payload、receivedAt、requestId、submissionId；状态 received/submitted/settled/quarantined。同 ID 不同 hash 隔离，不用随机 ID 补缺失 ID。
- PollState：cursor、各 binding 的 context token；与同批 inbox 原子提交。
- Outbox：逻辑 answer/分片唯一键、payloadHash、接收者、冻结媒体引用、attempts、nextAttemptAt、lastError；pending/sending/sent/blocked/outcome_unknown。未知结果不自动重发。实现唯一键为 `${conversationId}:${answerEntryId}`，每分片预生成稳定 `clientId`；`chunkBytes=2048`、`maxRecords=1000`、`sendAttempts` 取配置（默认 5）；启动将遗留 `sending` 转为 `outcome_unknown`。
- Memory：id、content、source、createdAt、updatedAt、active；逻辑遗忘保留审计提醒。实现新增 `operationId` 字段：`memory_add` 以工具调用 id 为幂等键，重放不重复存储；容量上限 500 条，新增到上限时阻止而不是静默淘汰。
- Todo：复用旧库 `assistant.todo`/`assistant.receipt` 文档族与归一化规则，但由 Harness 工具写入；新增 `assistant.todo-index` 会话文档维护创建顺序索引（上限 5000），因为 `DocumentReader` 只提供点读、无扫描，`todo_list` 依赖该索引。索引可由 B6 迁移重建。
- Reminder：id、dueAt、timezone、occurrenceId、outboxId；pending/dispatched/cancelled/blocked。
- Approval：id、参数 hash、workspace、expiresAt；pending/approved/consumed/expired/rejected。shell 默认关闭。

Documents 不承担无限数据规模：达到容量保留并阻止新增；B6 给出显式导出/归档与去重保留策略，不静默清空 seen/回执。

## 已验证与未知

`tests/wechat-assistant/recovery.test.ts` 用 faux provider + 隔离 SQLite + 真实子进程硬杀，证明 model retry、相同 root/requestId、已提交答案重读、provider identity 保留、幂等 safe 工具重放、unsafe 工具 interrupted 且外部标记不重做，以及数据库第二 Harness 拒绝/硬杀后释放。此处 safe 指测试工具通过 taskId 事务去重，不代表任意工具都安全。

B3 证据：`tests/wechat-assistant/tools.test.ts` 证明待办 create/list/get/complete 的幂等回执（同 callId 重放不重复、异内容冲突）、分页不重不漏、记忆新增/检索/更正/遗忘、遗忘后不再检索、`memory_add` 重放幂等、提示注入按预算整条省略且超小预算不注入碎片、以及重启后回执/记忆仍在。`tests/wechat-assistant/memory-persistence.test.ts` 证明记忆跨新会话（reset）、真实压缩任务和进程重开仍被注入。

B4 证据：`tests/wechat-assistant/outbox.test.ts` + `sender.test.ts` 用假微信入站、真 SQLite/Harness、faux provider 与假发送端证明：同一答案只建一条 outbox 记录且重扫不重复、长答案 UTF-8 分片按序发送、确定失败退避并在上限转 blocked、网络未知转 outcome_unknown 且不再自动重发（仅 `/retry` 可重试）、崩溃遗留 `sending` 恢复为 outcome_unknown、答案已提交而 outbox 未建时重启只补建一次、context token 失效转 blocked 并在刷新后恢复。这些均不代表真实微信端 exactly-once。

仅 B0 可行性证据，不是 inbox/outbox/微信闭环测试。账号锁与旧插件协调、context token 有效期、发送 client ID 是否远端去重仍未知，分别在 B1/B4/真实微信验收证明；未知时不得无人值守切换或盲重发。
