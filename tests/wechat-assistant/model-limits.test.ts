import assert from "node:assert/strict";
import { test } from "node:test";
import type { Models } from "@earendil-works/pi-ai/models";
import { DEFAULT_LIMITS } from "../../src/wechat-assistant/config.ts";
import { boundedModels } from "../../src/wechat-assistant/model-limits.ts";
import { RequestMarkerGate } from "../../src/wechat-assistant/request-gate.ts";
import { DailyModelCost, maximumRequestCost } from "../../src/wechat-assistant/run-admission.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { openWechatHarness } from "../../src/wechat-assistant/runtime.ts";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

test("an unmarked or reused request cannot reach the provider boundary", () => {
  const calls: unknown[] = [];
  const models = { streamSimple(_model: unknown, context: unknown) { calls.push(context); return "ok"; } } as unknown as Models;
  const gate = new RequestMarkerGate(); const guarded = boundedModels(models, DEFAULT_LIMITS, gate);
  const model = { provider: "faux", id: "faux-1" } as never;
  assert.throws(() => guarded.streamSimple(model, { messages: [] }), /no admitted durable budget token/);
  const marked = gate.mark([], model);
  assert.throws(() => guarded.streamSimple({ provider: "other", id: "faux-1" } as never, { messages: [...marked.messages] }), /no admitted durable budget token/);
  assert.equal(guarded.streamSimple(model, { messages: [...marked.messages] }), "ok");
  assert.deepEqual(calls, [{ messages: [] }], "internal marker never reaches provider");
  assert.throws(() => guarded.streamSimple({} as never, { messages: [...marked.messages] }), /no admitted durable budget token/);
});

test("compaction model call reserves daily cost before provider and settles after response", async () => {
  const models = createModels(); const provider = fauxProvider({ models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 10,
    cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } }] });
  provider.setResponses([fauxAssistantMessage("summary")]); models.setProvider(provider.provider);
  const quote = maximumRequestCost(provider.getModel(), 10);
  const owner = await openWechatHarness(resolve("data/test-runs", `model-compaction-${randomUUID()}`, "assistant.sqlite"), { models, registry: createRegistry() });
  try {
    const bounded = boundedModels(models, { ...DEFAULT_LIMITS, modelOutputTokens: 10, modelRetries: 0, dailyCostUsd: quote * 2 }, undefined, () => owner);
    await bounded.completeSimple(provider.getModel(), { messages: [] });
    assert.equal(provider.state.callCount, 1);
    const ledger = await owner.snapshot(DailyModelCost, BACKGROUND_CONTEXT);
    assert.ok(ledger?.days[new Date().toISOString().slice(0, 10)] !== undefined);
    const tighter = boundedModels(models, { ...DEFAULT_LIMITS, modelOutputTokens: 10, modelRetries: 0, dailyCostUsd: quote / 2 }, undefined, () => owner);
    await assert.rejects(tighter.completeSimple(provider.getModel(), { messages: [] }), /cost budget exhausted/);
    assert.equal(provider.state.callCount, 1);
  } finally { await owner.close(BACKGROUND_CONTEXT); }
});

test("model boundary clamps output, request timeout and provider retry on every path", () => {
  const observed: unknown[] = [];
  const source = {
    streamSimple(_model: unknown, _context: unknown, options: unknown) { observed.push(options); return "simple"; },
    stream(_model: unknown, _context: unknown, options: unknown) { observed.push(options); return "full"; },
    getModel() { return this; },
  } as unknown as Models;
  const guarded = boundedModels(source, { ...DEFAULT_LIMITS, modelOutputTokens: 12, runTimeoutMs: 300, modelRetries: 1 });
  assert.equal(guarded.getModel("faux", "faux-1"), source);
  assert.equal(guarded.streamSimple({} as never, { messages: [] }, { maxTokens: 999, timeoutMs: 9999, maxRetries: 5 }), "simple");
  assert.equal(guarded.stream({} as never, { messages: [] }, { maxTokens: 2, timeoutMs: 50, maxRetries: 0 }), "full");
  assert.equal(guarded.streamSimple({} as never, { messages: [] }), "simple");
  assert.deepEqual(observed, [
    { maxTokens: 12, timeoutMs: 300, maxRetries: 1 },
    { maxTokens: 2, timeoutMs: 50, maxRetries: 0 },
    { maxTokens: 12, timeoutMs: 300, maxRetries: 1 },
  ]);
});
