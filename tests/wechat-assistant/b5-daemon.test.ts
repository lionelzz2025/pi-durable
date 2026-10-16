import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { requestShellApproval, Approvals } from "../../src/wechat-assistant/approvals.ts";
import { shellTools } from "../../src/wechat-assistant/tools/shell.ts";
import type { Harness } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { runAssistantDaemon } from "../../src/wechat-assistant/assistant-daemon.ts";
import { DEFAULT_LIMITS, type WechatConfig } from "../../src/wechat-assistant/config.ts";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
import { WechatCdn } from "../../src/wechat-assistant/channel/cdn.ts";

const credential = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
const fixture = () => {
  const root = resolve("data/test-runs", `daemon-${randomUUID()}`);
  const config: WechatConfig = { schemaVersion: 1, dataDir: resolve(root, "data"), workspaceDir: root,
    accountId: "bot", boundUserId: "user", model: { provider: "faux", modelId: "faux-1" },
    shell: { enabled: false }, limits: { ...DEFAULT_LIMITS } };
  const models = createModels(); const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("daemon answer")));
  models.setProvider(faux.provider);
  return { root, config, harnessOptions: { models } };
};

test("unpriced non-faux model fails startup before account lock or poll", async () => {
  const { root, config } = fixture(); config.model = { provider: "unpriced", modelId: "faux-1" };
  const models = createModels(); const unpriced = fauxProvider({ provider: "unpriced" }); models.setProvider(unpriced.provider);
  let polled = false;
  await assert.rejects(runAssistantDaemon({ config, credentials: credential, harnessOptions: { models }, legacyStopped: true,
    api: new WechatApi({ transport: async () => { polled = true; throw Error("unexpected poll"); } }),
    cdn: new WechatCdn(async () => { throw Error("unexpected CDN"); }), sender: async () => {}, signal: new AbortController().signal,
    lockRoot: resolve(root, "lock"), onState: () => {} }), /price unavailable/);
  assert.equal(polled, false);
});

test("single-owner shell approval uses the same Harness while polling and consumes once", async () => {
  const { root, config, harnessOptions } = fixture(); config.shell.enabled = true;
  const controller = new AbortController(); let approvalReached = false;
  const api = new WechatApi({ transport: async () => {
    await new Promise<void>((done) => { if (controller.signal.aborted) done(); else controller.signal.addEventListener("abort", () => done(), { once: true }); });
    throw Error("stopped");
  } });
  await runAssistantDaemon({ config, credentials: credential, harnessOptions, api, cdn: new WechatCdn(async () => { throw Error("CDN not used"); }),
    sender: async () => {}, signal: controller.signal, legacyStopped: true, lockRoot: resolve(root, "lock"), onState: () => {},
    approvalConsole: async (harness: Harness) => {
      const id = await requestShellApproval(harness, "node", ["--version"], config.workspaceDir);
      assert.equal((await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records[0]?.state, "pending");
      // No second owner: the daemon's own reference is sufficient for decision.
      const { decideShellApproval } = await import("../../src/wechat-assistant/approvals.ts");
      await decideShellApproval(harness, id, true);
      const tools = shellTools(harness, { root: config.workspaceDir, maxBytes: 1024 }, true);
      const result = await tools[1]!.execute({ approvalId: id, command: "node", argsJson: '["--version"]' } as never, {} as never, {} as never);
      assert.match(JSON.stringify(result), /v24/);
      assert.equal((await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records[0]?.state, "consumed");
      approvalReached = true; controller.abort();
    },
  });
  assert.equal(approvalReached, true);
});

test("single-owner daemon admits fake WeChat, processes faux model and sends via outbox; restart reuses cursor", async () => {
  const { root, config, harnessOptions } = fixture(); const sent: string[] = []; const cursors: string[] = [];
  for (let restart = 0; restart < 2; restart++) {
    const controller = new AbortController(); let polls = 0;
    const api = new WechatApi({ transport: async (_url, init) => {
      const cursor = JSON.parse(String(init.body)).get_updates_buf as string; cursors.push(cursor);
      if (polls++ === 0 && restart === 0) return Response.json({ ret: 0, get_updates_buf: "cursor-1", msgs: [{ message_id: "q1", from_user_id: "user", to_user_id: "bot", client_id: "", create_time_ms: 1, message_type: 1, message_state: 2, context_token: "ctx", item_list: [{ type: 1, text_item: { text: "question" } }] }] });
      await new Promise<void>((done) => { if (controller.signal.aborted) done(); else controller.signal.addEventListener("abort", () => done(), { once: true }); });
      throw Error("stopped");
    } });
    const running = runAssistantDaemon({ config, credentials: credential, harnessOptions, api, cdn: new WechatCdn(async () => { throw Error("unexpected CDN"); }),
      sender: async (chunk) => { sent.push(chunk.text); controller.abort(); }, signal: controller.signal, legacyStopped: true,
      lockRoot: resolve(root, "lock"), onState: () => {} });
    if (restart === 1) setTimeout(() => controller.abort(), 250);
    await running;
  }
  assert.deepEqual(sent, ["daemon answer"]);
  assert.equal(cursors[0], "");
  assert.equal(cursors[1], "cursor-1");
});
