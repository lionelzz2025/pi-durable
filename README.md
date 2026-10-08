# pi-durable 学习项目

用 `@earendil-works/pi-durable` 从零搭一个"可持久化 AI Agent"的最小工程，并附 5 个可运行示例（最后一个接真实模型）。

> 版本：`@earendil-works/pi-durable@1.1.0`（官方标注 **Experimental**，API 会变）
> 环境：Node **≥ 22.6**（用到内置 `node:sqlite`）+ TypeScript

---

## 0. 一分钟跑起来

```bash
npm install          # 装依赖
npm run hello        # 01 最小问答（零 API Key，用 faux 假模型）
npm run durable      # 02 SQLite 落盘 + 重开继续同一段对话
npm run crash        # 03 中途"崩溃" + 重开后自动续跑（核心卖点）
npm run tools        # 04 接上 read/write/edit/bash 真实文件工具
npm run real         # 05 接真实模型（FastHub / deepseek-v4.1-flash，需 API Key）
npm run typecheck    # tsc --noEmit
```

01–04 用 `fauxProvider()` 这个"剧本模型"，不需要任何密钥就能跑通。05 会真的发请求，需要先 `export FH_NOVOSNS_API_KEY=...`（见 [第 6 节](#6-换成真实模型)）。

---

## 1. pi-durable 到底是什么

一句话：**一个"先落盘、后展示"的 Agent 运行时。**

普通 Agent 框架的风险是：模型流式输出到一半进程挂了，这一轮白干。pi-durable 把「对话、模型轮次、工具调用、你自己的状态」在展示之前就写进存储；进程死了重开，**从断点接着跑**。

它站在两个库之上：

| 依赖 | 作用 |
|---|---|
| `@earendil-works/pi-ai` | 模型访问层（provider / 模型目录 / 消息类型 / TypeBox） |
| `@earendil-works/chord` | 文档状态与 `Context`（取消传播） |

安装命令（实际执行过的）：

```bash
npm install @earendil-works/pi-durable
# 官方推荐同时显式装两个 peer：
# npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

> 注意：`@earendil-works/pi-durable` 会自己带上 `pi-ai` 和 `chord` 作为依赖，但 **不要为此写死版本号**，让包管理器解依赖即可。本项目的 `package.json` 只把 `pi-durable` 列为 dependency。

---

## 2. 心智模型（8 个概念）

| 概念 | 是什么 | 类比 |
|---|---|---|
| **Harness** | 一个打开的存储 + 在其上跑 Agent 的机器 | 服务器进程 |
| **Conversation** | 一段对话，本质是一串**不可变 Entry** | 会话线程 |
| **Entry** | 一条不可变记录：`pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system` / `pi.reset` / 自定义 | 消息 |
| **Commit** | 一次原子写入：追加 entry + 改文档 + 建 task 要么全成要么全不成 | 数据库事务 |
| **Document** | 存在对话旁边、随 commit 变化的类型化 JSON 状态（`pi.agent` / `pi.inbox` / `pi.live` / `pi.usage` …） | 会话级 KV |
| **Task** | 每步都存 checkpoint 的持久状态机；重启从最后一个 checkpoint 继续 | 工作流实例 |
| **Submission** | 你交给对话的输入（user input 或 entry 写），是**可等待的** | 作业句柄 |
| **Extension / Registry** | 命名的工具/提示词/钩子/任务打包；Registry 是本进程装了哪些包 | 插件系统 |

关系一句话：**你 `submit` 一个 input → Harness 起一个 `pi.generation` task 调模型 → 模型要调工具就派发 `pi.tool` 子 task 并等它们 → 再回 `pi.generation` → 写入 `pi.assistant` → submission 变 `done`。**

```
submit(input) → pi.user
  pi.generation → pi.system(提示词/工具变了才有) , pi.assistant(工具调用)
    pi.tool × n → pi.tool-result × n      (由 generation 拥有并等待)
  pi.generation → pi.assistant(最终答案) → submission done
```

**Agent** 是"这段对话以什么配置运行"：模型、思考等级、选了哪些 extension、开放哪些 tool、instructions、cwd。它按**名字**存在 `pi.agent` 文档里，每次用的时候再对照 Registry 解析。

---

## 3. 一个 pi-durable 工程长什么样

```
pi-durable/
├── package.json          # "type": "module"，Node ≥22.6
├── tsconfig.json         # module/moduleResolution: nodenext, noEmit
├── data/                 # SQLite 落盘目录（示例用，已 gitignore）
├── src/
│   └── providers/
│       └── fasthub.ts         # 自定义 OpenAI 兼容 provider（FastHub 网关）
├── examples/
│   ├── 01-hello.ts            # 最小问答
│   ├── 02-durable-sqlite.ts   # 落盘 + 重开继续
│   ├── 03-crash-resume.ts     # 崩溃续跑 + requestId 幂等
│   ├── 04-coding-tools.ts     # 文件/Shell 工具
│   └── 05-real-model.ts       # 真实模型 + 跨进程记忆
└── README.md
```

要点：

- **ESM**：`"type": "module"`。相对导入必须带扩展名（`./foo.ts`）。
- **直接跑 TS**：Node 22.6+ 原生剥离类型，`node examples/01-hello.ts` 即可，无需 ts-node/tsx。
- **`tsconfig.json` 用 `noEmit`**：TS 只负责类型检查（`npm run typecheck`），产物不存在。
- **`verbatimModuleSyntax: true`**：类型导入必须写 `import type`，避免运行时残留导入。

### 每个应用都遵循的 5 步骨架

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;                 // 1. 取消上下文（永不取消）

const models = createModels();                      // 2. 模型目录
const registry = createRegistry();                  // 3. 注册 extension（工具/提示词/钩子）

const harness = await Harness.open(                 // 4. 打开 Harness（存储 + 模型 + registry）
  new MemoryStorage(),                              //    换 SQLite 就是持久化
  { models, registry },
  context,
);

const root = await harness.root(context, {          // 5. 拿根对话（首次调用时创建）
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const settled = await (
  await root.submit({ type: "input", content: "你好" }, context)
).wait(context);

await harness.close(context);                       // 一定要关
```

---

## 4. 逐个示例讲解

### 01 — 最小问答（`examples/01-hello.ts`）

`npm run hello` 输出：

```
answer: The capital of France is Paris.
transcript entries: pi.user, pi.assistant
```

三个容易踩的坑，全在这一个文件里：

1. **`Harness.open(storage, options, context)` 的第一个参数是存储对象**，不是路径。持久化要显式用 `openNodeSqliteStorage(path)`。
2. **`submission.wait(context)` 返回的是 `SettledSubmissionRecord`**，其中 `settled.answer` 是 **`EntryId`（字符串）**，不是消息对象！
3. assistant 消息**已经由内置 generation task 写入**了。你不需要再 commit 一遍——用 `tx.entry(AssistantEntry, settled.answer)` 把它**读**回来（这也是官方 README 的写法）：

```ts
const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
const message = entry?.model?.[0];        // AssistantMessage
const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
```

> `commit()` 在这里当"带事务的读"用——它返回回调的返回值。

### 02 — 落盘 + 重开继续（`examples/02-durable-sqlite.ts`）

`npm run durable` 输出：

```
[phase 1] answer: My name is Pi.
[phase 1] closed. Transcript on disk: D:\tools\pi-durable\data\conversation.sqlite
[phase 2] found prior transcript: pi.assistant, pi.user
[phase 2] answer: You told me your name was Pi.
```

关键点：

- 两段 `Harness.open` / `close` **完全独立**，中间只靠 `data/conversation.sqlite` 传递状态。
- `harness.root(context)` **第二次调用返回同一段对话**（不带 `agent` 也行，配置已经在 `pi.agent` 里了）。
- 历史重放是自动的：第二问的 generation task 需要读整条 transcript，它直接从磁盘拿。
- `root.entries({}, 10, undefined, context)` **默认最新在前**（newest first），所以输出是 `pi.assistant, pi.user`。

存储后端对照：

| 后端 | 导入 | 说明 |
|---|---|---|
| Memory | `MemoryStorage`（包根） | 不持久化，退出即忘 |
| SQLite | `openNodeSqliteStorage(file)` from `.../storage/sqlite/node` | 单文件；WAL + `synchronous=NORMAL`，**进程崩溃能活**，断电可能丢最后一笔 |
| JSONL | `openNodeJsonlStorage(dir, context)` from `.../storage/jsonl/node` | 单目录追加文件；`{ fsync: true }` 每笔 commit 前 flush |
| Cloudflare | `openDurableObjectSqliteStorage(ctx.storage)` | Durable Object 的存储事务 |

> 同一份存储**同一时刻只能被一个进程拥有**，没有跨进程锁。

### 03 — 崩溃续跑（`examples/03-crash-resume.ts`）—— 核心卖点

`npm run crash` 输出：

```
[phase 1] admitted submission: 8
[phase 1] closed mid-run — the input is committed, the answer is not
[phase 2] requestId is idempotent: true
[phase 2] scheduler: running | live submissions: 1
[phase 2] recovered answer: 4
```

它做的事：

1. phase 1 提交问题后**不 wait**，直接 `close()` —— 等价于进程崩了。此刻 input 已落盘、答案没有。
2. phase 2 新开 Harness，先 `harness.resume()` **启动任务调度器**（`resume()` 幂等），未完成的工作重新跑。
3. `harness.submission(id, context)` 用 ID **重新拿到**那个 submission，再 `wait` 就能拿到恢复出来的答案。

两个关键 API：

- **`harness.resume()`** —— 文档原话："Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler; submitting or waiting starts it too." 也就是说 `submit`/`wait` 也会隐式启动调度器。
- **`requestId` 幂等** —— `root.submit({ type: "input", content, requestId: "q-2+2" }, ctx)`。重启后用同一个 requestId 再提交，**返回的是原 submission 而不是新提交**（`same.id === submissionId` 为 true）。这是做"可安全重试"的关键。

其它持久化保证（来自官方 README）：

- 部分答案/工具输出默认**最多每 100ms 提交一次**；崩一次最多丢这个窗口。可用 `settings.progress` 调。
- 每段对话在 `pi.provider` 里持久化一个 UUIDv7 作为 pi-ai 的 `sessionId`，用于 provider 端 prompt-cache 与会话亲和；跨 reopen / 重试 / reset / compaction / 换模型都存活。

### 04 — 真实文件工具（`examples/04-coding-tools.ts`）

`npm run tools` 输出：

```
offered tools: read, write, edit, bash
prompt sections: instructions
answer: package.json declares @earendil-works/pi-durable as its runtime dependency.
transcript: pi.user -> pi.system -> pi.assistant -> pi.tool-result -> pi.assistant
model messages: 5
```

三件事：

1. **工具来自 `CodingTools` 这个 extension**：

```ts
import { CodingTools } from "@earendil-works/pi-durable/tools";
const registry = createRegistry();
registry.install(CodingTools);   // 默认每段对话都会选中所有已安装 extension
```

2. **工具通过"每次调用现场构建的 `ExecutionEnv`"接触世界**，靠 `HarnessOptions.env` 提供：

```ts
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
await Harness.open(storage, {
  models, registry,
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
}, context);
```

> **不提供 `env`，内置工具会直接返回 error result。** 换成容器实现即可沙箱化。

3. **每次工具调用是一个独立的持久 task**：
   - 调用意图在 `execute()` 之前就提交；
   - 进程死在调用中途时：声明了 `replay: "safe"` 才会重跑，否则模型收到 `interrupted` 错误结果 + 已提交的输出；
   - `execute()` 抛异常 → 给模型一个错误结果（而不是炸掉整轮）。

### 05 — 真实模型（`examples/05-real-model.ts`）

前四个例子都用剧本模型，这一条真的发请求：**FastHub 网关上的 `deepseek/deepseek-v4.1-flash`**，也就是 pi 自己此刻在用的那个模型和那份凭据。

```bash
export FH_NOVOSNS_API_KEY=sk-fh-...
npm run real
```

输出：

```
[phase 1] model: fasthub-novosns / deepseek/deepseek-v4.1-flash
[phase 1] answer: Got it, Pi—I'll remember your name for this conversation.
[phase 1] closed. Transcript on disk: D:\tools\pi-durable\data\real-model.sqlite
[phase 2] replayed from disk: pi.assistant, pi.system, pi.user
[phase 2] answer: You told me your name is Pi.
[phase 2] usage: {"fasthub-novosns/deepseek/deepseek-v4.1-flash":{"input":125,"output":128,
         "cacheRead":0,"cacheWrite":0,"reasoning":104,"totalTokens":253,"cost":{...全部 0}}}
```

两个 phase 是**两段独立的 Harness 生命周期**（第二个 `Harness.open()` 之前第一个已经 `close()`）。phase 2 能答出名字，唯一的可能来源是 phase 1 写进 SQLite 的 transcript —— 第 02 节那个论断的真实模型版本。

代码上跟 02 的差别只有一行：

```ts
models.setProvider(fasthubProvider());   // 原来是 fauxProvider({ ... })
```

provider 定义在 `src/providers/fasthub.ts`，里面的坑见下面第 6.2 节。

---

## 5. 自己写 extension：工具 + 系统提示词 + 钩子

```ts
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";

// 1) 自定义工具：defineTool 用 TypeBox 从 parameters 推断 args 类型，
//    Harness 在 execute() 之前校验参数。
const count = defineTool({
  name: "count",
  description: "从 1 数到 n",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async (args, api) => {
    for (let i = 1; i <= args.n; i++) api.output(`${i}\n`);  // 流式运行输出
    return {};                                               // 不返回 content 时，输出即结果
  },
});

// 2) Extension：把工具、提示词 section、钩子打包成一个具名包
const Coding = defineExtension({
  name: "coding",
  tools: [count],
  sections: [section("preamble", () => "你是一个简洁的编码助手。", { tag: false })],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => (isDangerous(call) ? { block: "需要审批" } : undefined),
    }),
  ],
});

const registry = createRegistry();
registry.install(Coding);
```

Extension 能带的东西：`tools` / `sections` / `hooks` / `wraps`（按名字装饰别的 tool 或 section）/ `tasks`（自定义持久任务）。

**系统提示词**由所有被选中 extension 的 section 按顺序渲染，**每次请求前**渲染；某段对话的 `instructions` 最后渲染。section 的变更会作为位置化 `pi.system` entry 存进 transcript，只发变化部分以保住 provider 的 prompt cache。

**工具覆盖**：后安装的同名工具会替换先前的；`wrapTool()` 装饰最终胜出的那个：

```ts
const Timing = defineExtension({
  name: "timing",
  wraps: [wrapTool(createBashTool(), (bash) => ({
    ...bash,
    execute: (args, api, ctx) => timed(() => bash.execute(args, api, ctx)),
  }))],
});
```

---

## 6. 换成真实模型

### 6.1 用内置 provider：只改 3 行

```ts
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());            // 读 OPENAI_API_KEY
// ...
await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });
```

可用的 provider 目录在 `@earendil-works/pi-ai/providers/*`，如 `anthropic` / `google` / `deepseek` / `azure` / `amazon-bedrock` / `cloudflare-workers-ai` / `github-copilot` 等。

### 6.2 自己的网关：FastHub / deepseek-v4.1-flash

内置目录里没有你的网关，所以 `models.setProvider()` 之外没别的入口 —— **`Models` 只认识你亲手交给它的 provider**。本项目走的就是这条路，完整实现在 `src/providers/fasthub.ts`。

```ts
import { createProvider, envApiKeyAuth, openAICompletionsApi, type Model } from "@earendil-works/pi-ai/compat";

export const fasthubFlash: Model<"openai-completions"> = {
  id: "deepseek/deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash (FastHub)",
  api: "openai-completions",
  provider: "fasthub-novosns",
  baseUrl: "https://fasthub.novosns.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },   // 该模型不计费
  compat: { /* 见下表 */ },
};

export function fasthubProvider() {
  // 泛型必须显式写：`openAICompletionsApi()` 返回的是整张 ProviderStreams 表，
  // 推不出单个 api，TApi 会退回 Api，然后 setProvider 拒收。
  return createProvider<"openai-completions">({
    id: "fasthub-novosns",
    name: "FastHub (novosns)",
    baseUrl: "https://fasthub.novosns.com/v1",
    auth: { apiKey: envApiKeyAuth("FastHub novosns API key", ["FH_NOVOSNS_API_KEY"]) },
    models: [fasthubFlash],
    api: openAICompletionsApi(),
  });
}
```

**类型从哪里导？** `Model` / `Provider` 从 `@earendil-works/pi-ai/compat` 导（它 `export * from "./index.ts"`），**不从 `/models`** —— `/models` 内部 import 了 `Model` 但没有 re-export，写 `import type { Model } from "@earendil-works/pi-ai/models"` 会报 `TS2724: has no exported member named 'Model'. Did you mean 'Models'?`。

#### `compat` 是全部难点所在

pi-ai 会从 baseUrl 猜这套兼容位；**猜不出来的 URL 会落到保守默认值**。所以自定义网关必须逐位显式声明。FastHub 实测结论：

| 字段 | 值 | 为什么 |
|---|---|---|
| `supportsDeveloperRole` | `false` | 网关拒收 `developer` 角色，系统提示词得走 `system` |
| `supportsReasoningEffort` | `false` | 没有 `reasoning_effort` 旋钮。**但推理仍在跑** —— 关掉这个开关后探针测到 47 个 reasoning token，`npm run real` 里是 104 |
| `maxTokensField` | `"max_tokens"` | 不接 `max_completion_tokens` |
| `thinkingFormat` | **不要设 `"deepseek"`** | 看起来最该设的一个，实测反而把 reasoning 打到 **0**，且思维内容渗进可见回复 —— 因为该端点在正文之外**本来就**吐 `reasoning_content` |

> `reasoning: true` + 不设 `thinkingFormat`，是个反直觉但实测正确的组合。验证方式是看 `harness.usage()` 里的 `reasoning` 计数：大于 0 就说明推理链路是通的。

#### 跟 pi 自己保持同步

pi 的同名 entry 在 `~/.pi/agent/models.json` 的 `fasthub-novosns` 下。两端用同一个 baseUrl 和同一个 `FH_NOVOSNS_API_KEY`；**端点或模型改名时两边都要改**，改完跑 `npm run real` 确认。

**每段对话可以配不同的 Agent**，用 `configure()` 一次 commit 改完：

```ts
await root.configure({
  model: { provider: "openai", modelId: "gpt-6-sol" },
  thinkingLevel: "high",
  extensions: { remove: [Coding] },      // 数组 = 精确选择；对象 = 在宿主默认上增删
  tools: [readTool, bashTool],           // 数组 = 只开放这些；{ remove: [...] } = 去掉一些
  instructions: "只读，不要改文件。",
  cwd: "/work/repo",
}, context);

await root.configure({ tools: null }, context);  // null 把字段清回宿主默认
const agent = await root.agent(context);         // 解析后的最终配置
```

**全局策略**走 `settings`（每次使用都读，永不落盘，可以用 getter 做成"活的"）：

```ts
const harness = await Harness.open(storage, {
  models, registry,
  settings: {
    extensions: [CodingTools],           // 默认选中集；不写 = 所有已安装
    retry: { maxRetries: 3 },
    compaction: { reserveTokens: 16384 },
    progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
    toolExecution: "parallel",           // 一个并行 round
    stream: { timeoutMs: 120_000 },
  },
}, context);
```

---

## 7. API 速查

```ts
// 打开 / 关闭
await Harness.open(storage, { models, registry, settings?, env?, conversationCreated?, now?, onReport? }, context)
await harness.close(context)                       // 优雅关闭；未完成工作留在存储里

// 调度
harness.resume()                                   // 启动任务调度器（幂等）

// 对话
await harness.root(context, { agent?, init? })      // 根对话（不存在则建）
harness.conversation(id, context)                  // 按 ID 取
harness.createConversation({ ownership, agent?, init? }, context)
root.id
await root.agent(context)                          // 解析后的 Agent
await root.configure(change, context)              // 改 pi.agent（一次 commit）
await root.submit(draft, context)                  // → Submission
await root.reset(handoff?, context)                // 新上下文（pi.reset）
await root.compact(instructions?, context)         // 手动压缩 → TaskId
await root.abort(context, opts?)                   // 撤回排队输入 + 停掉普通所有权范围
await root.waitForIdle(context)
await root.commit((tx) => ..., context)            // 原子写：entry / doc / task
await root.context(context)                        // ContextView: entries + messages
await root.entries(query, limit, cursor, context)  // 历史分页（默认最新在前）
await root.fork(at, options, context)
await root.viewState(context)                      // 可 dispose 的实时只读视图

// Submission
submission.id
await submission.wait(context)                     // → SettledSubmissionRecord
await submission.status(context)
await submission.abort(context)

// 恢复
harness.submission(id, context)                    // 重开后再拿回 submission
harness.abortSubmission(id, context, conversationId?)
await harness.waitForTask(id, context)
await harness.inspect(context)                     // { scheduling, tasks, submissions }
await harness.waitForIdle(context)
await harness.usage(context)
await harness.taskGraph(context)
await harness.snapshot(DocToken, conversationId, context)   // 读内置文档

// 类型化 entry token
import { UserEntry, AssistantEntry, SystemEntry, ToolResultEntry, ResetEntry, CompactionEntry, defineEntry } from "@earendil-works/pi-durable";
```

文档结果类型：

```ts
type SettledSubmissionRecord = SubmissionRecord & { status: "done" | "unanswered" };
// status: done 时 settled.type==="input" 且有 settled.answer: EntryId
// status: done 时 settled.type==="write" 只有 settled.entry: EntryId
// status: unanswered 时只有 settled.reason / settled.detail
```

---

## 8. 踩坑清单（我实际撞到的）

1. **`settled.answer` 是 `EntryId`（数字/字符串），不是 `AssistantMessage`。**
   想拿文本必须 `root.commit(tx => tx.entry(AssistantEntry, settled.answer))` 读回来，再取 `entry.model[0]`。
2. **assistant entry 已经被 generation task 写过了**，不要再 commit 一次答案。
3. **`tx.entry(token, id)` 是"读"**（返回 `TypedEntry | undefined`），不是写。写用 `tx.appendEntry` / `tx.entry` 的另一重载配合 entry draft。
4. **`root.entries()` 默认 newest-first**，需要正序传 `{ order: "ascending" }`。
5. **`MemoryStorage` 不持久化** —— 想要跨重启必须换成 `openNodeSqliteStorage` / `openNodeJsonlStorage`。
6. **不配 `env`，`read/write/edit/bash` 全部报错**（error result）。
7. **取消 `context` 只取消这次 await，不会取消工作**。要停工作用 `root.abort()` / `harness.abortTask()` / `submission.abort()`。
8. **一个存储同一时刻只有一个进程能拥有**，没有跨进程锁。
9. **Node 版本**：`openNodeSqliteStorage` 用内置 `node:sqlite`，需要 **Node ≥ 22.6**，运行时会打印
   `ExperimentalWarning: SQLite is an experimental feature`。项目里 Node 24 实测正常。
10. **TS 直接运行**依赖 Node 的类型剥离，因此**不能用 `enum` / `namespace` / 构造函数参数属性**这类需要代码生成的语法。示例全用 `const` 对象 + `type`。
11. **重启后必须重新安装同样的 extension**：extension 的 `tasks` 只有在装回去之后，pending task 才会继续。（对话只存 extension 的**名字**，不存代码。）
12. **自定义 provider 时 `Model` / `Provider` 得从 `@earendil-works/pi-ai/compat` 导**，不从 `/models`。
    `/models` 内部 import 了 `Model` 却没 re-export，报 `TS2724: has no exported member named 'Model'. Did you mean 'Models'?`
13. **`createProvider` 的 api 泛型推不出来**：`openAICompletionsApi()` 返回整张 `ProviderStreams` 表，
    必须显式写 `createProvider<"openai-completions">(...)`，否则 `models.setProvider()` 报
    `Type 'Provider<keyof ProviderStreams>' is not assignable to type 'Provider<"openai-completions">'`。
14. **自建网关的 `compat` 别靠猜**：从 baseUrl 推不出来的会落保守默认。而且反直觉的是，
    `thinkingFormat: "deepseek"` 在 FastHub 上反而把 reasoning 打到 0；换个字段就跑一次，
    用 `harness.usage().models["..."].reasoning` 判断推理链路是不是真的通了。

---

## 9. 下一步可以做什么

- **自定义文档（你自己的状态）**：`defineDoc` + `tx.doc(token, conversationId)`，和 transcript 一起进 commit，天然持久。
- **Hooks**：`hook(ToolTask, { beforeTool, afterTool })` 做审批、脱敏、审计。`onYield` 可以 `{ continue }` 续跑。
- **子任务 / 子 Agent**：`tx.createTask(...)`、`defineTask(...)`，用 `on` + `policy: "allSettled" | "failFast"` 表达依赖。
- **压缩（compaction）**：`root.compact(instructions?)` 或 `settings.compaction`，长对话自动摘要。
- **实时观察**：`root.watch(context)`（精确帧）与 `root.viewState(context)`（Chord 状态）。
- **用量计费**：`harness.usage(context)`，按 `provider/model` 与 tool 名汇总。
- **其它存储**：Bun / Cloudflare Durable Objects 都有对应适配器。

官方仓库里的 `test/examples/` 有一整套从简到繁的示例，本项目 01–05 是在那基础上精简出的"最短可运行路径"。

---

## 附：本项目的依赖清单

```jsonc
{
  "type": "module",
  "engines": { "node": ">=22.6" },
  "dependencies": {
    // pi-durable 声明了这两个作为自己的依赖，但示例和 src/ 直接 import 它们，
    // 所以这里也显式声明（同版本区间会被 npm 去重成同一份，不会出现两份 pi-ai）。
    "@earendil-works/chord": "^1.1.0",
    "@earendil-works/pi-ai": "^1.1.0",
    "@earendil-works/pi-durable": "^1.1.0"
  },
  "devDependencies": { "@types/node": "^24.0.0", "typescript": "^5.7.0" }
}
```
