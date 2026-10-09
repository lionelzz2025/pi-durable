# Task Plan: 路线 B — 独立 pi-durable 微信个人助手

PLAN_ID: 2026-10-08-personal-assistant-memory-v0-1
仓库: D:/tools/pi-durable

## Goal

以 **pi-durable 为唯一助手运行时**，完整开发独立微信个人助手：微信输入、持久会话、模型推理、工具执行、长期记忆、任务恢复、微信回复均由本项目闭环管理。停止并重新启动进程后，自动打开同一数据库、恢复同一会话和未完成工作，不依赖 pi TUI、`-e` 桥接、全局 pi-todo 或 hermes-memory 插件。

**路线 B 的当前定义只有上述一种。** 旧版同名 B（pi 主助手 + HTTP 待办服务）已被替代，不继续以修补桥接作为主线。允许移植 `pi-wechat-assistant` 的代码，但不直接加载 pi 扩展充当 durable 插件。

## Approval Gate

用户已明确授权“提交后开始实施”。迁移基线已提交为 `8cf4c1a`，允许本地实施 B0–B6。真实微信登录/发送、付费模型、正式数据迁移及全局设置仍需对应授权；不自动推送远端。

旧实现不删除、不覆盖真实数据、不修改全局 pi 设置、不启动/抢占微信连接、不调用付费模型；用户现已授权每完成阶段并验证后本地 commit，不推送。未获委派授权，默认单一主模型实施。

## Current Phase

新路线：B0–B4 complete（B4 仅“文字内测”），B5 in_progress，B6–B7 pending；B4 已实现 durable outbox（答案补扫、UTF-8 分片、发送回执、退避、blocked/outcome_unknown 与人工 `/retry`）并完成假微信→真 Harness+faux→假微信全链路故障窗口测试与重启续传。B3 已实现待办工具（复用领域事务与幂等回执）、独立长期记忆（新增/检索/更正/遗忘 + 有界提示注入）并验证跨 reset/压缩/重启可检索。B2 已完成持久 inbox/绑定/FIFO、Harness/模型/工具守卫与结算补扫、以及绕过模型的确定性控制命令，离线硬杀恢复通过。B1 离线协议/凭据/账号锁/登录生命周期与持久接收入口已验证，真实平台测试仍在 B7 未执行。旧阶段证据保存在 `legacy-task-plan.md`、`legacy-verification.md`、`legacy-handoff.md` 和 `progress.md`，不是新路线通过证据。

## Next Step

继续 B5：图片/文件入站与出站（能力检查、大小/路径/URL 边界、明确不支持提示）、read/write/edit 工作区权限策略与发送工具、默认关闭的 shell 与持久审批、durable 任务状态/取消/恢复，以及本地提醒调度与 occurrence outbox。

## Scope 与完成定义

### 本计划必须完成（不是仅做待办 MVP）

1. 独立 CLI/daemon：登录、启动、状态诊断、停止、配置校验与凭据失效提示。
2. 单微信账户、绑定单用户；文字/引用消息、图片和文件收发；可用的语音转文字内容接入；不支持的视频/语音明确提示。
3. 固定账户/用户 → conversation 映射；会话、排队输入、模型回合、工具结果均持久化；支持状态、取消、显式新会话、压缩。
4. 待办创建/列表/查询/完成；显式长期记忆新增/查询/更正/遗忘；不与 pi 的其他同名工具混用。
5. 持久任务状态查询/取消/恢复；本地提醒调度与 durable outbox。主动发送受微信协议限制，失败必须进入可查询的 blocked 状态而非假装已提醒。
6. 工作区文件读写/编辑、文件与图片回传；命令执行是显式开启、需审批的可选能力，默认关闭。实现审批机制，但用户可始终不启用命令执行。
7. 数据迁移、备份/恢复、启动守卫、限流/容量边界、日志脱敏、崩溃验证与真实微信验收。

B0–B4 可形成文字内测里程碑；**不能据此声称完整交付**。完整交付要求 B0–B7 的必需项通过，平台阻塞项单列并由用户接受限制。

### 明确非本轮目标

