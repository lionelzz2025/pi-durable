import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { Outbox } from "./outbox.ts";
import { ChannelState } from "./documents.ts";

export type ReminderRecord = { id: string; conversationId: number; recipient: string; dueAt: number; timezone: string; occurrenceId: string; text: string; state: "pending" | "dispatched" | "cancelled" | "blocked"; outboxKey: string | null };
export const Reminders = defineDoc<{ records: ReminderRecord[] }>({ kind: "wechat.reminders", version: 1, scope: "session", initial: () => ({ records: [] }) });
const validZone = (value: string) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } };
export const createReminder = async (harness: Harness, input: Omit<ReminderRecord, "state" | "outboxKey">): Promise<void> => {
  if (!input.id || !input.occurrenceId || !Number.isSafeInteger(input.dueAt) || !validZone(input.timezone) || !input.text.trim() || Buffer.byteLength(input.text) > 2048) throw Error("Invalid reminder");
  await harness.commit(async (tx) => {
    const doc = await tx.doc(Reminders);
    if (doc.records.some((item) => item.id === input.id || item.occurrenceId === input.occurrenceId)) throw Error("Reminder or occurrence already exists");
    if (doc.records.length >= 1000) throw Error("Reminder capacity reached");
    doc.records.push({ ...input, state: "pending", outboxKey: null });
  }, BACKGROUND_CONTEXT);
};
export const cancelReminder = async (harness: Harness, id: string): Promise<boolean> => harness.commit(async (tx) => {
  const record = (await tx.doc(Reminders)).records.find((item) => item.id === id);
  if (!record || record.state !== "pending") return false;
  record.state = "cancelled"; return true;
}, BACKGROUND_CONTEXT);

/** Atomically claims each due occurrence and creates its durable outbox item. */
export const dispatchDueReminders = async (harness: Harness, options: { now?: number; limit?: number }): Promise<number> => {
  const now = options.now ?? Date.now(); const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error("Invalid reminder dispatch limit");
  return harness.commit(async (tx) => {
    const reminders = await tx.doc(Reminders); const outbox = await tx.doc(Outbox);
    const channel = await tx.doc(ChannelState);
    let dispatched = 0;
    for (const reminder of reminders.records) {
      if (dispatched >= limit) break;
      if (reminder.state !== "pending" || reminder.dueAt > now) continue;
      const key = `reminder:${reminder.occurrenceId}`;
      if (!outbox.records.some((item) => item.key === key)) {
        if (outbox.records.length >= 1000) { reminder.state = "blocked"; continue; }
        const text = `[提醒；原定 ${new Date(reminder.dueAt).toISOString()} (${reminder.timezone})]\n${reminder.text}`;
        outbox.records.push({ key, conversationId: reminder.conversationId, answerEntryId: 0, recipient: reminder.recipient,
          payloadHash: key, chunks: [text], clientIds: [key], chunkIndex: 0, attempts: 0, nextAttemptAt: 0, lastError: "",
          status: channel.contextToken && channel.userId === reminder.recipient ? "pending" : "blocked", createdAt: now, updatedAt: now });
      }
      reminder.state = channel.contextToken && channel.userId === reminder.recipient ? "dispatched" : "blocked";
      reminder.outboxKey = key; dispatched++;
    }
    return dispatched;
  }, BACKGROUND_CONTEXT);
};
export const listReminders = async (harness: Harness) => (await harness.snapshot(Reminders, BACKGROUND_CONTEXT))?.records ?? [];

/** Resynchronize reminder state from durable outbox receipts after a send or restart. */
export const reconcileReminders = async (harness: Harness): Promise<number> => harness.commit(async (tx) => {
  const reminders = await tx.doc(Reminders);
  const outbox = await tx.doc(Outbox);
  let changed = 0;
  for (const reminder of reminders.records) {
    if (!reminder.outboxKey) continue;
    const receipt = outbox.records.find((item) => item.key === reminder.outboxKey);
    if (!receipt) continue;
    const expected = receipt.status === "blocked" || receipt.status === "outcome_unknown" ? "blocked" : "dispatched";
    if (reminder.state !== expected) { reminder.state = expected; changed++; }
  }
  return changed;
}, BACKGROUND_CONTEXT);
