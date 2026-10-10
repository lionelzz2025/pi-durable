import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
export const parseTaskId = (raw: string): TaskId => {
  if (!/^[1-9][0-9]*$/.test(raw)) throw Error("Invalid task id");
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1) throw Error("Invalid task id");
  return number as TaskId;
};
export const taskTools = (harness: Harness, context: Context) => [
  defineTool({ name: "task_list", description: "List current durable tasks and their state.", parameters: Type.Object({}), replay: "safe", execute: async () => {
    const tasks = (await harness.inspect(context)).tasks;
    return text(JSON.stringify(tasks.map((task) => ({ id: task.record.id, kind: task.record.kind, status: task.record.state.status }))));
  } }),
  defineTool({ name: "task_get", description: "Query a durable task receipt by numeric id, including terminal state.", parameters: Type.Object({ taskId: Type.String() }), replay: "safe", execute: async (args) => {
    const task = await harness.getTask(parseTaskId((args as { taskId: string }).taskId), context);
    return text(task ? JSON.stringify({ id: task.id, kind: task.kind, state: task.state }) : "Task not found");
  } }),
  defineTool({ name: "task_cancel", description: "Cancel one durable task by its id.", parameters: Type.Object({ taskId: Type.String() }), replay: "unsafe", execute: async (args) => text(await harness.abortTask(parseTaskId((args as { taskId: string }).taskId), context)) }),
  defineTool({ name: "task_resume", description: "Resume the durable scheduler after recovery.", parameters: Type.Object({}), replay: "safe", execute: async () => { harness.resume(); return text("Durable scheduler resumed"); } }),
];
