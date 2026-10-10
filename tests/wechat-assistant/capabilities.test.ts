import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { REQUIRED_TOOLS, requireAssistantCapabilities } from "../../src/wechat-assistant/capabilities.ts";
import { assistantExtension } from "../../src/wechat-assistant/extension.ts";
const tool = (name: string) => defineTool({ name, description: "fixture", parameters: Type.Object({}), replay: "safe", execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) });
test("capability guard rejects missing tools and accepts the explicit complete registry", () => {
  const registry = createRegistry();
  assert.throws(() => requireAssistantCapabilities(registry), /todo_create/);
  registry.install(defineExtension({ name: "fixture", tools: REQUIRED_TOOLS.map(tool) }));
  assert.doesNotThrow(() => requireAssistantCapabilities(registry));
  registry.install(defineExtension({ name: "duplicate", tools: [tool("memory_add")] }));
  assert.throws(() => requireAssistantCapabilities(registry), /memory_add/);
});
test("the built-in assistant extension alone satisfies the capability guard", () => {
  const registry = createRegistry();
  const harness = { commit: async () => undefined, snapshot: async () => undefined } as never;
  registry.install(assistantExtension({ memoryPromptBytes: 8192, workspace: { root: process.cwd(), maxBytes: 1024 * 1024 }, harness, boundUserId: "user", shellEnabled: false }));
  assert.doesNotThrow(() => requireAssistantCapabilities(registry));
  const names = registry.snapshot().tools().map(({ tool: item }) => item.name);
  assert.deepEqual([...names].sort(), [...REQUIRED_TOOLS].sort());
  assert.equal(registry.snapshot().sections().length, 1);
});
