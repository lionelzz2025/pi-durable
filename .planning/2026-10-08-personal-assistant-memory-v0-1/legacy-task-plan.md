# Task Plan: 微信个人助手 — 路线 B，持久待办首版

PLAN_ID: 2026-10-08-personal-assistant-memory-v0-1
仓库: D:/tools/pi-durable

## Approval Gate

**状态：计划已确认并实施完毕（2026-10-08）；Phase 1–4 已完成，Phase 5 仅剩人工微信验收 blocked。**
用户 m00143 要求先细化计划与验证，m00163「开始实施」确认后，实施模型按顺序执行完 Phase 1–4 与 Phase 5 的文档部分。
**未做的只有 M01–M05（需用户明确授权，涉及真实微信登录与占用连接）。**
本版不声称微信端已验收。未自动 commit；未修改全局 `~/.pi/agent/settings.json`。
本文件替代旧的「记忆 CLI」计划。特别注意：**此处 B 是 pi 主助手 + 独立 durable 服务，不是早期表中的自建微信 daemon。**

## Goal

微信 → 既有 pi-wechat-assistant → pi → 桥接扩展 → 本机 pi-durable 服务 → SQLite。
首版完成创建、查询、完成待办；关闭并重启服务或 pi 后仍能查询。
保留 examples/01–05；CLI 仅是开发入口，不新造对话 REPL。

## Next Step

下一步只能是二选一（均需用户决策）：
1. **授权人工微信验收 M01–M05**（详见 `verification.md` 与 `docs/assistant.md` §10）——这是把版本从「服务/桥接已验证」推到「微信端已验证」的唯一路径。
2. **关于提交**：是否把当前改动提交到 git（`package.json`、`tsconfig.json` 已修改，`src/assistant/`、`extensions/`、`tests/`、`docs/`、`.planning/` 未跟踪）。

另：若要长期生效，需用户同意后把 `extensions/durable-assistant` 加入全局 pi 配置（本版刻意未改）。

## Scope

### 首版包含
- 单用户、单账户、单独 pi 宿主；原样复用微信插件。
- 独立 Node 服务：仅监听 127.0.0.1，Bearer token 鉴权，独占自己的 SQLite。
- 待办创建、分页列表、按 ID 查询、完成；明确错误和幂等语义。
- pi 桥接工具调用 HTTP，不直接访问数据库，不管理微信登录或连接。
- 手动双进程启动、健康检查、停止与恢复文档；独立于模型的自动化测试。

### 明确不包含
- 主动提醒、定时调度、通知发件箱、自动推送。
- 自动启动/系统服务安装、远程网络访问、多用户、多渠道。
- shell/文件任务、子代理执行、审批系统、长任务断点续跑。
- 重新实现 hermes-memory、自动记忆注入、修改第三方微信插件。
- 自动改全局 pi 设置、登录微信、抢占已有微信连接、发真实测试消息、git commit。

这些是路线 B 的后续能力，不应把本版持久 CRUD 宣称为已实现 durable 工作流调度。

## Architecture and ownership

- pi 持有对话、模型、技能和已有记忆系统。
- pi-wechat 持有微信身份校验、连接、消息输入与自动回复；桥接服务不能把本机 token 当微信身份。
- durable 服务唯一持有待办事实和操作去重记录；不得让 pi 同时直连 SQLite。
- 优先使用 `createSession(storage)` + `defineDoc` + `session.commit`，本版不需要 Harness、provider 或模型 API key。
- 类型声明已确认存在 Session kernel API，但行为还未实测；Phase 1 必须验证。
- Node 当前 v24.14.1；沿用 Node TS 直接执行和仓库 ESM 设置，不在未验证情况下承诺所有 Node >=22.6 可运行新增入口。

## Proposed contract (实施前固定，若变更需同步测试)

### 存储
- 默认数据目录通过模块位置定位到项目 data/assistant/，不依赖调用方 cwd；可用 ASSISTANT_DATA_DIR 覆盖。
- SQLite 文件 assistant.sqlite；单用户 namespace，不能为每个 pi 会话新建一份待办。
- Todo: id（服务生成 UUID）、title（trim 后 1–500 字符）、status(open|done)、createdAt、completedAt(null|string)。时间为 UTC ISO，由服务生成。
- 数据 doc scope=session、version=1；持久化值只用 JSON 值，缺省 null；类型用 type alias。
- 建议待办和操作回执使用 doc family 按 ID 存储；Phase 1 核查可枚举/分页 API 后定案。若单 doc 更简单，只允许有明确容量上限的首版，避免无界加载。
- mutation 必须在一次 commit 中同时保存待办变更和操作回执；不得先写待办后单独写去重记录。
- 操作回执保存规范化请求指纹与原始成功结果；失败请求不占用 operationId。
- 首版不自动删除待办或去重记录；文档说明容量边界，不静默淘汰导致旧请求再次执行。

