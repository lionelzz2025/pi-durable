import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_LIMITS, type WechatConfig } from "../../src/wechat-assistant/config.ts";
import { runPersistentReceiver } from "../../src/wechat-assistant/receiver.ts";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
const credentials = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
test("receiver restart loads persisted cursor, with no model configured", async () => {
  const root = resolve("data/test-runs", `receiver-${randomUUID()}`);
  const config: WechatConfig = { schemaVersion: 1, dataDir: resolve(root, "data"), workspaceDir: root,
    accountId: "bot", boundUserId: "user", model: { provider: "missing", modelId: "missing" }, shell: { enabled: false }, limits: { ...DEFAULT_LIMITS } };
  const cursors: string[] = [];
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController(); let calls = 0;
    const api = new WechatApi({ transport: async (_url, init) => {
      cursors.push(JSON.parse(String(init.body)).get_updates_buf);
      if (++calls === 2) { controller.abort(); throw Error("stop"); }
      return Response.json({ ret: 0, msgs: [], get_updates_buf: `cursor-${i}` });
    } });
    await runPersistentReceiver({ config, credentials, signal: controller.signal, legacyStopped: true, api,
      lockRoot: resolve(root, "locks"), onState: () => {} });
  }
  assert.deepEqual(cursors, ["", "cursor-0", "cursor-0", "cursor-1"]);
});
