import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Harness } from "@earendil-works/pi-durable";
import { cancelReminder, createReminder, dispatchDueReminders, listReminders } from "../reminders.ts";
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
export const reminderTools = (harness: Harness, boundUserId: string) => [
  defineTool({ name: "reminder_create", description: "Create a durable local reminder using an ISO instant and IANA timezone.", parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), dueAt: Type.Integer({ minimum: 0 }), timezone: Type.String({ minLength: 1, maxLength: 128 }), occurrenceId: Type.String({ minLength: 1, maxLength: 128 }), text: Type.String({ minLength: 1, maxLength: 2000 }) }), replay: "unsafe", execute: async (raw, api) => {
    const args = raw as { id: string; dueAt: number; timezone: string; occurrenceId: string; text: string };
    await createReminder(harness, { ...args, conversationId: api.conversationId, recipient: boundUserId });
    return text("Reminder scheduled");
  } }),
  defineTool({ name: "reminder_cancel", description: "Cancel a pending reminder by id.", parameters: Type.Object({ id: Type.String() }), replay: "safe", execute: async (raw) => text(String(await cancelReminder(harness, (raw as { id: string }).id))) }),
  defineTool({ name: "reminder_list", description: "List persisted reminders.", parameters: Type.Object({}), replay: "safe", execute: async () => text(JSON.stringify(await listReminders(harness))) }),
  defineTool({ name: "reminder_dispatch", description: "Persist all currently due reminder occurrences to the outbox without claiming delivery.", parameters: Type.Object({}), replay: "safe", execute: async () => text(JSON.stringify({ enqueued: await dispatchDueReminders(harness, {}) })) }),
];
