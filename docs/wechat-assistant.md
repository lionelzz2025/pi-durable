# 独立 pi-durable 微信助手（开发中）

## 当前里程碑

B0–B5 已完成离线阶段验证；B6 的迁移/运维自动化仍在开发，B7 真实平台验收未做。它**不是完整交付**：真实微信、真实模型、正式数据迁移与现场 Ctrl-C 均未验收。不要把离线假传输测试当作正式切换许可。阶段状态以开发计划为准。

## 配置

默认配置为项目内 `data/wechat-assistant/config.json`，不随调用者 cwd 改变。也可传 `--config` 绝对路径。路径字段相对配置文件目录解析。

```json
{
  "schemaVersion": 1,
  "dataDir": ".",
  "workspaceDir": "../../workspace",
  "accountId": "填写微信机器人账号 ID",
  "boundUserId": "填写绑定用户 ID",
  "model": { "provider": "fasthub-novosns", "modelId": "deepseek/deepseek-v4.1-flash" },
  "shell": { "enabled": false }
}
```

账号/用户 ID 必须预先显式配置，扫码身份不匹配拒绝保存，不自动切换身份。首次获取 ID 需另行受控确认；当前不提供自动信任任意扫码者的模式。limits 允许覆盖 [冻结规格](wechat-assistant-spec.md) 中的值；B6 已将模型单次输出/请求超时/重试参数限幅、每 generation 的模型请求保守计数与 UTC 日费用**上界预留**接入 daemon，并覆盖压缩请求。价格目录未知的非 faux 模型会拒绝调用，必须先提供可信非零价格；预留按模型最大上下文及重试次数计，不根据单次成功回执退回，可能提前耗尽预算。提供商若超出声明上界或不遵守选项，无法保证绝对费用上限；daemon 的单 owner pump 会按持久 task 起始时间标记超时并请求取消，但工具/提供商的取消为协作式，不保证硬中断，N19 仍待实际超时故障注入。shell 默认关闭；只有本机配置开启、在同一运行进程的 TTY 查看完整命令与参数并二次确认后，才允许一次执行。它不是沙箱，命令可产生外部副作用；未提供交互式 TTY 时不要启用 shell。工作区被视为本机受信任目录；读写和附件发送拒绝常见敏感路径（如 `.env`、`.git`、`.ssh`、`.pi`、`*.pem`）及 symlink/junction，但不是秘密内容分类器，也不承诺抵御同机恶意进程并发替换目录的竞态。不得把凭据目录放入工作区。

```text
npm run wechat-assistant -- doctor
npm run wechat-assistant -- status
```

诊断与状态不会访问微信网络。status 仅报告本地凭据，不宣称远端有效或服务在线；当前读取会建立空凭据库。doctor 只检验配置，不探测数据库或账号锁。backup/restore/migrate 为**离线维护命令**，不自动连接微信；必须传 `--allow-migration` 和绝对源/目标路径，不能覆盖已存在的目标文件。

## 离线备份、迁移与回滚（测试库已验证，正式数据需另行授权）

停止旧服务并核对其账号/进程归属后，使用不同于旧库和新库的绝对路径保存备份。不可直接复制 WAL 模式下的主 `.sqlite` 文件，也不可在旧服务仍运行时强制迁移。下列路径仅为示例，**不要在未授权时照抄执行到真实数据库**：

```text
npm run wechat-assistant -- backup --config D:/tools/pi-durable/data/wechat-assistant/config.json --allow-migration --source D:/path/old/assistant.sqlite --destination D:/path/safe/old-backup.sqlite
npm run wechat-assistant -- migrate --config D:/tools/pi-durable/data/wechat-assistant/config.json --allow-migration --source D:/path/old/assistant.sqlite --destination D:/path/safe/migration-backup.sqlite
npm run wechat-assistant -- restore --config D:/tools/pi-durable/data/wechat-assistant/config.json --allow-migration --source D:/path/safe/migration-backup.sqlite --destination D:/path/new/restored.sqlite
```

`migrate` 先备份旧库，再从备份导入旧待办及 operation 回执；新库中的 `TodoIndex`、原 ID/时间/状态、回执及 hash marker 一次事务提交，失败不写一半。同一内容再次调用导入原语是幂等的，但 CLI 不覆盖已存在的备份路径。`restore` 只生成新的库文件，不替换现有正式库。回滚时先停止新实例、记录新库相对旧库新增/修改的待办、记忆、回复和提醒等差异，再重新启动保留的旧栈；新数据**不会**自动回流旧库。导入不迁移 pi transcript 或 hermes-memory。失败留存的部分备份需要人工检查并按回收站规则处理，不自动删除。


## 真实连接必须单独授权

以下是手动操作说明，不是本轮已执行动作。先停止旧 pi 微信插件，禁用其自动启动，确认同账号没有别的客户端轮询。新账号锁仅对遵守协议的新实例有效，不能自动防止旧端重新启动，也不会杀进程。

```text
npm run wechat-assistant -- login --allow-wechat --legacy-stopped
npm run wechat-assistant -- start --receive-only --allow-wechat --legacy-stopped
# 完整 agent 路径还需显式模型授权，当前仅离线假传输测试过：
npm run wechat-assistant -- start --allow-wechat --legacy-stopped --allow-model
```

login 本地显示 QR 内容，180 秒超时、过期需明确重试，不跟随重定向。凭据保存在 dataDir/credentials.sqlite（单行事务更新），不导入旧插件凭据。**明文，不是加密保险箱**；chmod 不等于 Windows ACL，需用户限定目录访问权限，不应放在共享/同步目录。

没有 `--allow-model` 时 agent 启动拒绝。`--receive-only` 仅把授权消息原子入库后推进游标；队列满停止并报错，重开继续旧游标；不调用 provider 或发送虚假的完成回执。若发现未完成 agent 工作则拒绝此模式。完整 agent 路径由本项目 Harness/Registry/模型 provider 和 durable outbox 承载，必须具备 `FH_NOVOSNS_API_KEY`，会触发真实模型/微信网络，**未经单独授权不得执行**。当前仅以 faux provider 和假微信离线验证。

停止使用前台 Ctrl-C；轮询取消后等待已开始入库事务，再关闭 Harness/释放账号锁。代码取消/关闭时序已离线测试；Windows 控制台真实 Ctrl-C 尚待现场验证，跨进程硬杀证明的是 OS 释放锁，不是优雅停止。

## 安全与恢复边界

- 正式数据库与旧待办库分离；默认不迁移、不覆盖、不删除。
- 同 OS 用户账号锁在 `~/.pi-durable/wechat-account-locks/`，不同业务目录仍共享，不能用旧 PID 或锁年龄抢占。
- 固定 API/CDN origin、拒绝重定向、有界响应；日志无 token/context/media key/消息正文。
- 接收能力测试使用 fake transport，没有验证平台 context 生命周期和远端幂等。
- 文字回复与媒体文件均使用 durable outbox；排队不等于送达，未知结果进入 `outcome_unknown` 而非自动重发。提醒缺少本人有效 context 时进入可查询的 blocked 状态。主动发送与平台 token 生命周期仍待真实验收。
- 当前全部验收状态以 [开发计划](../.planning/2026-10-08-personal-assistant-memory-v0-1/task_plan.md) 和 [验证方案](../.planning/2026-10-08-personal-assistant-memory-v0-1/verification.md) 为准。
