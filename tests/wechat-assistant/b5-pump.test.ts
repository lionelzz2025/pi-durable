import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { REQUIRED_TOOLS } from "../../src/wechat-assistant/capabilities.ts";
import { openAssistantRuntime } from "../../src/wechat-assistant/agent-runtime.ts";
import { runAssistantPump } from "../../src/wechat-assistant/assistant-pump.ts";
import { admitWechatBatch } from "../../src/wechat-assistant/inbox.ts";
import { Outbox } from "../../src/wechat-assistant/outbox.ts";
import { createReminder } from "../../src/wechat-assistant/reminders.ts";

const binding = { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } };
const options = () => {
  const models = createModels(); const provider = fauxProvider();
  provider.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("faux answer")));
  models.setProvider(provider.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "fixture", tools: REQUIRED_TOOLS.map((name) => defineTool({ name, description: "fixture", parameters: Type.Object({}), replay: "safe", execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) })) }));
  return { models, registry };
};

test("offline pump submits inbound, settles faux answer and sends via durable outbox", async () => {
  const dir = resolve("data/test-runs", `pump-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const harness = await openAssistantRuntime(resolve(dir, "assistant.sqlite"), options(), binding);
  try {
    await admitWechatBatch(harness, { credentials: { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" },
      messageBytes: 32768, pendingLimit: 10, receiptLimit: 20,
      batch: { ret: 0, get_updates_buf: "cursor", msgs: [{ message_id: "q1", from_user_id: "user", to_user_id: "bot", client_id: "", create_time_ms: 1, message_type: 1, message_state: 2, context_token: "ctx", item_list: [{ type: 1, text_item: { text: "question" } }] }] } });
    const controller = new AbortController(); const sent: string[] = [];
    const pumping = runAssistantPump(harness, { recipient: "user", signal: controller.signal, sender: async (chunk) => { sent.push(chunk.text); }, intervalMs: 100 });
    try {
      for (let i = 0; i < 80 && sent.length === 0; i++) await new Promise((done) => setTimeout(done, 50));
      assert.deepEqual(sent, ["faux answer"]);
      assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "sent");
    } finally { controller.abort(); await pumping; }
  } finally { await harness.close(context); }
});

test("pump exposes storage errors instead of silently retrying forever", async () => {
  const controller = new AbortController();
  const harness = { snapshot: async () => { throw Error("storage unavailable"); } } as never;
  await assert.rejects(runAssistantPump(harness, { recipient: "user", signal: controller.signal, sender: async () => {} }), /storage unavailable/);
});

test("offline pump dispatches due reminder to blocked outbox without incoming messages", async () => {
  const dir = resolve("data/test-runs", `pump-reminder-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const harness = await openAssistantRuntime(resolve(dir, "assistant.sqlite"), options(), binding);
  try {
    await createReminder(harness, { id: "r1", conversationId: 1, recipient: "user", dueAt: Date.now() - 1, timezone: "UTC", occurrenceId: "r1:once", text: "time" });
    const controller = new AbortController(); let sent = 0;
    const pumping = runAssistantPump(harness, { recipient: "user", signal: controller.signal, sender: async () => { sent++; }, intervalMs: 100 });
    try {
      for (let i = 0; i < 40 && !(await harness.snapshot(Outbox, context))?.records.length; i++) await new Promise((done) => setTimeout(done, 50));
      assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "blocked");
      assert.equal(sent, 0);
    } finally { controller.abort(); await pumping; }
  } finally { await harness.close(context); }
});
