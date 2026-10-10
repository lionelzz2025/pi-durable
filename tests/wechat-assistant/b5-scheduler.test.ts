import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { Outbox } from "../../src/wechat-assistant/outbox.ts";
import { runReminderScheduler } from "../../src/wechat-assistant/reminder-scheduler.ts";
import { createReminder } from "../../src/wechat-assistant/reminders.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";

test("periodic scheduler creates one blocked occurrence without incoming messages and survives restart", async () => {
  const dir = resolve("data/test-runs", `scheduler-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const options = { models: createModels(), registry: createRegistry() };
  const first = await openWechatHarness(db, options);
  try {
    await createReminder(first, { id: "due", conversationId: 1, recipient: "user", dueAt: Date.now() - 1000,
      timezone: "UTC", occurrenceId: "due:once", text: "test" });
    const controller = new AbortController();
    const running = runReminderScheduler(first, controller.signal, { intervalMs: 100 });
    try {
      for (let i = 0; i < 20 && !(await first.snapshot(Outbox, context))?.records.length; i++) await new Promise((done) => setTimeout(done, 30));
      const records = (await first.snapshot(Outbox, context))?.records ?? [];
      assert.equal(records.length, 1);
      assert.equal(records[0]?.status, "blocked");
    } finally { controller.abort(); await running; }
  } finally { await first.close(context); }
  const reopened = await openWechatHarness(db, options);
  try {
    const controller = new AbortController();
    const running = runReminderScheduler(reopened, controller.signal, { intervalMs: 100 });
    await new Promise((done) => setTimeout(done, 150));
    controller.abort(); await running;
    assert.equal((await reopened.snapshot(Outbox, context))?.records.length, 1);
  } finally { await reopened.close(context); }
});