### HTTP /v1
- GET /health：鉴权后返回版本及 readiness，不泄露路径、token 或堆栈。
- POST /v1/todos：{operationId,title} → {todo}。
- GET /v1/todos?status=open|done|all&limit=...&cursor=... → {items,nextCursor}；默认 open、limit=20，最大100。
- GET /v1/todos/:id → {todo}。
- POST /v1/todos/:id/complete：{operationId} → {todo}；已完成时返回已有 completedAt，不重写时间。
- operationId 长度 1–128，限制为明确的安全字符集；同 ID 同规范化请求返回原结果，不同请求 409。
- 400 无效参数/JSON/cursor，401 缺少或错误 token，404 不存在，409 操作冲突，413 超过16KiB body，415 非 JSON mutation，503 服务不可用/关闭中，500 内部失败。
- 统一错误 {error:{code,message}}；不输出内部路径或堆栈；不启用 CORS，拒绝浏览器跨源 Origin 请求。
- 分页排序固定且 cursor 校验；不承诺跨并发修改的快照分页，需文档说明。

### 配置与生命周期
- ASSISTANT_PORT 默认 4318；校验端口范围。测试允许通过内部启动 API 使用随机空闲端口。
- ASSISTANT_TOKEN 至少32字节随机值的可打印编码；服务和 pi 使用同一环境变量，不在仓库保存、不在日志输出。
- 默认不自动生成/显示秘密；README 提供本地生成与配置方法。用户负责密钥环境及数据目录 ACL。
- 启动顺序：配置校验 → 存储独占 → 打开 Session → 监听就绪；任何失败释放已获取资源。
- 同库第二进程必须 fail-fast 且不写库；不能仅靠端口占用保证（可能换端口）。
- 核查底层锁；若不足，采用验证过的跨进程锁方案，崩溃后不能仅凭锁文件年龄强制抢锁。锁实现/依赖选择必须记录理由。
- SIGINT/SIGTERM：停止接受新请求、等待在途 commit、关闭 Session 与监听。强杀验证后数据应可恢复。
- Windows 文件删除必须走回收站；测试不得使用 rm/unlink/rmtree/临时目录直接删除 API。尽量保留测试产物在 data/test-runs/ 并忽略版本控制。

### pi 桥接工具
- assistant_todo_create(title,operationId)、assistant_todo_list(status?,limit?,cursor?)、assistant_todo_get(id)、assistant_todo_complete(id,operationId)。
- operationId 是一次逻辑操作的标识，重试必须复用，不能仅凭 title 去重，也不能承诺同一句微信重复投递自动去重。
- 工具说明明确创建新事项与重试的区别。若用 toolCallId 派生 ID，必须保留显式 operationId 重试入口，并测试新的 toolCallId 复用旧 operationId。
- fetch 设置超时（建议10秒）并合并 pi 的取消信号；首版不自动重试 mutation。
- 超时/取消可能发生于提交后：返回结果未知提示，指导用同 operationId 重试；不得声称写入失败或没发生。
- 服务离线工具清晰失败，不伪造待办结果；结构化结果与模型文本一致，列表有界。
- 工厂仅注册工具，不启动服务/socket/timer；按官方 ExtensionAPI 实现，无终端交互依赖。
- 建议独立 extensions/durable-assistant/ 包（peerDependencies 声明宿主包），避免 playground 的 pi-ai 运行依赖与扩展宿主依赖混淆。先用 pi -e 显式加载，不改全局设置。

## Planned files

