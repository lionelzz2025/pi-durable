# 个人助手（v0.1）：在微信里记待办

> **架构状态：本文仅说明已有的旧版 pi + HTTP 待办服务，不是新路线的运行手册。**
> 当前开发方向已改为独立 pi-durable 微信助手，包含会话/任务恢复与微信通道移植；目前仅更新计划，尚未实现。
> 见 [新开发计划](../.planning/2026-10-08-personal-assistant-memory-v0-1/task_plan.md)、[新验收方案](../.planning/2026-10-08-personal-assistant-memory-v0-1/verification.md)。
> 本文后续验收状态为旧快照；取证更正后旧 M01 通过、M02 通过判定撤回、M03–M05 未完成，详见规划目录 progress.md。

一个**持久化待办服务**，加上一层让 pi 能调用它的**桥接扩展**。你在微信里对 pi 说"记一下明天买牛奶"，待办会落到 SQLite 里；pi 或服务重启之后它仍然在。

这份文档只讲**怎么用**和**怎么判断它坏了**。设计取舍、备选路线、验证清单在 `.planning/2026-10-08-personal-assistant-memory-v0-1/`。

---

## 架构

```
你（微信）
   │  文字消息
   ▼
pi-wechat 插件            ← 已装好的第三方插件，本项目不改它
   │
   ▼
pi 进程
   │  调用工具 assistant_todo_*（HTTP，仅回环）
   ▼
extensions/durable-assistant/   ← 本项目新增的桥接扩展
   │
   ▼
个人助手服务（src/assistant/）  ← 独立进程，npm run assistant
   │
   ▼
SQLite  data/assistant/…
```

两个进程，一条边界：**HTTP over 127.0.0.1**。pi 不认识 SQLite，服务不认识 pi。任何一边都能单独重启。

---

## 前提

| 需要 | 说明 |
|---|---|
| Node | **≥ 22.6**（本机 v24.14.1）。用到内置的 `node:sqlite`，启动会打一条 experimental 警告，属正常。 |
| pi | 已安装且可用（`pi --help` 有输出）。桥接扩展通过 pi 的加载器加载。 |
| 微信通道 | 可选。没有微信也能用（见下方"不用微信也能用"）。 |

不需要装新的 npm 包：服务只用 Node 内置模块 + 仓库已有的 `@earendil-works/pi-durable`，桥接扩展的 `client.ts`**零 import**。

---

## 1. 启动服务

先生成一个 token，然后启动：

```bash
cd D:/tools/pi-durable

# 生成 token（43 字符 base64url，满足 32 字符下限）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

export ASSISTANT_TOKEN="把上面那串贴这里"
npm run assistant
```

看到这两行就是就绪：

```
[assistant] listening on http://127.0.0.1:4318 (data directory: D:\tools\pi-durable\data\assistant)
[assistant] the database is held exclusively by this process; press Ctrl-C to stop
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ASSISTANT_TOKEN` | **必填** | 至少 32 字符，仅可打印 ASCII（不含空格）。不满足就直接拒绝启动并打印生成命令。 |
| `ASSISTANT_PORT` | `4318` | 1–65535。 |
| `ASSISTANT_DATA_DIR` | `<项目根>/data/assistant` | 相对路径按项目根解析（不按 cwd）。数据库文件名固定。 |
| `ASSISTANT_HOST` | 固定 `127.0.0.1` | 不可配置——服务永远只回环可达。 |

配置非法时进程打印一条 `[assistant] ...` 并**以退出码 1 结束**，不会半启动。

### 停止

在拥有该终端的窗口按 **Ctrl-C**，服务会先排空在途请求再关闭：

```
[assistant] SIGINT received; draining in-flight requests, then closing
[assistant] stopped; the database lock is released
```

> **Windows 注意**：Node 无法把 SIGTERM 投递给**另一个**进程。`taskkill` 是硬杀，处理器不会运行——这仍然安全（每次写入都是单个事务，数据库锁由操作系统释放），只是不会有上面那两行日志。
>
> 所以**优先用 Ctrl-C**：从拥有该控制台的窗口敲，或让脚本把控制台信号交给服务自己处理。从外部强杀作为最后手段可以，但不要拿它当默认的收尾方式。

---

## 2. 让 pi 用上桥接扩展

