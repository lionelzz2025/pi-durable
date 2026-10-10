import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { openAssistantRuntime } from "../../src/wechat-assistant/agent-runtime.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { assistantExtension } from "../../src/wechat-assistant/extension.ts";
import { admitWechatBatch } from "../../src/wechat-assistant/inbox.ts";
import { submitReceivedInbox } from "../../src/wechat-assistant/conversations.ts";
import { reconcileInbox } from "../../src/wechat-assistant/settlement.ts";
import { drainOutbox, enqueueAnswers, Outbox, recoverOutbox, retryOutbox, SendOutcomeUnknown, splitMessage, type OutboundChunk } from "../../src/wechat-assistant/outbox.ts";

const binding = { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } } as const;
const credentials = { token: "secret", baseUrl: "https://ilinkai.weixin.qq.com", accountId: "bot", userId: "user" };
const incoming = (text: string) => ({
  credentials, messageBytes: 32768, pendingLimit: 100, receiptLimit: 100,
  batch: { ret: 0, get_updates_buf: "cursor", msgs: [{ message_id: randomUUID(), client_id: "", from_user_id: "user", to_user_id: "bot",
    create_time_ms: 1, message_type: 1, message_state: 2, context_token: "ctx", item_list: [{ type: 1, text_item: { text } }] }] },
});