以下为建议边界，实施时允许合并小文件，避免为模式而抽象：
- src/assistant/store.ts：Document、事务化待办操作、幂等。
- src/assistant/server.ts：HTTP、鉴权、输入校验和生命周期。
- src/assistant/main.ts：环境配置和信号处理。
- extensions/durable-assistant/package.json、index.ts：宿主桥接工具和 peer 约定。
- tests/assistant/*.test.ts：存储、HTTP、桥接、跨进程测试与必要 fixture。
- docs/assistant.md：安装、启动、验收、故障恢复、边界。
- package.json / lock / tsconfig：最小必要的脚本与测试类型检查；依赖仅在证明需要后增加。
- README.md：加入入口链接；不重写原有教学内容。

## Phases

### Phase 1: API、宿主与独占验证
- [x] 验证 Session + Document 不需要 Harness/provider 可完成写入、关闭、重开。
- [x] 验证事务异常不会部分落库，提交并发顺序与 Document 枚举能力。
- [x] 查明 SQLite/存储跨进程排他行为，以不同端口/相同数据库做实测。
- [x] 确定数据组织、分页、锁方案和扩展类型检查方式，记录确切版本与证据。
- [x] 检查已安装微信插件的发送者鉴权与宿主模式；不自动登录/占用连接。
- **Status:** complete（2026-10-08）。证据见 progress.md「Phase 1 证据」，教训见「Phase 1 的关键发现」。
- 门槛：关键 API 或独占无法验证则停在此阶段，不能换成另一个架构悄悄继续。（未触发）

### Phase 2: 持久业务层与独立服务
- [x] 实现待办事务、持久去重、查询分页和输入上限。
- [x] 实现本机鉴权 API、超时/错误映射和安全关闭。
- [x] 实现 fail-fast 独占及启动失败清理；新增服务启动脚本。
- **Status:** complete（2026-10-08）。V01–V13 全通过；两处实现决定（Windows 无法软件投递信号、`connection: close` 使 503 分支不可达）见 progress.md。

### Phase 3: pi 桥接
- [x] 注册四个工具，正确传递 operationId、取消、错误和结构化结果。
- [x] 明确加载路径、peerDependencies 与测试类型检查范围。
- [x] 通过本机假 ExtensionAPI/真实加载检查验证，不要求真实模型和微信。
- **Status:** complete（2026-10-08）。V14–V16 全通过，含**真实 pi 加载器**加载与真实 HTTP 往返；另用真实 `pi -p` 做过一次端到端烟雾。

### Phase 4: 自动化验证
- [x] 执行 verification.md V01–V16，修复后重跑相关测试与全量类型检查。
- [x] 包括子进程硬退出、不同端口同库、并发重复操作和提交后响应丢失。
- [x] 测试保留证据和隔离数据；不访问真实用户库、模型 key 或微信账户。
- **Status:** complete（2026-10-08）。`npx tsc --noEmit` exit 0；`npm test` → 52 tests / 52 pass / 0 fail / 0 skipped（~55s）。

### Phase 5: 文档与人工微信验收
- [x] 写双进程启动、token 设置、pi -e、/wechat 登录和启动说明。→ `docs/assistant.md`（317 行，10 节）。
- [ ] 在用户授权并具备微信连接后执行 verification.md M01–M05。
- [x] 写结果/限制/未完成项，不把模拟测试当微信真实验收。→ `docs/assistant.md` §9/§10 + progress.md。
- **Status:** 文档完成；**人工微信验收 blocked，待用户明确授权**（涉及真实微信登录与占用连接）。
- 未获登录/发消息授权时标记人工验收 blocked，而非整个版本全通过。（已按此执行）

## Acceptance

自动化通过不等于微信上线：分别报告「服务/桥接验证通过」和「真实微信验收通过」。
必要门槛：typecheck、存储原子性/恢复/独占、HTTP 鉴权和限制、桥接错误与重试语义、真实微信创建→重启→查询→完成。
验证细节见 verification.md。最终交付前检查 git diff，不自动 commit。

## Risks and follow-ups

- 微信插件与宿主升级兼容性需在实施/验收时核实，不能仅凭工具已加载推断连接可用。
- 同 operationId 幂等不等于微信入站消息 exactly-once，也不等于所有 pi 工具 durable。
- 提醒/通知出口是下一独立里程碑；先确认合法接收者和主动发送限制，再设计 outbox。
- CRUD 首版只用 Session kernel；以后 durable Task 执行器需单独设计和测试，不借用本版通过证据。
- 全局 pi 扩展多且有其他能力；本版不宣称为现有全部工具建立了微信安全沙箱。

## Historical corrections

旧计划记忆 CLI 和早期 A/B/C 标签已失效。Document 注入仍消耗 token；现有 hermes-memory 已是长期记忆方案；外挂 durable 不会自动恢复 pi agent 回合；未实测缓存收益不得当成架构保证。
