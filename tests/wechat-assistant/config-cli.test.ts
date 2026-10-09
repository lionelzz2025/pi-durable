import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { test } from "node:test";
import { loadWechatConfig, DEFAULT_CONFIG, PROJECT_ROOT } from "../../src/wechat-assistant/config.ts";
import { runWechatCli } from "../../src/wechat-assistant/main.ts";
const value = { schemaVersion: 1, dataDir: "data", workspaceDir: "workspace", accountId: "bot", boundUserId: "user", model: { provider: "faux", modelId: "faux-1" } };
const file = async (content: unknown) => {
  const path = resolve("data/test-runs", `config-${randomUUID()}`, "config.json");
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(content)); return path;
};
test("config paths resolve relative to config, default is project anchored", async () => {
  const path = await file(value); const config = await loadWechatConfig(path);
  assert.equal(config.dataDir, resolve(dirname(path), "data"));
  assert.equal(config.workspaceDir, resolve(dirname(path), "workspace"));
  assert.equal(DEFAULT_CONFIG, resolve(PROJECT_ROOT, "data/wechat-assistant/config.json"));
  assert.deepEqual(config.shell, { enabled: false });
});
test("invalid schema, credentials in config and premature shell enable fail closed", async () => {
  for (const patch of [{ schemaVersion: 2 }, { token: "secret" }, { shell: { enabled: true } }, { boundUserId: "" }]) {
    await assert.rejects(loadWechatConfig(await file({ ...value, ...patch })));
  }
  await assert.rejects(loadWechatConfig("relative.json"));
});
test("limits use frozen defaults and reject inherited keys and invalid budgets", async () => {
  const config = await loadWechatConfig(await file({ ...value, limits: { modelRetries: 0, dailyCostUsd: 0.5 } }));
  assert.equal(config.limits.messageBytes, 32768);
  assert.equal(config.limits.modelRetries, 0);
  for (const limits of [{ messageBytes: -1 }, { modelRetries: 0.5 }, { concurrentConversations: 2 }, { constructor: 1 }, { dailyCostUsd: 0 }]) {
    await assert.rejects(loadWechatConfig(await file({ ...value, limits })));
  }
});
test("CLI refuses unauthorized login and unimplemented start without network", async () => {
  const path = await file(value);
  await assert.rejects(runWechatCli(["login", "--config", path]), /requires/);
  await assert.rejects(runWechatCli(["start", "--config", path, "--allow-wechat", "--legacy-stopped"]), /not available/);
  await assert.rejects(runWechatCli(["doctor", "--config", path, "--unknown"]), /Unknown/);
});
