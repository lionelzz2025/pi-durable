import type { RegistryReader } from "@earendil-works/pi-durable";

export const REQUIRED_TOOLS = Object.freeze([
  "todo_create", "todo_list", "todo_get", "todo_complete",
  "memory_add", "memory_search", "memory_correct", "memory_forget",
  "workspace_read", "workspace_write", "workspace_edit",
  "media_send_file", "media_delivery_status", "shell_request_approval", "shell_execute_approved",
  "reminder_create", "reminder_cancel", "reminder_list", "reminder_dispatch",
  "task_list", "task_get", "task_cancel", "task_resume",
]);

/** Fail closed before resume, poll, or model invocation; no global-tool fallback. */
export const requireAssistantCapabilities = (registry: RegistryReader): void => {
  const names = registry.snapshot().tools().map(({ tool }) => tool.name);
  for (const required of REQUIRED_TOOLS) {
    if (names.filter((name) => name === required).length !== 1) {
      throw new Error(`Required assistant capability missing or ambiguous: ${required}`);
    }
  }
};
