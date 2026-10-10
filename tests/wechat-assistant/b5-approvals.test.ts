import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { Approvals, consumeShellApproval, decideShellApproval, requestShellApproval } from "../../src/wechat-assistant/approvals.ts";
import { shellTools } from "../../src/wechat-assistant/tools/shell.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { runApprovalConsole } from "../../src/wechat-assistant/approval-console.ts";

test("shell approval cannot be granted by a model tool and is off by default", async () => {
  const dir = resolve("data/test-runs", `shell-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const options = { models: createModels(), registry: createRegistry() };
  const harness = await openWechatHarness(db, options);
  try {
    const disabled = shellTools(harness, { root: dir, maxBytes: 1024 }, false);
    const enabled = shellTools(harness, { root: dir, maxBytes: 1024 }, true);
    for (const tools of [disabled, enabled]) {
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["shell_execute_approved", "shell_request_approval"]);
      assert.ok(!tools.some((tool) => /decide|approve/.test(tool.name) && tool.name !== "shell_request_approval" && tool.name !== "shell_execute_approved"));
    }
    // Approval state is durable and cannot be consumed without an independent decision.
    const id = await requestShellApproval(harness, "node", ["--version"], dir);
    await assert.rejects(consumeShellApproval(harness, id, "node", ["--version"], dir), /approval/);
    assert.equal((await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records[0]?.state, "pending");
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  const reopened = await openWechatHarness(db, options);
  try {
    const id = (await reopened.snapshot(Approvals, BACKGROUND_CONTEXT))!.records[0]!.id;
    await decideShellApproval(reopened, id, true);
    await assert.rejects(consumeShellApproval(reopened, id, "node", ["--bad"], dir), /mismatched/);
    await assert.rejects(consumeShellApproval(reopened, id, "node", ["--version"], resolve(dir, "other")), /mismatched/);
    await consumeShellApproval(reopened, id, "node", ["--version"], dir);
    await assert.rejects(consumeShellApproval(reopened, id, "node", ["--version"], dir), /approval/);
    const expired = await requestShellApproval(reopened, "node", ["--version"], dir, 1000);
    await reopened.commit(async (tx) => { (await tx.doc(Approvals)).records.find((record) => record.id === expired)!.expiresAt = Date.now() - 1; }, BACKGROUND_CONTEXT);
    await decideShellApproval(reopened, expired, true);
    assert.equal((await reopened.snapshot(Approvals, BACKGROUND_CONTEXT))?.records.find((record) => record.id === expired)?.state, "expired");
    await assert.rejects(consumeShellApproval(reopened, expired, "node", ["--version"], dir), /approval/);
  } finally { await reopened.close(BACKGROUND_CONTEXT); }
});

test("local approval console rejects non-TTY and requires exact second confirmation", async () => {
  const dir = resolve("data/test-runs", `approval-console-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const harness = await openWechatHarness(resolve(dir, "assistant.sqlite"), { models: createModels(), registry: createRegistry() });
  const id = await requestShellApproval(harness, "node", ["--version"], dir);
  const input = new PassThrough(); const output = new PassThrough(); let shown = "";
  output.on("data", (chunk: Buffer) => { shown += chunk.toString(); });
  const controller = new AbortController();
  try {
    await runApprovalConsole(harness, controller.signal, { input, output, isTTY: false });
    assert.equal((await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records[0]?.state, "pending");
    const running = runApprovalConsole(harness, controller.signal, { input, output, isTTY: true });
    input.write(`approve ${id}\n`);
    for (let n = 0; n < 100 && !shown.includes("to confirm:"); n++) await new Promise((done) => setTimeout(done, 10));
    assert.match(shown, /to confirm:/);
    assert.match(shown, /--version/);
    input.write(`approve wrong\n`);
    for (let n = 0; n < 100 && !shown.includes("Approval not confirmed"); n++) await new Promise((done) => setTimeout(done, 10));
    assert.match(shown, /Approval not confirmed/);
    assert.equal((await harness.snapshot(Approvals, BACKGROUND_CONTEXT))?.records[0]?.state, "pending");
    controller.abort(); await running;
  } finally { controller.abort(); input.end(); await harness.close(BACKGROUND_CONTEXT); }
});
