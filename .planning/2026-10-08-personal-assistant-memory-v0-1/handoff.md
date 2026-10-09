# 实施模型交接：独立 pi-durable 微信助手

## 当前授权与状态

本轮用户要求：更新开发计划，基于路线 B pi-durable 完整开发，允许移植 pi 中的 wechat 插件代码。

用户已授权“提交后开始实施”。基线提交 `8cf4c1a`；B0 已实现并验证，B1 基础协议层实现并通过 6 项测试但仍 in_progress，B2–B7 未完成。当前新改动尚未提交；无子代理授权，默认主模型直接实施。真实微信/付费模型仍需对应授权。

## 唯一目标架构

微信 → 本项目微信适配器 → 持久 inbox → pi-durable Harness/会话/模型/工具/记忆/任务 → 持久 outbox → 微信。

不使用 pi TUI 作大脑，不要求 `pi -e`，不以旧 HTTP 桥接作为必需链路。独立进程重启自动恢复同一会话和未完成工作；移植协议代码不是加载 pi 扩展。

## 定位与阅读顺序

- cwd：`D:/tools/pi-durable`
- PLAN_ID：`2026-10-08-personal-assistant-memory-v0-1`
- PWF_PLAN_ROOT：`D:/tools/pi-durable`
- 先用 planning-with-files resolver 解析该目录，不创建竞争 root plan。
- 阅读当前用户消息/AGENTS.md → `task_plan.md` → `verification.md` → `progress.md` 顶部 → `findings.md` 当前裁决与源码核对。
- 旧方案只在 `legacy-task-plan.md`、`legacy-verification.md`、`legacy-handoff.md`；这些快照含过时状态，不是当前操作指令。

## 基线资产与证据边界

- `src/assistant/` 是旧 CRUD 服务，`extensions/durable-assistant/` 是旧 pi 桥接。保留，复用领域逻辑/事务/测试，不在新架构依赖它们的 HTTP 链路。
- `src/assistant/storage.ts` 自行实现 SQLite EXCLUSIVE + busy timeout/probe；底层 pi-durable 默认并无跨进程应用独占。提取 Storage 工厂后只交给 Harness 一次，不能另开 Session 管同库。
- `src/providers/fasthub.ts`、`examples/03-crash-resume.ts`、`examples/05-real-model.ts` 是已有范式；API 以实际安装版本为准。
- 旧自动化历史记录为 52 pass，本轮没有重跑。旧真实验收 M01 pass；M02 pass 已撤回（无桥接 pi 静默用了别的记忆/待办工具）；M03–M05 未完成。
- 现有 package.json/tsconfig 修改、未跟踪实现与文档均属于已有工作，不 reset/覆盖/清理。开始实施先核对 git status。
- 旧 progress 中 PID 仅为历史，不能据此杀进程或断言它现在在运行。

## 移植必知

来源 `C:/Users/hongchao.zhu/.pi/agent/npm/node_modules/pi-wechat-assistant`，0.3.1，MIT / Copyright (c) 2026 sj。保留许可，建立来源版本/文件 hash/差异清单，不运行时深导入全局路径、不修改已安装插件。

- 协议/媒体/消息处理可移植；index/commands/remote-commands/queue 依赖 ExtensionAPI/Context，重写。
- `client.ts#getUpdates` 在返回消息前异步保存 cursor/seen，并会清空超 10000 条的 seen 集合；不能照搬。新系统 inbox/cursor/context 在同一事务确认。
- auth.ts 有 fs.unlink，按 Windows 回收站规则改造，不能原样带入。
- 微信 context token 可失效。已发送但回执丢失是 outcome_unknown，未证明远端幂等前不可自动重发。
- 同账户两个状态目录不代表互斥；上线前必须明确旧插件停止及账号锁协调。

## 实施顺序与验收

B0 API/恢复验证 → B1 微信传输/生命周期 → B2 inbox/会话 → B3 待办/记忆 → B4 outbox → B5 媒体/工作区/审批/任务/提醒 → B6 迁移与自动化 → B7 真实微信。

B4 仅文字内测，不能当完整交付。N01–N20、W01–W08 全部尚未执行。阶段完成后立即更新 plan 的 Status/Next Step 和 progress 证据；测试不过不得打勾。交付前按 Scope 做逐项收尾审计。

## 停止与安全边界

- 登录、真实微信连接/消息、付费模型、迁移正式数据、修改全局设置、自启动安装、git commit 均需要相应用户授权。
- 实验/测试仅隔离库与 fake transport/faux provider；产物放 `data/test-runs/` 保留。Windows 删除一律回收站，不用 rm/unlink/Remove-Item 直接删。
- shell 默认关闭；工具缺失 fail-closed；禁止用别的全局记忆/待办系统填补缺失。
- 协议/恢复/锁验证失败，记录最小复现并暂停对应阶段；不得悄悄回退到 pi 大脑、内存队列或忽略发送未知结果。
- 本轮没有业务 bug 修复；未来修复后按 post-fix-prevention-review 技能审查防复发措施。

## 下一动作

继续 B1：凭据存储、身份/账号锁协调、配置/CLI 与生命周期；协议层及许可/hash 已落地，协议测试 6/6/typecheck 通过。不连接真实微信。先看 progress.md 最新状态、docs/wechat-assistant-spec.md 和 tests/wechat-assistant/recovery.test.ts。B0 新 4 项与串行全量 56/56、typecheck 通过；npm test 已固定串行避免旧进程耗时断言被主机并发争用干扰。
