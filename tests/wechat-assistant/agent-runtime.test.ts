import assert from "node:assert/strict";
import { createCipheriv, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { REQUIRED_TOOLS } from "../../src/wechat-assistant/capabilities.ts";
import { openAssistantRuntime } from "../../src/wechat-assistant/agent-runtime.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { admitWechatBatch } from "../../src/wechat-assistant/inbox.ts";
import { ChannelState } from "../../src/wechat-assistant/documents.ts";
import { reconcileInbox } from "../../src/wechat-assistant/settlement.ts";
import { submitReceivedInbox } from "../../src/wechat-assistant/conversations.ts";
import type { WechatCdn } from "../../src/wechat-assistant/channel/cdn.ts";

// Fixture capabilities are not production implementations and never reach CLI.
const options = () => {
  const models = createModels(); const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("fixture answer")));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-fixture", tools: REQUIRED_TOOLS.map((name) => defineTool({ name,
    description: "test", parameters: Type.Object({}), replay: "safe", execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) })) }));
  return { models, registry };
};
const binding = { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } };
const credentials = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
const batch = (texts: string[]) => ({ credentials, messageBytes: 32768, pendingLimit: 10, receiptLimit: 100,
  batch: { ret: 0, get_updates_buf: "cursor", msgs: texts.map((text, i) => ({ message_id: String(i), from_user_id: "user", to_user_id: "bot",
    client_id: "", create_time_ms: 1, message_type: 1, message_state: 2, context_token: "ctx", item_list: [{ type: 1, text_item: { text } }] })) } });

test("runtime recovers persisted input FIFO and reconciles settled receipts without new messages", async () => {
  const dir = resolve("data/test-runs", `agent-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite"); const opts = options();
  const raw = await openWechatHarness(db, opts);
  try { await admitWechatBatch(raw, batch(["first", "second"])); } finally { await raw.close(context); }
  const harness = await openAssistantRuntime(db, opts, binding);
  let id;
  try {
    id = (await harness.snapshot(ChannelState, context))!.conversationId!;
    await harness.waitForIdle(context); await reconcileInbox(harness);
    assert.ok((await harness.snapshot(ChannelState, context))!.inbox.every((r) => r.status === "settled"));
    const conversation = (await harness.conversation(id, context))!;
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const users = entries.items.filter((entry) => entry.kind === "pi.user");
    assert.equal(users.length, 2);
    assert.ok(JSON.stringify(users[0]).includes("first")); assert.ok(JSON.stringify(users[1]).includes("second"));
  } finally { await harness.close(context); }
  const reopened = await openAssistantRuntime(db, opts, binding);
  try {
    assert.equal((await reopened.snapshot(ChannelState, context))?.conversationId, id);
    const conversation = (await reopened.conversation(id!, context))!;
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.equal(entries.items.filter((entry) => entry.kind === "pi.user").length, 2);
  } finally { await reopened.close(context); }
});

test("startup preserves received media without transport and recovers it with injected CDN", async () => {
  const dir = resolve("data/test-runs", `agent-media-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite"); const opts = options();
  const key = "00112233445566778899aabbccddeeff";
  const file = { ...batch([]).batch.msgs[0], message_id: "media-1", from_user_id: "user", to_user_id: "bot", context_token: "ctx", message_type: 1, message_state: 2,
    item_list: [{ type: 4, file_item: { file_name: "startup.txt", len: "12", media: { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const } } }] };
  const raw = await openWechatHarness(db, opts);
  try { await admitWechatBatch(raw, { ...batch([]), batch: { ret: 0, get_updates_buf: "cursor", msgs: [file] }, attachmentBytes: 1024 }); }
  finally { await raw.close(context); }
  await assert.rejects(openAssistantRuntime(db, opts, binding), /media transport unavailable/);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "hex"), null);
  const bytes = Buffer.concat([cipher.update(Buffer.from("startup file")), cipher.final()]);
  let calls = 0;
  const cdn = { transfer: async () => { calls++; return { bytes }; } } as unknown as WechatCdn;
  const harness = await openAssistantRuntime(db, opts, binding, { root: resolve(dir, "media"), maxBytes: 1024, cdn, signal: new AbortController().signal });
  try {
    await harness.waitForIdle(context); await reconcileInbox(harness);
    const state = (await harness.snapshot(ChannelState, context))!;
    assert.equal(state.inbox[0]?.status, "settled");
    assert.equal(state.inbox[0]?.media.length, 1);
    assert.equal(calls, 1);
  } finally { await harness.close(context); }
});
test("inbox controls bypass generation and subsequent input uses the switched conversation", async () => {
  const dir = resolve("data/test-runs", `agent-controls-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const harness = await openAssistantRuntime(resolve(dir, "assistant.sqlite"), options(), binding);
  try {
    const original = (await harness.snapshot(ChannelState, context))!.conversationId;
    await admitWechatBatch(harness, batch(["/new", "after new", "/status"]));
    await submitReceivedInbox(harness); await harness.waitForIdle(context); await reconcileInbox(harness);
    const state = (await harness.snapshot(ChannelState, context))!;
    assert.notEqual(state.conversationId, original);
    assert.equal(state.inbox[1]?.conversationId, state.conversationId);
    assert.ok(state.inbox.every((r) => r.status === "settled"));
    const conversation = (await harness.conversation(state.conversationId!, context))!;
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    assert.equal(entries.items.filter((entry) => entry.kind === "pi.user").length, 1);
  } finally { await harness.close(context); }
});
