import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { REQUIRED_TOOLS } from "../../src/wechat-assistant/capabilities.ts";
import { openAssistantRuntime } from "../../src/wechat-assistant/agent-runtime.ts";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { ChannelState } from "../../src/wechat-assistant/documents.ts";

test("readiness rejects absent model and incompatible channel before generation and releases storage", async () => {
  const dir = resolve("data/test-runs", `readiness-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const db = resolve(dir, "assistant.sqlite");
  const models = createModels(); models.setProvider(fauxProvider().provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "fixtures", tools: REQUIRED_TOOLS.map((name) => defineTool({ name, description: "fixture",
    parameters: Type.Object({}), replay: "safe", execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) })) }));
  const opts = { models, registry };
  const binding = { accountId: "bot", userId: "user", model: { provider: "faux", modelId: "faux-1" } };
  await assert.rejects(openAssistantRuntime(db, opts, { ...binding, model: { provider: "absent", modelId: "absent" } }), /model unavailable/);
  const raw = await openWechatHarness(db, opts);
  try { await raw.commit(async (tx) => { (await tx.doc(ChannelState)).schemaVersion = 99; }, context); }
  finally { await raw.close(context); }
  await assert.rejects(openAssistantRuntime(db, opts, binding), /Unsupported channel schema/);
  const reopen = await openWechatHarness(db, opts);
  try { assert.equal((await reopen.snapshot(ChannelState, context))?.schemaVersion, 99); }
  finally { await reopen.close(context); }
});