const open = async (answer: string) => {
  const dir = resolve("data/test-runs", `outbox-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage(answer)));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(assistantExtension({ memoryPromptBytes: 8192, workspace: { root: dir, maxBytes: 1024 * 1024 }, harness: { snapshot: async () => undefined, commit: async () => undefined } as never, boundUserId: binding.userId }));
  const options = { models, registry };
  const harness = await openAssistantRuntime(db, options, binding);
  return { harness, db, options };
};

/** Drive one inbound message all the way to a settled answer, then enqueue it. */
const answerOne = async (harness: Harness, question: string): Promise<void> => {
  await admitWechatBatch(harness, incoming(question));
  await submitReceivedInbox(harness);
  await harness.waitForIdle(context);
  await reconcileInbox(harness);
  await enqueueAnswers(harness, { recipient: binding.userId });
};

test("splitMessage keeps UTF-8 chunks whole and never over budget", () => {
  assert.deepEqual(splitMessage("", 100), []);
  const text = "记忆🧠".repeat(50);
  const chunks = splitMessage(text, 10);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 10);
    assert.ok(!chunk.includes("\uFFFD"), "no split surrogate pair");
  }
  assert.equal(chunks.join(""), text);
});

test("settled answer becomes exactly one outbox record and sends once, then survives reopen", async () => {
  const { harness, db, options } = await open("hello answer");
  const sent: OutboundChunk[] = [];
  try {
    await answerOne(harness, "question");
    assert.equal(await enqueueAnswers(harness, { recipient: binding.userId }), 0, "rescan creates nothing new");
    const result = await drainOutbox(harness, async (chunk) => { sent.push(chunk); }, { recipient: binding.userId });
    assert.deepEqual(result, { sent: 1, retried: 0, blocked: 0, unknown: 0 });
    assert.equal(sent[0]?.text, "hello answer");
    assert.equal(sent[0]?.userId, binding.userId);
    assert.equal(sent[0]?.contextToken, "ctx");
    assert.equal(sent[0]?.clientId.length, 32);
    assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "sent");
  } finally {
    await harness.close(context);
  }
  const reopened = await openAssistantRuntime(db, options, binding);
  try {
    assert.equal(await enqueueAnswers(reopened, { recipient: binding.userId }), 0, "a sent answer is not re-enqueued");
    const again = await drainOutbox(reopened, async (chunk) => { sent.push(chunk); }, { recipient: binding.userId });
    assert.equal(again.sent, 0);
    assert.equal(sent.length, 1);
  } finally {
    await reopened.close(context);
  }
});

test("a long answer is chunked, sent in order, and marked sent only after the last chunk", async () => {
  const { harness } = await open(`${"最长分片内容".repeat(400)}`);
  const sent: string[] = [];
  try {
    await answerOne(harness, "question");
    const result = await drainOutbox(harness, async (chunk) => { sent.push(chunk.text); }, { recipient: binding.userId, chunkBytes: 64 });
    assert.equal(result.sent, 1);
    assert.ok(sent.length > 1);
    assert.equal(sent.join(""), `${"最长分片内容".repeat(400)}`);
    assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "sent");
  } finally {
    await harness.close(context);
  }
});

test("definite failures back off and block at the attempt cap; ambiguous outcomes never auto-retry", async () => {
  const { harness } = await open("answer");
  try {
    await answerOne(harness, "question");
    const failing = async (): Promise<void> => { throw new Error("protocol api failure"); };
    let result = await drainOutbox(harness, failing, { recipient: binding.userId, sendAttempts: 2, now: () => 1_000 });
    assert.deepEqual(result, { sent: 0, retried: 1, blocked: 0, unknown: 0 });
    result = await drainOutbox(harness, failing, { recipient: binding.userId, sendAttempts: 2, now: () => 1_001 });
    assert.equal(result.retried, 0, "not due before the backoff elapses");
    result = await drainOutbox(harness, failing, { recipient: binding.userId, sendAttempts: 2, now: () => 1_000_000 });
    assert.equal(result.blocked, 1);
    assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "blocked");

    // An ambiguous outcome is terminal for automatic retries.
    await retryOutbox(harness);
    const ambiguous = async (): Promise<void> => { throw new SendOutcomeUnknown(); };
    result = await drainOutbox(harness, ambiguous, { recipient: binding.userId });
    assert.equal(result.unknown, 1);
    result = await drainOutbox(harness, ambiguous, { recipient: binding.userId });
    assert.deepEqual(result, { sent: 0, retried: 0, blocked: 0, unknown: 0 });
    // Only an explicit manual retry re-arms it.
    assert.equal(await retryOutbox(harness), 1);
    result = await drainOutbox(harness, async () => undefined, { recipient: binding.userId });
    assert.equal(result.sent, 1);
  } finally {
    await harness.close(context);
  }
});

test("an answer committed before a crash is enqueued exactly once on restart", async () => {
  const { harness, db, options } = await open("durable answer");
  try {
    await admitWechatBatch(harness, incoming("question"));
    await submitReceivedInbox(harness);
    await harness.waitForIdle(context);
    await reconcileInbox(harness);
    // Crash window: the answer is committed but no outbox record exists yet.
  } finally {
    await harness.close(context);
  }
  const reopened = await openWechatHarness(db, options);
  try {
    assert.equal(await enqueueAnswers(reopened, { recipient: binding.userId }), 1, "restart rebuilds the missing record once");
    assert.equal(await enqueueAnswers(reopened, { recipient: binding.userId }), 0, "a repeated scan does not duplicate chunks");
    const sent: OutboundChunk[] = [];
    const result = await drainOutbox(reopened, async (chunk) => { sent.push(chunk); }, { recipient: binding.userId });
    assert.equal(result.sent, 1);
    assert.equal(sent[0]?.text, "durable answer");
  } finally {
    await reopened.close(context);
  }
});

test("a record left sending by a crash is recovered as outcome_unknown, never resent", async () => {
  const { harness } = await open("answer");
  const sent: OutboundChunk[] = [];
  try {
    await answerOne(harness, "question");
    await harness.commit(async (tx) => {
      const record = (await tx.doc(Outbox)).records[0];
      if (!record) throw new Error("missing record");
      record.status = "sending";
      record.attempts = 1;
    }, context);
    assert.equal(await recoverOutbox(harness), 1);
    assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "outcome_unknown");
    const result = await drainOutbox(harness, async (chunk) => { sent.push(chunk); }, { recipient: binding.userId });
    assert.equal(result.sent, 0);
    assert.equal(sent.length, 0, "recovery must not resend an in-flight message");
  } finally {
    await harness.close(context);
  }
});

test("bound context is read atomically for each chunk, including token rotation", async () => {
  const { harness } = await open("answer");
  const sent: OutboundChunk[] = [];
  try {
    await answerOne(harness, "question");
    const { ChannelState } = await import("../../src/wechat-assistant/documents.ts");
    await harness.commit(async (tx) => {
      const channel = await tx.doc(ChannelState);
      channel.contextToken = "first";
      const record = (await tx.doc(Outbox)).records[0]!;
      record.chunks = ["part-1", "part-2"];
      record.clientIds = ["id-1", "id-2"];
    }, context);
    const result = await drainOutbox(harness, async (chunk) => {
      sent.push(chunk);
      if (sent.length === 1) await harness.commit(async (tx) => { (await tx.doc(ChannelState)).contextToken = "second"; }, context);
    }, { recipient: binding.userId });
    assert.equal(result.sent, 1);
    assert.deepEqual(sent.map((item) => item.contextToken), ["first", "second"]);
  } finally { await harness.close(context); }
});

test("missing context token blocks instead of sending, and a refreshed token recovers it", async () => {
  const { harness } = await open("answer");
  const sent: OutboundChunk[] = [];
  try {
    await answerOne(harness, "question");
    const { ChannelState } = await import("../../src/wechat-assistant/documents.ts");
    await harness.commit(async (tx) => { (await tx.doc(ChannelState)).contextToken = ""; }, context);
    let result = await drainOutbox(harness, async (chunk) => { sent.push(chunk); }, { recipient: binding.userId });
    assert.equal(result.blocked, 1);
    await harness.commit(async (tx) => { (await tx.doc(ChannelState)).contextToken = "fresh"; }, context);
    await retryOutbox(harness);
    result = await drainOutbox(harness, async (chunk) => { sent.push(chunk); }, { recipient: binding.userId });
    assert.equal(result.sent, 1);
    assert.equal(sent[0]?.contextToken, "fresh");
  } finally {
    await harness.close(context);
  }
});