桥接扩展**要读 `ASSISTANT_TOKEN`**，所以 pi 进程必须能拿到同一个值。

### 方式 A：临时试用（推荐先这样验证）

```bash
cd D:/tools/pi-durable
ASSISTANT_TOKEN="和服务一样的串" pi -e ./extensions/durable-assistant/index.ts
```

`-e` 只影响本次会话，不改全局配置。

### 方式 B：长期生效

把扩展目录加进 `~/.pi/agent/settings.json` 的 `packages`，并确保启动 pi 的环境里有 `ASSISTANT_TOKEN`。

> ⚠️ 不要把 token 写进 `settings.json`——那是明文、会被同步。用系统环境变量或启动脚本。

### 加载成功的判据

在 pi 里问：

```
列出我现在能用的 assistant 工具
```

应当看到四个：`assistant_todo_create`、`assistant_todo_list`、`assistant_todo_get`、`assistant_todo_complete`。

**加载失败不会静默**：缺少 token 时工具仍会注册（加载期不做任何 I/O），但**调用时**会明确报错告诉你 token 没设，而不是假装成功。

---

## 3. 四个工具

| 工具 | 参数 | 用途 |
|---|---|---|
| `assistant_todo_create` | `title`（必填，≤500 字符）、`operationId`（可选，≤128 字符） | 记一条待办 |
| `assistant_todo_list` | `status`（`open`/`done`/`all`，默认 `open`）、`limit`（1–100，默认 20）、`cursor` | 分页列出 |
| `assistant_todo_get` | `id` | 查单条 |
| `assistant_todo_complete` | `id`（必填）、`operationId`（可选） | 标记完成 |

### 在微信里怎么说

```
记一下：明天上午给妈妈打电话
我有哪些待办？
把"给妈妈打电话"标成完成了
```

pi 会自己挑工具。`operationId` 你不用管——见下一节。

---

## 4. 出错时它说的是什么意思

这是本项目最要紧的部分。工具**永远不会假装成功**，每次失败都会告诉你"这个操作到底有没有落库"。

| 情况 | 工具返回 | 待办落库了吗 |
|---|---|---|
| 服务没启动 / 端口不通 | `definitely_not_applied` | **肯定没有**——可以放心重试 |
| 服务返回 4xx（令牌错、参数错、id 不存在） | `definitely_not_applied` | **肯定没有** |
| 请求发出后连接断了 | `outcome_unknown` | **不知道** |
| 服务卡住、超时（8 秒） | `outcome_unknown` | **不知道** |
| 服务返回 5xx | `outcome_unknown` | **不知道** |
| 你（或 pi）取消了调用 | `cancelled`，且**不会**重试 | 取决于请求是否已发出 |

出现 `outcome_unknown` 时，工具会同时给你一个 **`operationId`**：

```
创建待办的请求超时了，结果未知。重试时请带上 operationId: 7f3c…
```

**照它说的做**：用同一个 `operationId` 再调一次。服务端按 `operationId` 去重，所以：

- 如果上次其实写成功了 → 返回**原来那条**，不会多出一条；
- 如果上次确实没写 → 现在正常创建。

同一条待办，两种结局，都不会重复。

用**同一个 `operationId` 做不同的事**（比如换了标题），服务会拒绝并返回 `operation_conflict` —— 这是保护，不是 bug。

---

## 5. 验证重启后还在

```bash
# 记一条（operationId 必填，见下节说明）
curl -s -X POST http://127.0.0.1:4318/v1/todos \
  -H "authorization: Bearer $ASSISTANT_TOKEN" \
  -H "content-type: application/json" \
  -d '{"title":"重启测试","operationId":"doccheck-restart-1"}'

# Ctrl-C 停掉服务，再 npm run assistant 启动，然后
curl -s "http://127.0.0.1:4318/v1/todos?status=all" \
  -H "authorization: Bearer $ASSISTANT_TOKEN"
```

那条待办应当还在。

> **Windows 上 curl 写中文会乱码**：git-bash / CMD 会把命令行里的中文按当前代码页（非 UTF-8）转成字节再交给 curl，服务收到的就是已经坏掉的字节。这与服务无关（从 Node 发的中文/emoji 全部正常），但照着上面 curl 例子在 Windows 上敲中文确实会存进乱码。稳妥做法：把 JSON 写进 UTF-8 文件再 `--data-binary @body.json`，或直接用 pi 的四个工具（那才是正常用法）。

