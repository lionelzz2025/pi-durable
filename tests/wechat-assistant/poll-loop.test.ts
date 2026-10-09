import assert from "node:assert/strict";
import { test } from "node:test";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
import { pollWechat } from "../../src/wechat-assistant/channel/poll-loop.ts";
const credentials = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
test("network retry reloads durable cursor and successful admission advances it", async () => {
  const controller = new AbortController();
  let count = 0; let cursor = "old";
  const cursors: unknown[] = []; const states: string[] = [];
  const api = new WechatApi({ transport: async (_url, init) => {
    cursors.push(JSON.parse(String(init.body)).get_updates_buf);
    if (++count === 1) throw Error("secret network error");
    return Response.json({ ret: 0, msgs: [], get_updates_buf: "new" });
  } });
  await pollWechat({ api, credentials, signal: controller.signal, cursor: async () => cursor,
    admit: async (batch) => { cursor = batch.get_updates_buf; controller.abort(); },
    onState: (state) => { states.push(state); }, retryBaseMs: 1, retryMaxMs: 2 });
  assert.deepEqual(cursors, ["old", "old"]);
  assert.equal(cursor, "new");
  assert.deepEqual(states, ["polling", "backoff", "polling", "stopped"]);
});
test("session expiry and admission failure stop without cursor advance or retries", async () => {
  for (const expire of [true, false]) {
    let calls = 0; let admitted = 0;
    const states: string[] = [];
    const api = new WechatApi({ transport: async () => {
      calls++; return Response.json(expire ? { errcode: -14 } : { ret: 0, msgs: [], get_updates_buf: "next" });
    } });
    await assert.rejects(pollWechat({ api, credentials, signal: AbortSignal.timeout(5_000), cursor: async () => "old",
      admit: async () => { admitted++; throw Error("commit failed"); }, onState: (s) => { states.push(s); } }));
    assert.equal(calls, 1); assert.equal(admitted, expire ? 0 : 1);
    assert.equal(states.includes("expired"), expire);
    assert.equal(states.at(-1), "stopped");
  }
});
test("concurrent shutdown never hides an admission failure", async () => {
  const controller = new AbortController();
  const api = new WechatApi({ transport: async () => Response.json({ ret: 0, msgs: [], get_updates_buf: "next" }) });
  await assert.rejects(pollWechat({ api, credentials, signal: controller.signal, cursor: async () => "",
    admit: async () => { controller.abort(); throw Error("commit failed during shutdown"); }, onState: () => {} }), /commit failed during shutdown/);
});
test("abort during backoff is graceful and does not retry", async () => {
  const controller = new AbortController(); let calls = 0;
  const api = new WechatApi({ transport: async () => { calls++; throw Error("network"); } });
  await pollWechat({ api, credentials, signal: controller.signal, cursor: async () => "",
    admit: async () => { assert.fail(); }, onState: (s) => { if (s === "backoff") controller.abort(); } });
  assert.equal(calls, 1);
});
