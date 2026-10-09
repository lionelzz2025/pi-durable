// Durable todo tools. They reuse the assistant todo/receipt document families and
// the shared normalizers, but run inside a Harness task instead of the legacy HTTP
// service. Every mutation is one `commit`: the todo change and its idempotency
// receipt are written together, or neither is. Replay uses the same receipt keyed
// by `api.callId`, so a recovered safe tool never creates a second todo.
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool, type Tx } from "@earendil-works/pi-durable";
import {
  ASSISTANT_LIMITS,
  ReceiptDoc,
  TodoDoc,
  normalizeOperationId,
  normalizePageSize,
  normalizeStatusFilter,
  normalizeTitle,
  normalizeTodoId,
  toTodo,
  type ReceiptRecord,
  type Todo,
} from "../../assistant/store.ts";

/** Creation-order index. DocumentReader exposes only point reads, so listing needs
 * an id list; it is capped and append-only, and rebuilt by migration. */
export const TodoIndex = defineDoc<{ ids: string[] }>({
  kind: "assistant.todo-index",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
});

/** Index capacity. Reaching it blocks new todos instead of dropping history. */
export const TODO_INDEX_CAP = 5000;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const fingerprintOf = (kind: "create" | "complete", subject: string) => `${kind}\n${subject}`;
const nowIso = () => new Date().toISOString();

const normalizeOffset = (raw: unknown): number => {
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw !== "string" || !/^[0-9]{1,7}$/.test(raw)) throw new Error("cursor must be a numeric offset");
  return Number(raw);
};

/** Request fields are `unknown`: they arrive from a model and are never trusted. */
type CreateArgs = { title?: unknown; operationId?: unknown };
type ListArgs = { status?: unknown; limit?: unknown; cursor?: unknown };
type GetArgs = { id?: unknown };
type CompleteArgs = { id?: unknown; operationId?: unknown };

const createParams = Type.Object({
  title: Type.String({ description: "Todo title", minLength: 1, maxLength: ASSISTANT_LIMITS.titleMaxChars }),
  operationId: Type.Optional(Type.String({ description: "Idempotency key; defaults to the tool call id" })),
});
const listParams = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done"), Type.Literal("all")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ASSISTANT_LIMITS.maxPageSize })),
  cursor: Type.Optional(Type.String({ description: "Opaque offset returned as nextCursor" })),
});
const getParams = Type.Object({ id: Type.String({ description: "Todo UUID" }) });
const completeParams = Type.Object({
  id: Type.String({ description: "Todo UUID" }),
  operationId: Type.Optional(Type.String({ description: "Idempotency key; defaults to the tool call id" })),
});

const readReceipt = async (tx: Tx, operationId: string, fingerprint: string, kind: string, seed: ReceiptRecord) => {
  const receipt = await tx.doc(ReceiptDoc, operationId, seed);
  if (receipt.requestKind !== kind || receipt.fingerprint !== fingerprint) {
    throw new Error(`operationId ${operationId} was already used for a different request`);
  }
  return receipt;
};

export const todoCreate = defineTool({
  name: "todo_create",
  description: "Create a todo. Safe to retry: the same operationId never creates two todos.",
  parameters: createParams,
  replay: "safe",
  executionMode: "sequential",
  execute: async (args, api, context) => {
    const typed = args as CreateArgs;
    const operationId = normalizeOperationId(typed.operationId ?? api.callId);
    const title = normalizeTitle(typed.title);
    const fingerprint = fingerprintOf("create", title);
    const id = randomUUID();
    const createdAt = nowIso();
    const seed: ReceiptRecord = {
      operationId,
      fingerprint,
      requestKind: "create",
      todo: { id, title, status: "open", createdAt, completedAt: null },
    };
    const todo = await api.commit(async (tx) => {
      const receipt = await readReceipt(tx, operationId, fingerprint, "create", seed);
      // A freshly generated id proves this receipt was just seeded, so the todo and
      // index entry still have to be written. On replay the recorded id wins.
      const fresh = receipt.todo.id === id;
      if (fresh) {
        const index = await tx.doc(TodoIndex);
        if (index.ids.length >= TODO_INDEX_CAP) throw new Error("Todo capacity reached");
        index.ids.push(receipt.todo.id);
      }
      const stored = await tx.doc(TodoDoc, receipt.todo.id, {
        id: receipt.todo.id,
        title: receipt.todo.title,
        createdAt: receipt.todo.createdAt,
      });
      return toTodo({ ...stored });
    }, context);
    return text(JSON.stringify(todo));
  },
});

export const todoList = defineTool({
  name: "todo_list",
  description: "List todos in creation order, oldest first, with an optional status filter.",
  parameters: listParams,
  replay: "safe",
  execute: async (args, api, context) => {
    const typed = args as ListArgs;
    const status = normalizeStatusFilter(typed.status);
    const limit = normalizePageSize(typed.limit);
    const offset = normalizeOffset(typed.cursor);
    const index = await api.snapshot(TodoIndex, context);
    const ids = index?.ids ?? [];
    const items: Todo[] = [];
    let nextCursor: string | null = null;
    for (let position = offset; position < ids.length; position += 1) {
      const record = await api.snapshot(TodoDoc, ids[position]!, context);
      if (!record) continue;
      if (status !== "all" && record.status !== status) continue;
      if (items.length === limit) {
        nextCursor = String(position);
        break;
      }
      items.push(toTodo(record));
    }
    return text(JSON.stringify({ items, nextCursor }));
  },
});

export const todoGet = defineTool({
  name: "todo_get",
  description: "Read one todo by id.",
  parameters: getParams,
  replay: "safe",
  execute: async (args, api, context) => {
    const id = normalizeTodoId((args as GetArgs).id);
    const record = await api.snapshot(TodoDoc, id, context);
    if (!record) throw new Error(`no todo with id ${id}`);
    return text(JSON.stringify(toTodo(record)));
  },
});

export const todoComplete = defineTool({
  name: "todo_complete",
  description: "Mark a todo done. Safe to retry: completing twice is one effect.",
  parameters: completeParams,
  replay: "safe",
  executionMode: "sequential",
  execute: async (args, api, context) => {
    const typed = args as CompleteArgs;
    const id = normalizeTodoId(typed.id);
    const operationId = normalizeOperationId(typed.operationId ?? api.callId);
    const fingerprint = fingerprintOf("complete", id);
    // Read before the commit so a missing todo is never created by a seed.
    const existing = await api.snapshot(TodoDoc, id, context);
    if (!existing) throw new Error(`no todo with id ${id}`);
    const completedAt = nowIso();
    const seed: ReceiptRecord = {
      operationId,
      fingerprint,
      requestKind: "complete",
      todo: { ...existing, status: "done", completedAt: existing.completedAt ?? completedAt },
    };
    const todo = await api.commit(async (tx) => {
      const receipt = await readReceipt(tx, operationId, fingerprint, "complete", seed);
      const stored = await tx.doc(TodoDoc, id, { id, title: existing.title, createdAt: existing.createdAt });
      if (stored.status !== "done") {
        stored.status = "done";
        stored.completedAt = completedAt;
      }
      return toTodo({ ...stored });
    }, context);
    return text(JSON.stringify(todo));
  },
});

export const todoTools = [todoCreate, todoList, todoGet, todoComplete];
