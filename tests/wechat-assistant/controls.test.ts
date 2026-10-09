import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { createRegistry } from "@earendil-works/pi-durable";
import { ensureBoundConversation } from "../../src/wechat-assistant/conversations.ts";
import { executeControl, ControlReceipts, parseControl } from "../../src/wechat-assistant/controls.ts";
import { ChannelState } from "../../src/wechat-assistant/documents.ts";

test("control parser recognizes only exact commands", () => {
  assert.equal(parseControl(" /new "), "new");
  for (const text of ["please /new", "/new now", "toString", "/unknown"]) assert.equal(parseControl(text), undefined);
});
test("new conversation mapping and control receipts survive reopen; replay never resets again", async () => {
  const dir = resolve("data/test-runs", `controls-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const models = createModels(); models.setProvider(fauxProvider().provider);
  const options = { models, registry: createRegistry() };
  const db = resolve(dir, "assistant.sqlite");
  const harness = await openWechatHarness(db, options);
  let nextId;
  try {
    const root = await ensureBoundConversation(harness, { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } });
    const result = await executeControl(harness, "new-1", "new");
    nextId = (await harness.snapshot(ChannelState, context))!.conversationId!;
    assert.notEqual(root.id, nextId);
    const next = (await harness.conversation(nextId, context))!;
    assert.equal((await next.agent(context)).model?.provider, "faux");
    assert.equal(await executeControl(harness, "new-1", "new"), result);
    await assert.rejects(executeControl(harness, "new-1", "cancel"), /identity conflict/);
    const status = JSON.parse(await executeControl(harness, "status-1", "status"));
    assert.equal(status.conversationId, nextId);
    await harness.commit(async (tx) => {
      (await tx.doc(ControlReceipts)).records["crash-cancel"] = { command: "cancel", conversationId: nextId!, state: "running", result: "", taskId: null };
    }, context);
    assert.match(await executeControl(harness, "crash-cancel", "cancel"), /outcome unknown/);
  } finally { await harness.close(context); }
  const reopened = await openWechatHarness(db, options);
  try {
    await executeControl(reopened, "new-1", "new");
    assert.equal((await reopened.snapshot(ChannelState, context))?.conversationId, nextId);
  } finally { await reopened.close(context); }
});