**强杀也一样安全**：`taskkill /F` 之后重启，已提交的写入在、数据库锁也正常释放。这条有自动化测试覆盖（V13）。

**服务不会同时跑两份**：第二个进程拿不到数据库独占锁，会明确拒绝启动而不是两边写坏数据。这条也有测试覆盖（V04/V05）。

---

## 6. HTTP API 参考

所有 `/v1/*` 和 `/health` 都要 `Authorization: Bearer <token>`。仅接受 127.0.0.1。浏览器跨源请求（带 `Origin` 头）一律 403。

| 方法 | 路径 | 请求体 / 查询 | 成功响应 |
|---|---|---|---|
| `GET` | `/health` | — | `{"status":"ready","version":"0.1.0"}` |
| `POST` | `/v1/todos` | `{"title":"…","operationId":"…"}` | `{"todo":{…}}` |
| `GET` | `/v1/todos` | `?status=open\|done\|all&limit=1..100&cursor=…` | `{"items":[…],"nextCursor":"…"\|null}` |
| `GET` | `/v1/todos/:id` | — | `{"todo":{…}}` |
| `POST` | `/v1/todos/:id/complete` | `{"operationId":"…"}` | `{"todo":{…}}` |

### `operationId` 为什么是必填

两个写接口都要求 `operationId`，因为它是**唯一的去重依据**。服务不接受一个它无法去重的写入：没有这个键，"超时后重试"就只能靠猜，而那正是本设计要消除的东西。

- 字母表 `A-Z a-z 0-9 . _ : -`，1–128 字符（可以直接用 pi 的 `toolCallId`）。
- 同一个 `operationId` **重复提交同样内容** → 返回原来那条，不新建。
- 同一个 `operationId` **提交不同内容** → `operation_conflict`(409)。
- 换一个新 `operationId` **提交同样内容** → 会新建**第二条**（服务只按 id 去重，不按内容）。

> 走 pi 的四个工具时你不用自己生成：工具会从 `toolCallId` 派生一个，并在 `outcome_unknown` 时把它明确回复给你。

待办对象：

```json
{
  "id": "4db21461-0444-43bc-bf06-3b2cb30d752d",
  "title": "重启测试",
  "status": "open",
  "createdAt": "2026-10-08T…Z",
  "completedAt": null
}
```

错误一律是：

```json
{"error": {"code": "invalid_request", "message": "…"}}
```

错误码：`invalid_request`(400)、`not_found`(404)、`method_not_allowed`(405)、`operation_conflict`(409)、`invalid_cursor`(400)、`unauthorized`(401)、`cross_origin_forbidden`(403)、`payload_too_large`(413)、`unsupported_media_type`(415)、`service_unavailable`(503)、`internal_error`(500)。

**`cursor` 与首次查询绑定**：换了 `status` 或 `limit` 再带上旧 cursor 会得到 `invalid_cursor`。要换筛选条件就从头开始列。

**固定排序**：按创建时间升序（最早的在前面）。这不是可选项——底层 `scanDocuments` 只提供创建顺序，没有 `order` 参数，所以列表顺序是实测得到的性质，而非我们能调的参数。

**分页不是快照**：翻页期间若有别的写入（新建或完成），可能出现重复或遗漏。
契约只保证**没有并发修改时**不重不漏。单人使用、又不边翻页边改的话碰不到；要严格一致请一次性取完（`limit` 最大 100）。

---

## 7. 不用微信也能用

上面全部能力都不依赖微信。直接跟 pi 说"记一下 XXX"就行，只要 pi 进程有 `ASSISTANT_TOKEN`、服务在跑。

