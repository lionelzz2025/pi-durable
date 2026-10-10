import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { ChannelState } from "../../src/wechat-assistant/documents.ts";
import { Outbox, drainOutbox } from "../../src/wechat-assistant/outbox.ts";
import { createReminder, cancelReminder, dispatchDueReminders, listReminders, reconcileReminders } from "../../src/wechat-assistant/reminders.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";

test("due reminders create one occurrence after restart; absent context blocks delivery", async () => {
  const dir = resolve("data/test-runs", `reminders-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const options = { models: createModels(), registry: createRegistry() };
  const first = await openWechatHarness(db, options);
  const item = { id: "r1", occurrenceId: "r1:once", conversationId: 1, recipient: "user", dueAt: 100, timezone: "Asia/Shanghai", text: "meeting" };
  try {
    await createReminder(first, item);
    await assert.rejects(createReminder(first, item), /already exists/);
    await assert.rejects(createReminder(first, { ...item, id: "r1-duplicate" }), /occurrence already exists/);
    assert.equal(await dispatchDueReminders(first, { now: 99 }), 0);
  } finally { await first.close(context); }
  const second = await openWechatHarness(db, options);
  try {
    assert.equal(await dispatchDueReminders(second, { now: 100 }), 1);
    assert.equal(await dispatchDueReminders(second, { now: 101 }), 0);
    const outbox = (await second.snapshot(Outbox, context))!.records;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.status, "blocked");
    assert.equal(outbox[0]?.key, "reminder:r1:once");
    assert.equal((await listReminders(second))[0]?.state, "blocked");
    await second.commit(async (tx) => { (await tx.doc(Outbox)).records[0]!.status = "outcome_unknown"; }, context);
    assert.equal(await reconcileReminders(second), 0);
    assert.equal(await cancelReminder(second, "r1"), false);
  } finally { await second.close(context); }
});

test("a context token for a foreign user cannot deliver a bound reminder", async () => {
  const dir = resolve("data/test-runs", `reminders-identity-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const harness = await openWechatHarness(resolve(dir, "assistant.sqlite"), { models: createModels(), registry: createRegistry() });
  try {
    await createReminder(harness, { id: "r-foreign", occurrenceId: "r-foreign:once", conversationId: 1, recipient: "user", dueAt: 100, timezone: "UTC", text: "secret" });
    await harness.commit(async (tx) => { const state = await tx.doc(ChannelState); state.userId = "other"; state.contextToken = "foreign-token"; }, context);
    assert.equal(await dispatchDueReminders(harness, { now: 101 }), 1);
    assert.equal((await listReminders(harness))[0]?.state, "blocked");
    assert.equal((await harness.snapshot(Outbox, context))?.records[0]?.status, "blocked");
    // Even a manual retry cannot use another user's context.
    await harness.commit(async (tx) => { (await tx.doc(Outbox)).records[0]!.status = "pending"; }, context);
    let sent = 0;
    const result = await drainOutbox(harness, async () => { sent++; }, { recipient: "user" });
    assert.equal(sent, 0); assert.equal(result.blocked, 1);
  } finally { await harness.close(context); }
});

test("cancel before due is durable and does not enqueue an occurrence", async () => {
  const dir = resolve("data/test-runs", `reminders-cancel-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const harness = await openWechatHarness(resolve(dir, "assistant.sqlite"), { models: createModels(), registry: createRegistry() });
  try {
    await createReminder(harness, { id: "r2", occurrenceId: "r2:once", conversationId: 1, recipient: "user", dueAt: 100, timezone: "UTC", text: "cancelled" });
    assert.equal(await cancelReminder(harness, "r2"), true);
    await harness.commit(async (tx) => { (await tx.doc(ChannelState)).contextToken = "ctx"; }, context);
    assert.equal(await dispatchDueReminders(harness, { now: 101 }), 0);
    assert.equal((await harness.snapshot(Outbox, context))?.records.length ?? 0, 0);
  } finally { await harness.close(context); }
});