- 克隆 pi TUI、兼容所有 pi 插件、自动搬入全部技能/LSP/子代理/记忆插件；这些不是 durable 自带能力。
- 多用户、多账户、多渠道、Web 管理台、公网 HTTP 服务、任意远程 shell。
- OCR/ASR/视频理解平台、无限记忆、无限任务、断电零丢失或微信端 exactly-once 承诺。
- 自动安装系统服务或改全局配置；提供手动运行/可选自启动说明，不擅自安装。

## Architecture and ownership

```text
微信 iLink
  ↕ QR/长轮询/文本与媒体协议（移植并适配）
渠道适配器 → 身份校验 → durable inbox + cursor + context token
                                ↓
                    账户/用户 → conversation
                                ↓
                 pi-durable Harness + Registry
             模型 / 持久会话 / 工具 / Documents / Tasks
                                ↓
                   answer → durable outbox → 微信
```

- 一个进程、一个 Harness 拥有正式 SQLite；不要为同一库再开 createSession，也不依赖旧 HTTP 服务。
- 数据建议新目录 `data/wechat-assistant/assistant.sqlite`，用项目绝对根定位而非 shell cwd。旧 `data/assistant/assistant.sqlite` 原样保留。
- 复用 `src/providers/fasthub.ts` 和 examples 的 Harness 范式；固定实际包版本/lockfile。pi-durable API 为 experimental，升级需全套恢复回归。
- `src/assistant/storage.ts` 已自行设置 `PRAGMA locking_mode = EXCLUSIVE`、busy timeout 与探针。抽出可交给 Harness 的 Storage 工厂，不能把它返回的 Session 再套一层 Harness。SQLite 默认多进程串行写不等于应用独占。
- Registry 的工具/任务定义不持久化：启动必须装齐版本匹配的定义。缺少必需工具、模型或 migration 时 fail-closed，不退回另一套工具或空库。
- watch/watchEvents 只作观测；启动从持久 inbox/submission/outbox 扫描补偿，不能把易丢的事件监听当唯一发送路径。

## 微信代码移植清单

来源：`C:/Users/hongchao.zhu/.pi/agent/npm/node_modules/pi-wechat-assistant`，当前 0.3.1；仓库 https://github.com/shenjiecode/pi-wechat-assistant 。MIT，Copyright (c) 2026 sj。

| 上游模块 | 处理方式 | 必须改动/验证 |
|---|---|---|
| api.ts、types.ts、constants.ts | 移植协议与类型 | 注入 transport、超时/取消、URL 限制、固定发送标识；不依赖全局安装路径 |
| security.ts | 保留身份规则并测试 | 空 sender 拒绝，凭据绑定用户校验先于媒体下载/缓存/模型 |
| client.ts | 拆分移植 | 网络收发保留；cursor/seen/context 持久化改接本项目事务，禁用上游提前保存与清空 seen 集合逻辑 |
| media.ts、message.ts | 移植并收紧边界 | 大小、真实路径、重定向/SSRF、文件类型、分段与脱敏；多媒体需实际能力检测 |
| auth.ts | 移植 QR 协议，重写存储/锁 | 独立凭据目录；账号切换隔离；移除直接 unlink；不自动复制或覆盖 pi 凭据 |
| logger.ts、utils.ts | 按需移植 | 不记 token/媒体密钥/消息全文；QR 只本地显示；依赖逐一声明 |
| index.ts、commands.ts、remote-commands.ts、queue.ts | 重写 | 去掉 ExtensionAPI/Context、TUI、sendUserMessage、agentIdle；改接 durable submission/控制命令 |

实施时新增 `THIRD_PARTY_NOTICES.md` 和许可副本、来源版本/文件 SHA-256/改动清单。不要运行时深导入用户全局 node_modules，也不修改已安装插件。移植代码统一本项目 TS 导入规范。

## 核心数据与恢复契约

### 1. 接收与会话