微信只是**入口之一**——这也是选这条路线的原因：先验证"持久化 + 能被 pi 调用"这条链路，再接入口。

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `[assistant] ASSISTANT_TOKEN is required.` | 没设环境变量。按提示生成一个。 |
| `[assistant] ASSISTANT_TOKEN must be at least 32 characters` | token 太短。用 `randomBytes(32)`。 |
| `[assistant] could not open the assistant database: …busy…` | 已经有一个实例在跑（或上次被强杀后残留的 socket 还没落定）。先确认没有第二个进程。 |
| `[assistant] could not start the listener: …EADDRINUSE` | 端口被占。换 `ASSISTANT_PORT`。 |
| pi 里调用工具报 "ASSISTANT_TOKEN is not set in this pi process" | pi 进程缺 token。设好之后**重启 pi**（token 在调用时读取，但环境变量要重新起进程才生效）。 |
| 工具报 `definitely_not_applied` / 连不上 | 服务没跑。`npm run assistant`。 |
| 工具报 `outcome_unknown` 并给了 operationId | 照旧带 `operationId` 重试，不要换新的。 |
| `operation_conflict` | 同一个 `operationId` 被用在不同的内容上。换一个 id，或改用原来那条。 |
| `invalid_cursor` | 列到一半改了 `status`/`limit`。去掉 cursor 重新列。 |

---

## 9. v0.1 **不做**什么

明确划出去的部分，避免误以为已有：

- ❌ **主动提醒 / 定时任务**——服务不会主动找你。没有调度器，没有通知发件箱。
- ❌ **长任务执行**——不开 shell、不跑子代理、没有审批流程。这里只有待办的增删查改。
- ❌ **长期记忆**——待办是待办，不是"记住用户偏好"。那走另一个机制（`pi-hermes-memory`）。
- ❌ **多用户**——鉴权等同"谁扫的微信谁的机器"，没有用户表。
- ❌ **自动装成系统服务**——需要你手动启动。
- ❌ **改微信插件**——`pi-wechat-assistant` 一行未改。

### 两个会随时间累积的东西（v0.1 没有清理能力）

这两项不是缺陷，是首版**故意**的取舍，但它们会一直长，所以必须说清楚：

1. **待办只增不删**——没有删除接口。做错了只能改成 `done`，记录仍在。
2. **`operationId` 回执永久保留**——这是幂等的**前提**：一旦淘汰旧回执，同一个 `operationId` 重试就会**再一次创建**待办。所以宁可持续增长，也不静默淘汰。

后果：`data/assistant/assistant.sqlite` 会随使用单调增长。单用户待办量下这不构成问题（一年每天十条也就是几千行）。真要清理，得停掉服务、自行处理数据库文件；本版不提供工具，也不会自动删。

---

## 10. 验证

```bash
npm run typecheck    # tsc --noEmit
npm test             # 52 项，含 V01–V16
```

`tests/assistant/` 按阶段分组：

| 文件 | 覆盖 |
|---|---|
| `phase1-session.test.ts` | 会话内核、事务原子性、崩溃后恢复 |
| `phase1-exclusivity.test.ts` | 第二个写入者被拒；强杀后锁释放 |
| `phase2-config.test.ts` | 配置解析：默认值、端口容错、token 校验；**默认数据目录不跟随 cwd** |
| `phase2-store.test.ts` | 待办语义、幂等、分页、并发 |
| `phase2-http.test.ts` | HTTP 契约、鉴权、错误码、body 限制 |
| `phase2-process.test.ts` | 真实子进程启动 / 强杀 / 恢复 |
| `phase2-shutdown.test.ts` | 优雅关闭只执行一次、在途请求排空 |
| `phase3-bridge.test.ts` | 四个工具的真实 HTTP 往返、错误语义、取消、超时 |
| `phase3-extension.test.ts` | 用**真实 pi 加载器**加载扩展并执行工具 |

测试全部使用 `data/test-runs/` 下的临时目录，不会碰 `data/assistant/`。

### 人工验收（需要你授权，涉及真实微信）

自动化测不到"pi 真的能用微信调用工具"这件事。以下五项需要你亲自确认：

| # | 步骤 | 期望 |
|---|---|---|
| M01 | 在微信里对 pi 说"记一下：X" | 回复确认，且能被 `assistant_todo_list` 查到 |
| M02 | 停掉助手服务，再从微信记一条 | 明确报"肯定没记上"，**不**假装成功 |
| M03 | 重启服务与 pi，问"我有哪些待办" | M01 那条还在 |
| M04 | 微信里说"把 X 标成完成" | 状态变 `done` |
| M05 | 用一个错 token 起 pi，再记一条 | 工具报鉴权失败，服务端无写入 |

**M01–M05 尚未执行。** 本版本不声称"微信端已验收"。
