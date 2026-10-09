import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { REQUIRED_TOOLS, requireAssistantCapabilities } from "../../src/wechat-assistant/capabilities.ts";
const tool = (name: string) => defineTool({ name, description: "fixture", parameters: Type.Object({}), replay: "safe", execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }) });
test("capability guard rejects missing tools and accepts the explicit complete registry", () => {
  const registry = createRegistry();
  assert.throws(() => requireAssistantCapabilities(registry), /todo_create/);
  registry.install(defineExtension({ name: "fixture", tools: REQUIRED_TOOLS.map(tool) }));
  assert.doesNotThrow(() => requireAssistantCapabilities(registry));
  registry.install(defineExtension({ name: "duplicate", tools: [tool("memory_add")] }));
  assert.throws(() => requireAssistantCapabilities(registry), /memory_add/);
});