- `ChannelBinding`：accountId、boundUserId、conversationId、schemaVersion；绑定创建与 conversation 创建须同一事务或具备确定性恢复协议。
- `Inbound`：accountId/userId/messageId、规范化内容与媒体引用、receivedAt、requestId、submissionId(null 可用)、状态与失败原因。
- 稳定键来自账户/用户/平台 messageId（无歧义编码或哈希），不按文本内容去重。同 ID 不同内容隔离告警；缺失 messageId 不生成随机 ID 冒充可去重，进入隔离记录。
- 同一轮询批次的授权消息 inbox、context token、下一 cursor 在同一 commit 落地；明确拒绝的消息只留脱敏拒绝原因。提交失败不推进游标、不标 seen、不对用户声称接收成功。
- 持久接收后通过 `submit({requestId,...})` 驱动；若提交后未保存 submissionId 就崩溃，重用 requestId 找回，不创建第二次业务执行。所有状态转换具备重启扫描与补偿。
- 单会话默认 follow-up FIFO，不内存合并消息；如后续引入合并，先定义批次 ID 与原消息映射。队列满停止拉取/推进游标并显示背压，不丢弃已接收输入。
- 新会话是明确的控制命令并持久切换映射；默认启动绝不 reset。取消只取消目标任务/会话工作，不删除事实或已发送消息。

### 2. 待办、记忆与工具

- 复用待办领域规则和测试，不走桥接 HTTP。待办变更与业务 operation 回执仍原子提交；业务 ID 由持久工具任务身份派生，不由模型随意生成。需要明确重试接口。
- 长期记忆是独立 versioned Documents：内容、来源、创建/修改时间、有效状态；显式用户要求才写入事实，冲突更新保留可解释的来源。支持查询、更正和逻辑遗忘。
- 每次构造模型请求时有界读取核心记忆，详细记录按工具检索；压缩/reset 不删除长期记忆；注入消耗 token，不承诺零成本。
- 历史 transcript/审计可能含已遗忘内容，逻辑遗忘不等于物理擦除，文档必须告知。物理文件删除仍走回收站，永久删除需额外确认。
- 只有证明业务幂等的工具才标 `replay: "safe"`。外部命令、任意文件修改、媒体发送不得一律声明 safe；崩溃后不确定副作用标 interrupted/needs_review，不能自动重做。
- 工具清单为显式 allowlist。启动校验必要工具（待办/记忆等）齐全，缺失则不接收正常请求，防止旧版“工具缺失但仍自信回复”。

### 3. 回复 outbox

- `Outbound` 保存 binding、submission/answer ID、payload 或冻结附件引用、chunkIndex、幂等键、状态、attempts、nextAttemptAt、lastError。唯一键为逻辑回复/分片，不由重启生成新键。
- 答案已完成但 outbox 未建立时，由启动扫描补建；建立 outbox 与本地 reply marker 原子提交。最终回复只使用已提交答案，不发送 thinking/工具私密输出。
- `pending → sending → sent`；明确未发送的可重试错误退避重试；进程中断/请求超时后的 `sending → outcome_unknown`。无协议幂等保证时不自动重发未知结果，供用户查询/显式重试，并提示可能重复。
- 若平台支持幂等 client ID，必须实证其作用域/期限后才能自动重试；生成固定 client ID 本身不等于远端去重。不宣称网络 exactly-once。
- context token 按绑定隔离持久保存；失效进入 blocked，等待本人新消息或重新登录。绝不换接收者绕过。
- 分片逐条记回执，中途失败不重发已确认分片。文件出队前核验内容 hash，原文件变化不得悄悄发送不同内容。

### 4. 任务、提醒和安全

- 长任务通过 durable Task/检查点运行，查询暴露 pending/running/completed/failed/cancelled/blocked；重启恢复调度，不只恢复数据。
- 提醒持久保存 timezone、dueAt、状态、occurrence ID。重启补扫到期项；同 occurrence 只创建一个 outbox；默认错过提醒补发一次并标明原到期时间，取消与派发竞争需测试。
- 主动发送不可用时保留提醒结果/待发送状态，下一次本人消息可提示；不得无限重试或称提醒已送达。
- 文件仅在配置工作区内：realpath 校验、防 `..`/符号链接/junction 越界、附件路径固定化。下载限制协议/host/重定向/字节数/时限，不能信任消息里的 URL。
- shell 默认关闭。开启前需本地配置与持久一次性审批（参数哈希、工作区、有效期、状态）；参数变化/过期/重放审批均拒绝。审批消费持久化也不能消除外部副作用未知窗口。
- 本机可信账号鉴权不等于执行沙箱。若执行环境无法限制文件/网络/进程权限，禁止宣称强沙箱；默认不开放任意命令。
- 必须预设并测试消息/附件/队列/并发/运行时长/模型重试与花费上限，阈值在 B0 固定，超限可诊断。容量管理不静默删除仍承担去重职责的回执。

