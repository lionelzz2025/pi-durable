import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { ChannelState } from "../../src/wechat-assistant/documents.ts";
import { MediaOutbox, drainMediaOutbox, enqueueMedia, recoverMediaOutbox } from "../../src/wechat-assistant/media-outbox.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { WechatApi } from "../../src/wechat-assistant/channel/api.ts";
import { WechatCdn } from "../../src/wechat-assistant/channel/cdn.ts";

const open = async () => { const root = resolve("data/test-runs", `media-outbox-${randomUUID()}`);
  await mkdir(root, { recursive: true }); const db = resolve(root, "assistant.sqlite");
  const options = { models: createModels(), registry: createRegistry() };
  return { root, db, options, harness: await openWechatHarness(db, options) }; };

test("media operation freezes hash; changed file blocks before network", async () => {
  const { root, harness } = await open(); const policy = { root, maxBytes: 1024 };
  try {
    await writeFile(resolve(root, "a.txt"), "first");
    for (const relative of [".env", ".git/config", "secrets/private.pem", ".pi/auth.json"]) {
      await assert.rejects(enqueueMedia(harness, { key: relative, relative, kind: "file", policy, recipient: "user" }), /Sensitive/);
    }
    await enqueueMedia(harness, { key: "call-1", relative: "a.txt", kind: "file", policy, recipient: "user" });
    await enqueueMedia(harness, { key: "call-1", relative: "a.txt", kind: "file", policy, recipient: "user" });
    assert.equal((await harness.snapshot(MediaOutbox, context))?.records.length, 1);
    await writeFile(resolve(root, "a.txt"), "other");
    await assert.rejects(enqueueMedia(harness, { key: "call-1", relative: "a.txt", kind: "file", policy, recipient: "user" }), /conflict/);
    await harness.commit(async (tx) => { const state = await tx.doc(ChannelState); state.userId = "user"; state.contextToken = "ctx"; }, context);
    let calls = 0;
    const api = { getUploadUrl: async () => { calls++; throw Error("unexpected"); } } as unknown as WechatApi;
    await drainMediaOutbox(harness, { policy, api, cdn: new WechatCdn(), token: "secret", signal: new AbortController().signal });
    assert.equal(calls, 0);
    assert.equal((await harness.snapshot(MediaOutbox, context))?.records[0]?.status, "blocked");
  } finally { await harness.close(context); }
});

test("media send success uses protocol-compatible encrypted upload and persists receipt", async () => {
  const { root, harness } = await open(); const policy = { root, maxBytes: 1024 };
  try {
    await writeFile(resolve(root, "a.txt"), "hello");
    await enqueueMedia(harness, { key: "call-success", relative: "a.txt", kind: "file", policy, recipient: "user" });
    await harness.commit(async (tx) => { const state = await tx.doc(ChannelState); state.userId = "user"; state.contextToken = "ctx"; }, context);
    let uploadParams: Record<string, unknown> | undefined;
    let sent = 0;
    const api = { getUploadUrl: async (_token: string, params: Record<string, unknown>) => { uploadParams = params; return { upload_param: "fixed-param" }; },
      sendMessage: async (_token: string, recipient: string, ctx: string, clientId: string, items: unknown[]) => {
        sent++; assert.equal(recipient, "user"); assert.equal(ctx, "ctx"); assert.equal(clientId.length, 32);
        assert.equal((items[0] as { type: number }).type, 4);
        assert.equal((await harness.snapshot(MediaOutbox, context))!.records[0]!.status, "sending"); return {};
      } } as unknown as WechatApi;
    const cdn = { transfer: async (request: { query: string; upload?: { encrypted: Uint8Array } }) => {
      assert.equal(request.query, "fixed-param"); assert.equal(request.upload?.encrypted.byteLength, 16);
      return { downloadParam: "encrypted-param" };
    } } as unknown as WechatCdn;
    await drainMediaOutbox(harness, { policy, api, cdn, token: "secret", signal: new AbortController().signal });
    assert.equal(uploadParams?.rawsize, 5); assert.equal(uploadParams?.filesize, 16);
    assert.equal(sent, 1); assert.equal((await harness.snapshot(MediaOutbox, context))!.records[0]!.status, "sent");
    await drainMediaOutbox(harness, { policy, api, cdn, token: "secret", signal: new AbortController().signal });
    assert.equal(sent, 1);
  } finally { await harness.close(context); }
});

test("media send is marked sending before network; crash recovery is unknown and never auto-retries", async () => {
  const { root, db, options, harness } = await open(); const policy = { root, maxBytes: 1024 };
  try {
    await writeFile(resolve(root, "a.txt"), "file");
    await enqueueMedia(harness, { key: "call-2", relative: "a.txt", kind: "file", policy, recipient: "user" });
    await harness.commit(async (tx) => { const state = await tx.doc(ChannelState); state.userId = "user"; state.contextToken = "ctx"; }, context);
    let observed = "";
    const api = { getUploadUrl: async () => { observed = (await harness.snapshot(MediaOutbox, context))!.records[0]!.status; throw Error("ambiguous"); } } as unknown as WechatApi;
    await drainMediaOutbox(harness, { policy, api, cdn: new WechatCdn(), token: "secret", signal: new AbortController().signal });
    assert.equal(observed, "sending");
    assert.equal((await harness.snapshot(MediaOutbox, context))?.records[0]?.status, "outcome_unknown");
    assert.equal((await harness.snapshot(MediaOutbox, context))?.records[0]?.attempts, 1);
    await harness.commit(async (tx) => { (await tx.doc(MediaOutbox)).records[0]!.status = "sending"; }, context);
  } finally { await harness.close(context); }
  const reopened = await openWechatHarness(db, options);
  try {
    await recoverMediaOutbox(reopened);
    assert.equal((await reopened.snapshot(MediaOutbox, context))?.records[0]?.status, "outcome_unknown");
  } finally { await reopened.close(context); }
});
