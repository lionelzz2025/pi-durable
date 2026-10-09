# 实施模型交接

## 当前授权（截至 2026-10-08）

**Phase 1–4 与 Phase 5 的文档部分已实施完毕并已验证。** 早先的「计划待确认」状态已解除（用户 m00143 要求细化计划与验证，m00163「开始实施」）。

**仍然需要用户明确授权才能做的三件事，不得自行动手：**

1. **M01–M05 人工微信验收** —— 涉及真实微信登录、占用现有微信连接、发送真实消息。这是本版唯一残余的验收项。
2. **git 提交** —— 计划明确要求「不自动 commit」。当前改动全部未提交，提交方式由用户决定。
3. **修改全局 pi 配置** —— `extensions/durable-assistant` 尚未注册进 `~/.pi/agent/settings.json`（本版刻意未改）。现在要用得靠 `pi -e ./extensions/durable-assistant`。

无子代理授权。默认由主模型实施，不自行委派。

## 一句话状态

**代码、测试、文档都完成了；唯一没做的是需要用户授权才能做的真实微信验收。**
所以当前只能说「服务 / 桥接已验证」，**不能说「微信端已验收」**。

## 必读顺序

1. 当前用户消息与全局 / 项目 AGENTS.md（**Windows 删除必须走回收站**，禁止 `Remove-Item -Force`、`rm -rf`、`fs.rm` 等；本条在实施过程中被违反过一次，见 progress.md）。
2. 本目录 `progress.md` 最新状态 → `task_plan.md` 的 Phases 状态 → `verification.md` 的 V01–V16 结果与「已知缺口」。
3. `findings.md` 顶部的「Phase 3–5 已确认事实（全部实测）」——服务契约、编码陷阱、宿主加载器机制都在那里。
4. `docs/assistant.md`——面向使用者的启动/操作/排错文档，已逐条实跑核验过。
5. 实施或改动 pi 扩展时按宿主要求完整读取官方相关文档 / 示例。

仓库 `D:/tools/pi-durable`；`PLAN_ID=2026-10-08-personal-assistant-memory-v0-1`。
需要规划技能时用该明确 PLAN_ID 解析，不新建竞争计划。

## 架构（已落地）

```text
微信 → pi-wechat-assistant(已装 0.3.1，未改) → pi → extensions/durable-assistant → 本机服务(127.0.0.1) → SQLite
```

- 服务：`src/assistant/{config,lifecycle,main,server,storage,store}.ts`，`npm run assistant` 启动。
- 桥接：`extensions/durable-assistant/{index,client}.ts` + 手写 `host-modules.d.ts`，注册 4 个工具
  （`assistant_todo_create/list/get/complete`）。
- 测试：`tests/assistant/*.ts`，`npm test`。
- **不是**旧版 B 的「durable 直连微信」。不深导入或改微信插件，不新造 agent loop。
- 现有记忆继续用既有系统，不重复实现 MemoryDoc，也不得宣称注入记忆不花 token。

## 已确认事实 vs 尚未验证

**已实测确认（含证据文件）**

- Session kernel 免 Harness 可用；事务中途抛错不落盘；跨进程存储独占与 SIGKILL 后锁释放。
- 服务契约：两个写接口**都强制 `operationId`**；同 id 同内容回放、同 id 不同内容 409、新 id 同内容会新建。
  `cursor` 与 `(status, limit)` 绑定。所有路由含 `/health` 都要 Bearer token，带 `Origin` 被 403，仅监听回环。
- `extensions/durable-assistant/client.ts` **零 import**（只用全局 `fetch`/`AbortSignal`/`TextDecoder`）。
- pi 的真实扩展加载器可被测试直接调用（`<pi>/dist/index.js` 的 `discoverAndLoadExtensions`）；
  扩展目录按**包**加载，故 host 包必须写成 `peerDependencies: "*"`，否则 pi 启动告警。
- V16 的 4 项、V14/V15 的 16 项、V01–V13 全通过；另有配置解析单元测试 5 项。
  `npm test` → **52 pass / 0 fail / 0 skipped**；`tsc --noEmit` 退出 0。
- 真实 `pi -p` + `-e` 端到端烟雾通过（创建待办 → 独立 API 查库确认落库）。

**尚未验证 / 明确缺口（不得当已知前提）**

- **M01–M05 完全未做**：微信端创建 → 重启服务 → 查询 → 完成，一次都没在真实微信上跑过。
- V13 的 503 `service_unavailable` 分支：`connection: close` 使其几乎不可达，**仅代码检查覆盖**，没有自动化断言。
- V13「优雅退出」在子进程层面：Windows 无法向另一进程投递 SIGTERM/SIGINT，故该部分在进程内验证接线与排空。
- 同 `operationId` 幂等**不等于**微信入站消息 exactly-once，也**不等于**所有 pi 工具 durable（全局还有别的扩展工具）。
- 未建立「现有全部工具在微信下的安全沙箱」——不要宣称有。

## 下一步：等用户二选一

1. 授权 M01–M05 → 按 `verification.md` 的人工验收节执行（唯一测试前缀、不碰真实待办、不抢别人连接）。
2. 提交代码 → 先 `git status` / `git diff` 核对，再按用户指定的分支与信息提交。

若用户要求继续开发新能力（提醒 / 通知出口 / Task 执行器），那是**新里程碑**：
需先独立设计并测试，不得借用本版（CRUD）的通过证据，也不得把本版 52 项测试当作新能力的验证。

## 停止边界

- 仅修改项目文件；不安装全局包、不登录微信、不抢已有连接、不发送真实消息、不自动 commit。
- 新增依赖需有必要性证据；源码按已有风格。
- 测试数据写 `data/test-runs/<run-id>/` 并**保留不清理**（`data/` 已被 .gitignore 忽略）。
- 凭据不可写入 git / 日志 / 计划文件。
- 若事实要求实质改架构或范围，记录下来并请用户确认，不能静默变更。

## 验收报告格式

区分四种状态：计划 / 已实现 / 自动化通过 / 真实微信通过。
最终列出执行命令与结果、未通过或 blocked 项、运行方法、残余风险；没有真实微信条件就明确保留 M01–M05 为 blocked。