## 迁移、运行与回滚

- 新入口建议 `src/wechat-assistant/main.ts`。开发期新增 `npm run wechat-assistant -- <command>`，保留现有 `npm run assistant` 的旧行为；上线切换入口另行明确，不悄悄改变现有命令。
- 正式流程：配置校验 → 应用存储独占 → schema/Registry 校验 → 恢复会话/任务/outbox → 微信连接就绪。模型不可用应有 degraded/blocked 诊断，不伪造业务成功。
- 账号连接锁与数据库独占是两件事。新旧程序使用独立状态目录并不防止同账号双轮询；切换前用户停止旧插件，B1 验证与现有插件共享/兼容的账号锁协调方式；不能证明互斥则阻止无人值守切换，不杀未知进程或按锁年龄抢占。
- 旧库在旧服务停止后做一致备份，离线导入待办及 operation 回执并记录 migration marker、数量/hash；重复导入不得重复。不要边运行边直接复制 SQLite 主文件忽略 WAL。
- 旧 pi transcript/hermes-memory 不自动迁移，用户明确选择后另做受控导入；当前新长期记忆不假装已拥有旧系统所有记忆。
- 回滚：停止新实例/释放账号所有权，恢复备份或重新启动保留的旧栈。新库新增数据不会自动回流旧库，回滚前需导出并明确差异。
- 关闭：停止轮询、排空已开始的事务、保存任务检查点和发送状态、关闭 Harness 与锁。Windows 优雅退出用真实 Ctrl-C/进程内接线验证，跨进程 kill 仅验证硬杀恢复。

## Planned files

建议职责，可合并小模块：
- `src/wechat-assistant/{main,config,lifecycle,runtime}.ts`：入口/运行时/守卫。
- `src/wechat-assistant/channel/`：微信协议、QR、媒体、身份与连接互斥。
- `src/wechat-assistant/{documents,inbox,outbox,conversations}.ts`：持久投递闭环。
- `src/wechat-assistant/tools/`：待办、记忆、媒体、受控工作区工具。
- `src/wechat-assistant/{tasks,approvals,migration}.ts`：任务/提醒/审批/旧库迁移。
- `tests/wechat-assistant/`：fake transport/faux provider、故障注入、子进程恢复。
- `docs/wechat-assistant.md`、`THIRD_PARTY_NOTICES.md`、许可副本：运行手册与上游归属。
- `package.json`、lockfile、tsconfig、README：必要脚本/依赖/文档入口。examples/01–05 保持原行为。

## Phases

### Phase B0: 固定规格与 durable 可行性验证
- [x] 完整读实际版本 README/类型/相关示例；chord/pi-ai/pi-durable 1.1.0；本机 Node v24.14.1。最低支持版本仍需 B6 验证。
- [x] faux provider + SQLite：同会话重开、requestId、resume、safe/unsafe 工具、已提交答案重读最小实验。
- [x] 固定 schema、状态转换、队列/附件/运行预算阈值、CLI 命令和配置；详见 ../../docs/wechat-assistant-spec.md。token/账号锁/远端幂等仍列未知，不视作已验证。
- [x] 提取独占 Storage 工厂并交给 Harness 单持有者；第二进程拒绝与硬杀后释放通过。
- **Status:** complete
- 门槛：核心恢复语义不成立时报告，不退回 pi 主助手或内存队列。

### Phase B1: 微信传输移植与独立生命周期
- [x] MIT 许可副本/来源 SHA-256 清单；types 与基础 poll/send/QR 协议移植，transport 注入及 6 项离线契约测试通过。
- [x] 凭据 SQLite 事务存储、新端跨进程账号锁/硬杀释放、游标接口与媒体 CDN 协议；无 pi 宿主及直接删除依赖。
- [x] 本地 QR 登录、配置、状态与 receive-only 启动/停止；账号互斥、凭据到期、重连退避、脱敏。完整 agent 入口在 B2–B4，Windows 真实 Ctrl-C 在 B7。
- [x] 协议/凭据/身份/跨进程锁/生命周期/receiver 离线契约测试通过；全量 89/89、typecheck 与 diff --check 通过。真实登录尚未授权，列 B7 未执行，不作为本阶段离线通过证据。
- **Status:** complete

