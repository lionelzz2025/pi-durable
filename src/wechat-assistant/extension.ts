// The assistant's durable capability surface: todo + memory tools and the bounded
// memory prompt section. Installing this extension is what satisfies the runtime's
// REQUIRED_TOOLS guard, so the standalone entry never falls back to a global pi
// tool or plugin.
import { defineExtension } from "@earendil-works/pi-durable";
import { memoryTools } from "./tools/memory.ts";
import { todoTools } from "./tools/todo.ts";
import { memorySection } from "./memory-prompt.ts";

export type AssistantExtensionOptions = {
  readonly memoryPromptBytes: number;
};

export const assistantExtension = (options: AssistantExtensionOptions) =>
  defineExtension({
    name: "wechat-assistant",
    tools: [...todoTools, ...memoryTools],
    sections: [memorySection(options.memoryPromptBytes)],
  });
