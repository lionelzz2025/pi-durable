# 独立 pi-durable 微信助手（开发中）

## 当前里程碑

B0–B4 的离线阶段验证已通过（B4 仅文字内测）；B5 的媒体、工作区、任务/提醒及单进程 daemon 正在实现和审计。它**不是完整交付**：真实微信、真实模型、迁移/备份与现场 Ctrl-C 均未验收。不要把离线假传输测试当作正式切换许可。阶段状态以开发计划为准。

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

账号/用户 ID 必须预先显式配置，扫码身份不匹配拒绝保存，不自动切换身份。首次获取 ID 需另行受控确认；当前不提供自动信任任意扫码者的模式。limits 允许覆盖 [冻结规格](wechat-assistant-spec.md) 中的值；逐项实际限制及现场能力仍待 B6/B7 核对。shell 默认关闭；只有本机配置开启、在同一运行进程的 TTY 查看完整命令与参数并二次确认后，才允许一次执行。它不是沙箱，命令可产生外部副作用；未提供交互式 TTY 时不要启用 shell。工作区被视为本机受信任目录；读写和附件发送拒绝常见敏感路径（如 `.env`、`.git`、`.ssh`、`.pi`、`*.pem`）及 symlink/junction，但不是秘密内容分类器，也不承诺抵御同机恶意进程并发替换目录的竞态。不得把凭据目录放入工作区。

```text
npm run wechat-assistant -- doctor
npm run wechat-assistant -- status
```

诊断与状态不会访问微信网络。status 仅报告本地凭据，不宣称远端有效或服务在线；当前读取会建立空凭据库。backup/migrate 尚未实现，明确拒绝。

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