### Phase B2: 持久 inbox 与会话运行时
- [x] inbox/cursor/context 原子接收、稳定去重、绑定会话、FIFO 和背压。
- [x] Harness/模型/Registry 接线、启动必需能力守卫、自动 resume 与 submission 关联补偿。
- [x] 状态/取消/新会话/压缩命令绕过模型自由解读，身份同样校验。
- **Status:** complete

### Phase B3: 待办与独立长期记忆
- [x] 待办工具复用领域事务与幂等回执，不依赖旧服务。
- [x] 记忆新增/检索/更正/遗忘及有界提示注入，跨 reset/压缩/重启验证。
- [x] 工具重放分类、错误语义与“成功必须有持久结果”测试。
- **Status:** complete

### Phase B4: durable outbox 与文字恢复闭环
- [x] 答案补扫建 outbox、分片、发送回执、退避、blocked/outcome_unknown 与人工重试。
- [x] 假微信 → 真 SQLite/Harness + faux provider → 假微信，全链路故障窗口测试。
- [x] 重启无需用户补发消息即可继续 pending 工作和安全可发送回复。
- **Status:** complete
- 此处仅可标“文字内测”，不是完整完成。

### Phase B5: 媒体、工作区工具、任务与提醒
- [ ] 图片/文件入站及出站，支持能力检查与明确不支持提示；落实大小/路径/URL边界。
- [ ] read/write/edit 权限策略、发送工具；实现默认关闭的 shell 和持久审批。
- [ ] durable Task 状态/取消/恢复；提醒时区/补扫/取消/outbox 与平台阻塞策略。
- **Status:** pending

### Phase B6: 迁移、运维与全量自动化验证
- [ ] 旧待办/回执离线迁移、备份/恢复/回滚、从不同 cwd 启动仍同库。
- [ ] 执行 verification.md 的 N01–N20，故障修复后重跑相关及全量测试/typecheck。
- [ ] 写用户手册、诊断命令、容量/隐私/预算/恢复限制，静态核对无 pi 宿主必需依赖。
- **Status:** pending

### Phase B7: 真实微信验收与交付审计
- [ ] 用户授权后执行 W01–W08（真实模型/真实微信/真实重启），保留脱敏证据。
- [ ] 逐条对照 Scope、数据契约、阶段和验收；未测/blocked 项保持未完成。
- [ ] 明确停止旧入口、切换/回滚方法、残余风险；未授权不改全局配置、不 commit。
- **Status:** pending

## Acceptance

详见 `verification.md`。四种状态必须分开：计划、已实现、自动化通过、真实微信通过。旧 52 项测试只作回归基线，本轮没有运行它们；不证明新 Harness/微信闭环已实现。

## Decisions Made

| 决定 | 理由 |
|---|---|
| 独立 durable 运行时，不修补 pi 桥接作为主线 | 用户明确选择，消除对 pi 启动参数/全局工具集合的隐式依赖 |
| 移植协议、重写宿主接线 | 上游是 pi 扩展而非通用 SDK；其持久化时机不满足新系统接收契约 |
| inbox/outbox 分别持久化并做补偿 | 数据库与微信网络请求不能一笔事务提交 |
| 未知发送结果不盲重试 | 避免把本地幂等误说成远端 exactly-once |
| 保留旧实现、离线迁移到新库 | 已有未提交工作与真实数据不能被规划或迁移覆盖 |

## Errors Encountered

B1 错误与处理：Node strip-only 不支持 parameter properties，改为显式字段；sendMessage 同步校验抛错与 Promise API 不一致，改为 async；修正后协议 6/6/typecheck 通过。

B0 错误与处理：fixture 导入路径/TaskId 类型错误已修正；faux toolCall 默认 stopReason=stop，须显式 toolUse，否则只形成普通答案；首次并行全量 55/56，旧锁测试因启动耗时超 5 秒失败，串行重跑 56/56 并固定 npm test concurrency=1，未放宽锁断言。已识别的历史证据矛盾（M02 撤回、旧顶部状态过时、库独占归属误述）已在当前计划/进度/交接中纠正，原记录仅作为历史保留。
