import assert from "node:assert/strict";
import { createCipheriv, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
import type { WechatCdn } from "../../src/wechat-assistant/channel/cdn.ts";
import { storeWechatMedia } from "../../src/wechat-assistant/media.ts";
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
test("unsupported media capability is admitted with an explicit marker, not fetched", async () => {
  const { harness } = await open();
  try {
    const conversation = await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const unsupported = { ...message("unsupported"), item_list: [
      { type: 2, image_item: { media: { encrypt_query_param: "", aes_key: "", encrypt_type: 0 } } },
      { type: 4, file_item: { file_name: "old.bin", len: "5" } },
      { type: 5 },
      { type: 3, voice_item: { text: "" } },
    ] } as WeixinMessage;
    await admitWechatBatch(harness, input([unsupported], "unsupported-cursor"));
    await submitReceivedInbox(harness);
    const record = (await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!;
    assert.equal(record.status, "submitted");
    assert.deepEqual(record.media, []);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const contents = JSON.stringify(entries.items);
    assert.match(contents, /图片暂不支持/);
    assert.match(contents, /文件暂不支持/);
    assert.match(contents, /暂不支持视频/);
    assert.match(contents, /语音无可用转写文本/);
    const { Outbox, drainOutbox } = await import("../../src/wechat-assistant/outbox.ts");
    assert.equal((await harness.snapshot(Outbox, BACKGROUND_CONTEXT))?.records.length, 1);
    await submitReceivedInbox(harness);
    assert.equal((await harness.snapshot(Outbox, BACKGROUND_CONTEXT))?.records.length, 1);
    const sent: string[] = [];
    const result = await drainOutbox(harness, async (item) => { sent.push(item.text); }, { recipient: "user" });
    assert.equal(result.sent, 1);
    assert.match(sent.join(""), /暂不支持处理此消息中的图片、文件、视频、无转写的语音/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("authorized inbound encrypted file is materialized and associated before submit, then reused", async () => {
  const { harness } = await open();
  try {
    await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const key = "00112233445566778899aabbccddeeff";
    const content = Buffer.from("attachment content");
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "hex"), null);
    const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
    const file = { ...message("attachment"), item_list: [{ type: 4, file_item: { file_name: "safe.txt", len: String(content.length), media: { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key, "utf8").toString("base64"), encrypt_type: 1 as const } } }] };
    await admitWechatBatch(harness, input([file], "file-cursor"));
    await assert.rejects(submitReceivedInbox(harness), /media transport unavailable/);
    assert.equal((await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!.status, "received");
    let downloads = 0;
    const cdn = { transfer: async () => { downloads++; return { bytes: encrypted }; } } as unknown as WechatCdn;
    const root = resolve("data/test-runs", `inbound-media-${randomUUID()}`);
    await submitReceivedInbox(harness, { root, maxBytes: 1024, cdn, signal: new AbortController().signal });
    await submitReceivedInbox(harness, { root, maxBytes: 1024, cdn, signal: new AbortController().signal });
    const record = (await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!;
    assert.equal(record.media.length, 1);
    assert.equal(await readFile(record.media[0]!.path, "utf8"), "attachment content");
    assert.equal(record.status, "submitted");
    assert.equal(downloads, 1);
    // This record is now submitted; verifyStoredWechatMedia is exercised on a
    // received record in the separate crash-window test.
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("declared file size mismatch keeps inbox received", async () => {
  const { harness } = await open();
  try {
    await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const key = "00112233445566778899aabbccddeeff";
    const file = { ...message("wrong-size"), item_list: [{ type: 4, file_item: { file_name: "bad.bin", len: "17", media: { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const } } }] };
    await admitWechatBatch(harness, { ...input([file], "wrong-size-cursor"), attachmentBytes: 32 });
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "hex"), null);
    const encrypted = Buffer.concat([cipher.update(Buffer.alloc(16, 65)), cipher.final()]);
    const cdn = { transfer: async () => ({ bytes: encrypted }) } as unknown as WechatCdn;
    const root = resolve("data/test-runs", `wrong-size-${randomUUID()}`);
    await assert.rejects(submitReceivedInbox(harness, { root, maxBytes: 32, cdn, signal: new AbortController().signal }), /declared size/);
    await assert.rejects(readdir(root), { code: "ENOENT" });
    const record = (await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!;
    assert.equal(record.status, "received"); assert.equal(record.media.length, 0);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("block-aligned plaintext download permits one PKCS#7 block within configured plaintext limit", async () => {
  const { harness } = await open();
  try {
    await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const key = "00112233445566778899aabbccddeeff";
    const file = { ...message("aligned"), item_list: [{ type: 4, file_item: { file_name: "aligned.bin", len: "16", media: { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const } } }] };
    await admitWechatBatch(harness, { ...input([file], "aligned-cursor"), attachmentBytes: 16 });
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "hex"), null);
    const encrypted = Buffer.concat([cipher.update(Buffer.alloc(16, 65)), cipher.final()]);
    assert.equal(encrypted.length, 32);
    const cdn = { transfer: async (request: { maxBytes: number }) => {
      assert.equal(request.maxBytes, 32); return { bytes: encrypted };
    } } as unknown as WechatCdn;
    await submitReceivedInbox(harness, { root: resolve("data/test-runs", `aligned-${randomUUID()}`), maxBytes: 16, cdn, signal: new AbortController().signal });
    assert.equal((await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!.media[0]!.bytes, 16);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("partial two-file download resumes from first persisted attachment", async () => {
  const { harness } = await open();
  try {
    await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const key = "00112233445566778899aabbccddeeff";
    const media = { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const };
    const file = { ...message("two-files"), item_list: [
      { type: 4, file_item: { file_name: "one.txt", len: "3", media } },
      { type: 4, file_item: { file_name: "two.txt", len: "3", media } },
    ] };
    await admitWechatBatch(harness, input([file], "two-cursor"));
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key, "hex"), null);
    const bytes = Buffer.concat([cipher.update(Buffer.from("one")), cipher.final()]);
    let calls = 0;
    const cdn = { transfer: async () => { calls++; if (calls === 2) throw Error("second download failed"); return { bytes }; } } as unknown as WechatCdn;
    const root = resolve("data/test-runs", `partial-media-${randomUUID()}`);
    const options = { root, maxBytes: 1024, cdn, signal: new AbortController().signal };
    await assert.rejects(submitReceivedInbox(harness, options), /second download failed/);
    assert.equal((await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!.media.length, 1);
    await submitReceivedInbox(harness, options);
    const record = (await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!;
    assert.equal(record.media.length, 2);
    assert.equal(record.status, "submitted");
    assert.equal(calls, 3);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
test("received media association is verified before submitting after a crash", async () => {
  const { harness } = await open();
  try {
    await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const key = "00112233445566778899aabbccddeeff";
    const file = { ...message("associated"), item_list: [{ type: 4, file_item: { file_name: "safe.txt", len: "4", media: { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const } } }] };
    await admitWechatBatch(harness, input([file], "associated-cursor"));
    const root = resolve("data/test-runs", `associated-media-${randomUUID()}`);
    const media = await storeWechatMedia({ bytes: Buffer.from("safe"), root, name: "safe.txt", kind: "file", maxBytes: 1024 });
    await harness.commit(async (tx) => {
      (await tx.doc(ChannelState)).inbox[0]!.media = [media];
    }, BACKGROUND_CONTEXT);
    await writeFile(media.path, "evil");
    const cdn = { transfer: async () => { throw Error("should not download again"); } } as unknown as WechatCdn;
    await assert.rejects(submitReceivedInbox(harness, { root, maxBytes: 1024, cdn, signal: new AbortController().signal }), /content changed/);
    assert.equal((await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox[0]!.status, "received");
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
test("attachment capacity is independent of text payload byte budget", async () => {
  const { harness } = await open();
  try {
    const key = "00112233445566778899aabbccddeeff";
    const media = { encrypt_query_param: "safequery012345", aes_key: Buffer.from(key).toString("base64"), encrypt_type: 1 as const };
    const file = { ...message("large-file"), item_list: [{ type: 4, file_item: { file_name: "large.bin", len: "4096", media } }] };
    await admitWechatBatch(harness, { ...input([file], "cursor"), messageBytes: 512, attachmentBytes: 8192 });
    assert.equal((await harness.snapshot(ChannelState, BACKGROUND_CONTEXT))!.inbox.length, 1);
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
