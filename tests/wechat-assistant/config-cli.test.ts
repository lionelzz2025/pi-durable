import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
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
test("a subprocess launched from a different cwd resolves the same configured database and default path", async () => {
  const path = await file(value);
  const other = resolve("data/test-runs", `foreign-cwd-${randomUUID()}`); await mkdir(other, { recursive: true });
  const mainUrl = pathToFileURL(resolve(PROJECT_ROOT, "src/wechat-assistant/main.ts")).href;
  const configUrl = pathToFileURL(resolve(PROJECT_ROOT, "src/wechat-assistant/config.ts")).href;
  const script = `import {runWechatCli} from ${JSON.stringify(mainUrl)}; import {DEFAULT_CONFIG} from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({cwd:process.cwd(),defaultConfig:DEFAULT_CONFIG})); await runWechatCli(['doctor','--config',process.argv[1]]);`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, path], { cwd: other, timeout: 20_000 });
  const [where, doctor] = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(where.cwd, other);
  assert.equal(where.defaultConfig, DEFAULT_CONFIG);
  assert.equal(doctor.database, resolve(dirname(path), "data", "assistant.sqlite"));
});

test("invalid schema and credential-bearing config fail closed; shell flag is explicit", async () => {
  for (const patch of [{ schemaVersion: 2 }, { token: "secret" }, { boundUserId: "" }]) {
    await assert.rejects(loadWechatConfig(await file({ ...value, ...patch })));
  }
  await assert.rejects(loadWechatConfig("relative.json"));
  assert.deepEqual((await loadWechatConfig(await file({ ...value, shell: { enabled: true } }))).shell, { enabled: true });
});
test("limits use frozen defaults and reject inherited keys and invalid budgets", async () => {
  const config = await loadWechatConfig(await file({ ...value, limits: { modelRetries: 0, dailyCostUsd: 0.5 } }));
  assert.equal(config.limits.messageBytes, 32768);
  assert.equal(config.limits.modelRetries, 0);
  for (const limits of [{ messageBytes: -1 }, { modelRetries: 0.5 }, { concurrentConversations: 2 }, { constructor: 1 }, { dailyCostUsd: 0 }]) {
    await assert.rejects(loadWechatConfig(await file({ ...value, limits })));
  }
});
test("approval cannot open a second owner through the CLI", async () => {
  const path = await file({ ...value, shell: { enabled: true } });
  await assert.rejects(runWechatCli(["approvals", "--config", path]), /Usage/);
});
test("doctor and status report offline limits, never a fabricated running owner", async () => {
  const path = await file(value);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await runWechatCli(["doctor", "--config", path]);
    await runWechatCli(["status", "--config", path]);
  } finally { console.log = original; }
  const doctor = JSON.parse(lines[0]!); const status = JSON.parse(lines[1]!);
  assert.equal(doctor.runtime, "offline-not-probed");
  assert.equal(doctor.shell, "disabled");
  assert.equal(status.credentials, "missing");
  assert.equal(status.accountOwnership, "not-verified");
  assert.equal(status.database, resolve(dirname(path), "data", "assistant.sqlite"));
});

test("CLI refuses unauthorized login and agent start without model authorization", async () => {
  const path = await file(value);
  await assert.rejects(runWechatCli(["login", "--config", path]), /requires/);
  await assert.rejects(runWechatCli(["start", "--config", path, "--allow-wechat", "--legacy-stopped"]), /allow-model/);
  await assert.rejects(runWechatCli(["start", "--config", path, "--allow-model"]), /requires --allow-wechat/);
  const unsupported = await file({ ...value, model: { provider: "unknown", modelId: "missing" } });
  await assert.rejects(runWechatCli(["start", "--config", unsupported, "--allow-wechat", "--legacy-stopped", "--allow-model"]), /Login credentials required/);
  await assert.rejects(runWechatCli(["doctor", "--config", path, "--unknown"]), /Unknown/);
});
