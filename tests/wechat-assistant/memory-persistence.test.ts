import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type PromptInput, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { assistantExtension } from "../../src/wechat-assistant/extension.ts";
import { memorySection } from "../../src/wechat-assistant/memory-prompt.ts";
import { memoryAdd } from "../../src/wechat-assistant/tools/memory.ts";
import type { Harness } from "@earendil-works/pi-durable";

const model = { provider: "faux", modelId: "faux-1" } as const;
const options = () => {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("summary")));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(assistantExtension({ memoryPromptBytes: 8192, workspace: { root: process.cwd(), maxBytes: 1024 * 1024 }, harness: { snapshot: async () => undefined, commit: async () => undefined } as never, boundUserId: "test-user" }));
  return { models, registry };
};
/** Tool api over the Harness itself: memory tools touch only `commit` and `snapshot`. */
const apiFor = (harness: Harness, callId: string): ToolExecutionApi =>
  ({ callId, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) }) as unknown as ToolExecutionApi;
const render = (harness: Harness) =>
  memorySection(4096).render({ read: harness } as unknown as PromptInput, context);

test("memory survives a conversation reset, compaction and process reopen", async () => {
  const dir = resolve("data/test-runs", `memory-persist-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const opts = options();
  const harness = await openWechatHarness(db, opts);
  try {
    await memoryAdd.execute({ content: "prefers green tea", source: "chat" } as never, apiFor(harness, "m1"), context);
    const first = await harness.root(context, { agent: { model } });
    // reset: a second conversation is a new transcript scope; session memory is untouched.
    await harness.root(context, { agent: { model } });
    const submission = await first.submit({ type: "input", requestId: "r1", content: "hello", whenBusy: "followUp" }, context);
    await submission.wait(context);
    await first.compact(undefined, context);
    await harness.waitForIdle(context);
    const afterCompact = await render(harness);
    assert.ok(afterCompact?.includes("prefers green tea"), "compaction must not drop session memory");
  } finally {
    await harness.close(context);
  }
  const reopened = await openWechatHarness(db, opts);
  try {
    const after = await render(reopened);
    assert.ok(after?.includes("prefers green tea"), "memory is still injected after a restart");
  } finally {
    await reopened.close(context);
  }
});
