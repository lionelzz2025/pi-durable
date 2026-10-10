import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, configure, defineDoc, type ConversationId, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { ChannelState } from "./documents.ts";
import { retryOutbox } from "./outbox.ts";

export type Control = "status" | "cancel" | "new" | "compact" | "retry" | "tasks" | "reminders";
export const parseControl = (text: string): Control | undefined => {
  const commands: Record<string, Control> = { "/status": "status", "/cancel": "cancel", "/new": "new", "/compact": "compact", "/retry": "retry", "/tasks": "tasks", "/reminders": "reminders" };
  return Object.hasOwn(commands, text.trim()) ? commands[text.trim()] : undefined;
};
type Receipt = { command: Control; conversationId: ConversationId; state: "pending" | "running" | "complete" | "needs_review"; result: string; taskId: TaskId | null };
export const ControlReceipts = defineDoc<{ records: Record<string, Receipt> }>({
  kind: "wechat.controls", version: 1, scope: "session", initial: () => ({ records: {} }),
});

/** Owner-serialized control execution. Caller must authenticate and pass the
 * persistent inbox key, not generate an ID for each retry. No freeform model
 * interpretation. Results remain durable until the outbox is implemented. */
export const executeControl = async (harness: Harness, key: string, command: Control, targetId?: ConversationId): Promise<string> => {
  if (!key) throw Error("Control requires a stable inbox key");
  let receipt = await harness.commit(async (tx) => {
    const channel = await tx.doc(ChannelState);
    if (channel.conversationId === null) throw Error("No bound conversation");
    const controls = await tx.doc(ControlReceipts);
    const previous = controls.records[key];
    if (previous) {
      if (previous.command !== command) throw Error("Control identity conflict");
      return { ...previous };
    }
    if (Object.keys(controls.records).length >= 10000) throw Error("Control receipt capacity reached");
    let id = targetId ?? channel.conversationId;
    let result = "";
    if (command === "new") {
      // Creation, mapping and receipt share a transaction: no duplicate orphan
      // conversation if the process dies before returning to the caller.
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      const priorAgent = await tx.doc(AgentDoc, id);
      await configure(tx, created.id, JSON.parse(JSON.stringify(priorAgent)));
      id = created.id;
      channel.conversationId = id;
      result = `New conversation ${id}`;
    }
    const value: Receipt = { command, conversationId: id, state: command === "new" ? "complete" : "pending", result, taskId: null };
    controls.records[key] = value;
    return { ...value };
  }, context);
  if (receipt.state === "complete" || receipt.state === "needs_review") return receipt.result;
  const conversation = await harness.conversation(receipt.conversationId, context);
  if (!conversation) throw Error("Control conversation missing");
  // Public compact() cannot atomically pair task admission with our receipt.
  // Do not blindly repeat after the admission -> receipt crash window.
  if (receipt.state === "running") {
    receipt = { ...receipt, state: "needs_review", result: "Control outcome unknown; inspect tasks before issuing a new command" };
  } else if (receipt.command === "compact") {
    await harness.commit(async (tx) => { (await tx.doc(ControlReceipts)).records[key]!.state = "running"; }, context);
    const taskId = await conversation.compact(undefined, context);
    receipt = { ...receipt, state: "complete", taskId, result: `Compaction admitted as task ${taskId}; not yet completed` };
  } else if (receipt.command === "retry") {
    await harness.commit(async (tx) => { (await tx.doc(ControlReceipts)).records[key]!.state = "running"; }, context);
    const count = await retryOutbox(harness);
    receipt = { ...receipt, state: "complete", result: `Manual retry queued ${count} outbox record(s)` };
  } else if (receipt.command === "cancel") {
    await harness.commit(async (tx) => { (await tx.doc(ControlReceipts)).records[key]!.state = "running"; }, context);
    await conversation.abort(context);
    receipt = { ...receipt, state: "complete", result: `Cancellation completed for conversation ${receipt.conversationId}` };
  } else {
    const inspection = await harness.inspect(context);
    if (receipt.command === "tasks") {
      receipt = { ...receipt, state: "complete", result: JSON.stringify(inspection.tasks.map((task) => ({ id: task.record.id, kind: task.record.kind, status: task.record.state.status }))) };
    } else if (receipt.command === "reminders") {
      const reminders = await import("./reminders.ts");
      receipt = { ...receipt, state: "complete", result: JSON.stringify(await reminders.listReminders(harness)) };
    } else {
      receipt = { ...receipt, state: "complete", result: JSON.stringify({ conversationId: receipt.conversationId, liveTasks: inspection.tasks.length, unsettledSubmissions: inspection.submissions.length }) };
    }
  }
  await harness.commit(async (tx) => { (await tx.doc(ControlReceipts)).records[key] = receipt; }, context);
  return receipt.result;
};
