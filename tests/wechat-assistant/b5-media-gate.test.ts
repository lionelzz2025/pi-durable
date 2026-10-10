import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { MediaOutbox } from "../../src/wechat-assistant/media-outbox.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { mediaTools } from "../../src/wechat-assistant/tools/media.ts";

test("media send tool persists queue and does not call network itself", async () => {
  const root = resolve("data/test-runs", `media-gate-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "safe.txt"), "test");
  const harness = await openWechatHarness(resolve(root, "assistant.sqlite"), { models: createModels(), registry: createRegistry() });
  try {
    const tool = mediaTools(root, { harness, recipient: "bound-user", workspace: { root, maxBytes: 1024 } })[0]!;
    const result = await tool.execute({ path: "safe.txt", kind: "file" }, { callId: "media-call-1" } as never, BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(result), /queued/);
    assert.equal((await harness.snapshot(MediaOutbox, BACKGROUND_CONTEXT))?.records[0]?.status, "pending");
    const status = await mediaTools(root, { harness, recipient: "bound-user", workspace: { root, maxBytes: 1024 } })[1]!
      .execute({ key: "media-call-1" }, {} as never, BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(status), /pending/);
    await assert.rejects(tool.execute({ path: "../escape.txt", kind: "file" }, { callId: "media-call-2" } as never, BACKGROUND_CONTEXT), /workspace-relative/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
