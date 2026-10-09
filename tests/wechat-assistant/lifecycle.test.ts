import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { runWechatChannel } from "../../src/wechat-assistant/lifecycle.ts";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
import { acquireAccountLock } from "../../src/wechat-assistant/channel/account-lock.ts";
const credentials = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
test("channel drains admission before close and releases account lock", async () => {
  const controller = new AbortController();
  const root = resolve("data/test-runs", `lifecycle-${randomUUID()}`);
  const events: string[] = [];
  await runWechatChannel({ credentials, expectedAccountId: "bot", expectedUserId: "user", legacyStopped: true,
    lockRoot: root, signal: controller.signal, api: new WechatApi({ transport: async () => Response.json({ ret: 0, msgs: [], get_updates_buf: "next" }) }),
    cursor: async () => "", admit: async () => { events.push("admitting"); controller.abort(); await new Promise((done) => setTimeout(done, 10)); events.push("committed"); },
    onState: () => {}, closeRuntime: async () => { events.push("closed"); } });
  assert.deepEqual(events, ["admitting", "committed", "closed"]);
  const release = await acquireAccountLock("bot", root); await release();
});
test("ownership guard never polls and still closes runtime", async () => {
  let closed = 0;
  await assert.rejects(runWechatChannel({ credentials, expectedAccountId: "bot", expectedUserId: "user", legacyStopped: false,
    signal: new AbortController().signal, api: new WechatApi({ transport: async () => { assert.fail("must not poll"); } }),
    cursor: async () => "", admit: async () => { assert.fail(); }, onState: () => {}, closeRuntime: async () => { closed++; } }), /shutdown/);
  assert.equal(closed, 1);
});
test("runtime close error does not strand account ownership", async () => {
  const root = resolve("data/test-runs", `lifecycle-error-${randomUUID()}`);
  const controller = new AbortController();
  await assert.rejects(runWechatChannel({ credentials, expectedAccountId: "bot", expectedUserId: "user", legacyStopped: true,
    lockRoot: root, signal: controller.signal, api: new WechatApi({ transport: async () => Response.json({ ret: 0, msgs: [], get_updates_buf: "next" }) }),
    cursor: async () => "", admit: async () => { controller.abort(); }, onState: () => {}, closeRuntime: async () => { throw Error("close failed"); } }), /close failed/);
  const release = await acquireAccountLock("bot", root); await release();
});
