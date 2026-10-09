import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { ensureBoundConversation, submitReceivedInbox } from "../../src/wechat-assistant/conversations.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { ChannelState } from "../../src/wechat-assistant/documents.ts";
import { admitWechatBatch, InboxCapacityError } from "../../src/wechat-assistant/inbox.ts";
import type { WeixinMessage } from "../../src/wechat-assistant/channel/types.ts";
const credentials = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
const message = (id: string, text = "hello"): WeixinMessage => ({ message_id: id, from_user_id: "user", to_user_id: "bot", client_id: "", create_time_ms: 1,
  message_type: 1, message_state: 2, context_token: "context", item_list: [{ type: 1, text_item: { text } }] });
const open = async () => {
  const dir = resolve("data/test-runs", `inbox-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const models = createModels(); models.setProvider(fauxProvider().provider);
  const db = resolve(dir, "assistant.sqlite"); const options = { models, registry: createRegistry() };
  return { harness: await openWechatHarness(db, options), db, options };
};
const input = (msgs: WeixinMessage[], cursor: string) => ({ credentials, batch: { ret: 0, msgs, get_updates_buf: cursor }, messageBytes: 32768, pendingLimit: 2, receiptLimit: 3 });
test("batch inbox, cursor and context survive reopen and dedup does not merge equal text", async () => {
  const { harness, db, options } = await open();
  try {
    await admitWechatBatch(harness, input([message("1"), message("2")], "a"));
    await admitWechatBatch(harness, input([{ ...message("1"), context_token: "rotated" }], "b"));
    const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    assert.equal(state?.inbox.length, 2); assert.equal(state?.cursor, "b"); assert.equal(state?.contextToken, "rotated");
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  const reopened = await openWechatHarness(db, options);
  try { assert.equal((await reopened.snapshot(ChannelState, BACKGROUND_CONTEXT))?.inbox.length, 2); }
  finally { await reopened.close(BACKGROUND_CONTEXT); }
});
test("root binding and submit association recover without duplicate input", async () => {
  const { harness } = await open();
  try {
    const binding = { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } };
    const root = await ensureBoundConversation(harness, binding);
    assert.equal((await ensureBoundConversation(harness, binding)).id, root.id);
    await admitWechatBatch(harness, input([message("1")], "a"));
    const record = (await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!;
    // Simulates a crash after durable submit but before inbox association.
    const submitted = await root.submit({ type: "input", requestId: record.requestId, content: "hello", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    await submitReceivedInbox(harness);
    await submitReceivedInbox(harness);
    const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    assert.equal(state?.inbox[0]?.submissionId, submitted.id);
    await submitted.wait(BACKGROUND_CONTEXT);
    const entries = await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => entry.kind === "pi.user").length, 1);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("capacity rollback preserves prior inbox/cursor/context including earlier batch items", async () => {
  const { harness } = await open();
  try {
    await admitWechatBatch(harness, input([message("1")], "old"));
    const before = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    await assert.rejects(admitWechatBatch(harness, input([message("2"), message("3")], "new")), InboxCapacityError);
    assert.deepEqual(await harness.snapshot(ChannelState, BACKGROUND_CONTEXT), before);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("unauthorized, missing ID and conflicting content are quarantined without secret payload", async () => {
  const { harness } = await open();
  try {
    await admitWechatBatch(harness, input([message("1")], "old"));
    await admitWechatBatch(harness, input([message("1", "conflicting-secret"), message(""), { ...message("2"), from_user_id: "foreign" }], "new"));
    const state = await harness.snapshot(ChannelState, BACKGROUND_CONTEXT);
    assert.equal(state?.inbox.length, 1); assert.equal(state?.rejected.length, 3); assert.equal(state?.cursor, "new");
    assert.doesNotMatch(JSON.stringify(state?.rejected), /secret|foreign/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
