// The assistant's durable capability surface: todo + memory tools and the bounded
// memory prompt section. Installing this extension is what satisfies the runtime's
// REQUIRED_TOOLS guard, so the standalone entry never falls back to a global pi
// tool or plugin.
import { defineExtension } from "@earendil-works/pi-durable";
import { memoryTools } from "./tools/memory.ts";
import { todoTools } from "./tools/todo.ts";
import { workspaceTools } from "./tools/workspace.ts";
import type { WorkspacePolicy } from "./workspace.ts";
import { reminderTools } from "./tools/reminders.ts";
import { taskTools } from "./tasks.ts";
import { mediaTools } from "./tools/media.ts";
import { shellTools } from "./tools/shell.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { memorySection } from "./memory-prompt.ts";
import { DEFAULT_LIMITS, type WechatLimits } from "./config.ts";
import { modelAdmissionHook } from "./run-admission.ts";
import { RequestMarkerGate } from "./request-gate.ts";

export type AssistantExtensionOptions = {
  readonly memoryPromptBytes: number;
  readonly limits?: Pick<WechatLimits, "runTimeoutMs" | "runModelRequests" | "dailyCostUsd" | "modelOutputTokens" | "modelRetries">;
  readonly gate?: RequestMarkerGate;
  readonly workspace: WorkspacePolicy;
  readonly harness: Harness | (() => Harness);
  readonly boundUserId: string;
  readonly mediaRoot?: string;
  readonly shellEnabled?: boolean;
};

export const assistantExtension = (options: AssistantExtensionOptions) => {
  // The registry is frozen before Harness.open. Defer the owner reference until
  // a tool actually executes; never open a second Harness or database handle.
  const owner = new Proxy({} as Harness, {
    get(_target, property) {
      const harness = typeof options.harness === "function" ? options.harness() : options.harness;
      const value = Reflect.get(harness, property, harness);
      return typeof value === "function" ? value.bind(harness) : value;
    },
  });
  return defineExtension({
    name: "wechat-assistant",
    tools: [...todoTools, ...memoryTools,
      ...workspaceTools(options.workspace),
      ...mediaTools(options.mediaRoot ?? options.workspace.root, { harness: owner, recipient: options.boundUserId, workspace: options.workspace }),
      ...shellTools(owner, options.workspace, options.shellEnabled === true),
      ...reminderTools(owner, options.boundUserId),
      ...taskTools(owner, BACKGROUND_CONTEXT)],
    sections: [memorySection(options.memoryPromptBytes)],
    hooks: [modelAdmissionHook(owner, options.limits ?? DEFAULT_LIMITS, options.gate)],
  });
};
