import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireAccountLock } from "../../src/wechat-assistant/channel/account-lock.ts";
import { validateCredentials, isBoundSender } from "../../src/wechat-assistant/channel/identity.ts";
import type { WeixinMessage } from "../../src/wechat-assistant/channel/types.ts";
import { AssistantDatabaseBusyError } from "../../src/assistant/storage.ts";

test("credentials are strict and errors do not expose secrets", () => {
  const valid = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
  assert.deepEqual(validateCredentials(valid), valid);
  for (const value of [null, {}, { ...valid, token: "" }, { ...valid, baseUrl: "https://evil.test" }]) assert.throws(() => validateCredentials(value));
});
test("identity gate rejects empty, foreign and wrong-account sender", () => {
  const credentials = validateCredentials({ token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" });
  const msg = { from_user_id: "user", to_user_id: "bot", message_type: 1 } as WeixinMessage;
  assert.equal(isBoundSender(msg, credentials), true);
  for (const patch of [{ from_user_id: "" }, { from_user_id: "foreign" }, { to_user_id: "other" }, { message_type: 2 }]) assert.equal(isBoundSender({ ...msg, ...patch }, credentials), false);
});
test("account lock releases after actual child hard kill", { timeout: 30_000 }, async () => {
  const root = resolve("data/test-runs", `account-child-${randomUUID()}`);
  const child = spawn(process.execPath, [resolve("tests/wechat-assistant/fixtures/account-lock-child.ts"), root, "account"], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  const ready = new Promise<void>((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error("child lock readiness timeout")), 10_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("holding")) { clearTimeout(timer); done(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(Error("child exited before readiness")); });
  });
  try {
    await ready;
    await assert.rejects(acquireAccountLock("account", root), AssistantDatabaseBusyError);
  } finally { child.kill("SIGKILL"); await exit; }
  const release = await acquireAccountLock("account", root); await release();
});
test("account lock excludes same account independent of business DB and releases idempotently", async () => {
  const root = resolve("data/test-runs", `account-lock-${randomUUID()}`);
  const release = await acquireAccountLock("account", root);
  try {
    await assert.rejects(acquireAccountLock("account", root), AssistantDatabaseBusyError);
    const other = await acquireAccountLock("other-account", root);
    await other();
  } finally { await release(); await release(); }
  const reopen = await acquireAccountLock("account", root); await reopen();
});
