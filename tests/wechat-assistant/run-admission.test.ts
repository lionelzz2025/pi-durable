import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, type Harness } from "@earendil-works/pi-durable";
import type { Model } from "@earendil-works/pi-ai";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { DailyModelCost, maximumRequestCost, modelAdmissionHook } from "../../src/wechat-assistant/run-admission.ts";
import { DEFAULT_LIMITS } from "../../src/wechat-assistant/config.ts";
import { boundedModels } from "../../src/wechat-assistant/model-limits.ts";
import { RequestMarkerGate } from "../../src/wechat-assistant/request-gate.ts";

test("conservative daily price reservation rejects a request before contacting the provider", async () => {
  const models = createModels(); const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 10,
    cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } }] });
  faux.setResponses([fauxAssistantMessage("should not be called")]); models.setProvider(faux.provider);
  const quoted = maximumRequestCost(faux.getModel(), 10);
  assert.equal(quoted, (1_000 * 20 + 10 * 10) / 1_000_000);
  assert.throws(() => maximumRequestCost({ ...faux.getModel(), provider: "unpriced", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<string>, 10), /price unavailable/);
  let owner: Harness; const registry = createRegistry(); const gate = new RequestMarkerGate();
  const limits = { ...DEFAULT_LIMITS, dailyCostUsd: quoted / 2, runModelRequests: 2, modelRetries: 0 };
  registry.install(defineExtension({ name: "budget-fixture", hooks: [modelAdmissionHook({ commit: (...args: Parameters<Harness["commit"]>) => owner.commit(...args) } as Harness,
    limits, gate)] }));
  const path = resolve("data/test-runs", `budget-${randomUUID()}`, "assistant.sqlite");
  owner = await openWechatHarness(path, { models: boundedModels(models, limits, gate, () => owner), registry });
  try {
    const conversation = await owner.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const outcome = await (await conversation.submit({ type: "input", requestId: "one", content: "hello", whenBusy: "followUp" }, context)).wait(context);
    assert.equal(faux.state.callCount, 0, JSON.stringify({ outcome, ledger: await owner.snapshot(DailyModelCost, context) }));
    assert.equal((await owner.snapshot(DailyModelCost, context))?.days[new Date().toISOString().slice(0, 10)] ?? 0, 0);
  } finally { await owner.close(context); }
});

test("successful charged request keeps its conservative daily reservation across restart", async () => {
  const models = createModels(); const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 10,
    cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } }] });
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must be blocked")]); models.setProvider(faux.provider);
  let owner: Harness; const gate = new RequestMarkerGate(); const registry = createRegistry();
  const quote = maximumRequestCost(faux.getModel(), 10);
  const limits = { ...DEFAULT_LIMITS, modelOutputTokens: 10, modelRetries: 0, dailyCostUsd: quote * 1.5 };
  registry.install(defineExtension({ name: "cost-fixture", hooks: [modelAdmissionHook({ commit: (...args: Parameters<Harness["commit"]>) => owner.commit(...args) } as Harness, limits, gate)] }));
  const path = resolve("data/test-runs", `cost-restart-${randomUUID()}`, "assistant.sqlite");
  owner = await openWechatHarness(path, { models: boundedModels(models, limits, gate, () => owner), registry });
  try {
    const conversation = await owner.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    await (await conversation.submit({ type: "input", requestId: "one", content: "first", whenBusy: "followUp" }, context)).wait(context);
    assert.equal(faux.state.callCount, 1);
    assert.ok(((await owner.snapshot(DailyModelCost, context))?.days[new Date().toISOString().slice(0, 10)] ?? 0) >= quote);
  } finally { await owner.close(context); }
  owner = await openWechatHarness(path, { models: boundedModels(models, limits, gate, () => owner), registry });
  try {
    const conversation = await owner.root(context);
    await (await conversation.submit({ type: "input", requestId: "two", content: "second", whenBusy: "followUp" }, context)).wait(context);
    assert.equal(faux.state.callCount, 1, "daily quota survives restart and denies the second paid call");
  } finally { await owner.close(context); }
});

test("a persisted per-task request admission stops a tool round before its second provider call", async () => {
  const models = createModels(); const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("fixture_tool", {})), fauxAssistantMessage("should not be called")]);
  models.setProvider(faux.provider);
  let owner: Harness; const gate = new RequestMarkerGate();
  const limits = { ...DEFAULT_LIMITS, runTimeoutMs: 30_000, runModelRequests: 1, modelRetries: 0 };
  const registry = createRegistry();
  registry.install(defineExtension({ name: "quota-fixture", hooks: [modelAdmissionHook({ commit: (...args: Parameters<Harness["commit"]>) => owner.commit(...args) } as Harness,
    limits, gate)],
    tools: [defineTool({ name: "fixture_tool", description: "fixture", parameters: Type.Object({}), replay: "safe",
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }) })] }));
  const path = resolve("data/test-runs", `quota-${randomUUID()}`, "assistant.sqlite");
  owner = await openWechatHarness(path, { models: boundedModels(models, limits, gate, () => owner), registry });
  try {
    const conversation = await owner.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const submission = await conversation.submit({ type: "input", requestId: "one", content: "run tool", whenBusy: "followUp" }, context);
    await submission.wait(context);
    assert.equal(faux.state.callCount, 1, "the second model request was rejected");
  } finally { await owner.close(context); }
  owner = await openWechatHarness(path, { models: boundedModels(models, limits, gate, () => owner), registry });
  try {
    owner.resume(); await owner.waitForIdle(context);
    assert.equal(faux.state.callCount, 1, "restart cannot admit an uncounted second call");
  } finally { await owner.close(context); }
});
